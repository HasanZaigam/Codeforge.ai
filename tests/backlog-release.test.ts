import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { Worker } from "../src/worker/worker.js";
import { InvalidTransitionError } from "../src/domain/task-state-machine.js";
import type { Project } from "../src/domain/types.js";

/**
 * Dedicated coverage for the BACKLOG -> TODO human release gate introduced
 * alongside this milestone (see /docs/TASK_LIFECYCLE.md "Task lifecycle").
 * Uses the same low-level platform/worker harness pattern as
 * orchestrator.test.ts / worker.test.ts.
 */
async function setup(label: string) {
  const root = await mkdtemp(join(tmpdir(), `backlog-test-${label}-`));
  const engine = createSelfFixDemoEngine();
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `backlog-test-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: `${label}@example.com`, name: "Tester", passwordHash: "", createdAt: now };
  platform.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  return { platform, project };
}

function makeTask(platform: Platform, project: Project, title = "Fix add()") {
  return createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title,
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

test("1. a newly created task starts in BACKLOG, not TODO", async () => {
  const { platform, project } = await setup("create");
  const task = makeTask(platform, project);
  assert.equal(task.status, "BACKLOG");
  assert.equal(platform.tasks.findById(task.id)?.status, "BACKLOG");
});

test("2. the worker's poll/claim logic never claims a BACKLOG task", async () => {
  const { platform, project } = await setup("worker-skip");
  const task = makeTask(platform, project);
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });

  await worker.tick();
  await worker.tick(); // a second tick, in case the first were somehow a warm-up

  assert.equal(platform.tasks.findById(task.id)?.status, "BACKLOG", "the worker must never claim/execute a BACKLOG task");
  const events = platform.taskEvents.listForTask(task.id);
  assert.ok(!events.some((e) => e.type === "TASK_CLAIMED"), "no claim event may ever be recorded for a task still in BACKLOG");
});

test("3. Orchestrator.startTask transitions BACKLOG -> TODO correctly", async () => {
  const { platform, project } = await setup("start");
  const task = makeTask(platform, project);

  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
  assert.equal(platform.tasks.findById(task.id)?.status, "TODO");

  const events = platform.taskEvents.listForTask(task.id);
  assert.ok(events.some((e) => e.type === "TASK_RELEASED"), "a TASK_RELEASED event must be recorded");
});

test("4. starting a task twice: the second attempt is rejected with InvalidTransitionError, not a silent no-op", async () => {
  const { platform, project } = await setup("double-start");
  const task = makeTask(platform, project);

  platform.orchestrator.startTask(task.id);
  assert.throws(() => platform.orchestrator.startTask(task.id), InvalidTransitionError);
  // Still TODO — the rejected second call must not have changed anything.
  assert.equal(platform.tasks.findById(task.id)?.status, "TODO");
});

test("5. the start action rejects a task that is not in BACKLOG (already TODO, WORKING, or DONE)", async () => {
  const { platform, project } = await setup("wrong-state");

  const alreadyTodo = makeTask(platform, project, "Already TODO");
  platform.orchestrator.startTask(alreadyTodo.id);
  assert.throws(() => platform.orchestrator.startTask(alreadyTodo.id), InvalidTransitionError);

  const willBeDone = makeTask(platform, project, "Will finish");
  platform.orchestrator.startTask(willBeDone.id);
  await platform.orchestrator.executeTask(willBeDone.id);
  const done = platform.orchestrator.acceptReview(willBeDone.id);
  assert.equal(done.status, "DONE");
  assert.throws(() => platform.orchestrator.startTask(willBeDone.id), InvalidTransitionError);
});

test("6. after BACKLOG -> TODO, the worker claims and executes the task exactly as before (real orchestrator/worker run)", async () => {
  const { platform, project } = await setup("full-run");
  const task = makeTask(platform, project);
  platform.orchestrator.startTask(task.id);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  await worker.tick();

  const finished = platform.tasks.findById(task.id)!;
  assert.equal(finished.status, "REVIEW", "a released task must be driven through WORKING to REVIEW exactly like before this milestone");
  assert.ok(finished.taskRecord.branchName, "execution must have actually run (a branch was created)");
});

test("a BACKLOG task can be cancelled directly (nothing is running yet — same 'immediate finalize' shape as cancelling TODO)", async () => {
  const { platform, project } = await setup("cancel-backlog");
  const task = makeTask(platform, project);

  const cancelled = await platform.orchestrator.requestCancellation(task.id, "some-user");
  assert.equal(cancelled.status, "CANCELLED");

  // Starting a cancelled task must still be rejected — cancellation is terminal.
  assert.throws(() => platform.orchestrator.startTask(task.id), InvalidTransitionError);
});
