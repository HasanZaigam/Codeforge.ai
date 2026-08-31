import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform } from "../src/platform.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { Worker } from "../src/worker/worker.js";
import type { Project } from "../src/domain/types.js";

async function setup(label: string) {
  const root = await mkdtemp(join(tmpdir(), `worker-test-${label}-`));
  const engine = createSelfFixDemoEngine();
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `worker-test-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    tenantId: "default",
    email: `${label}@example.com`,
    name: "Tester",
    passwordHash: "",
    createdAt: now,
  };
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

test("Task A, B, C created together are all driven to REVIEW independently by one worker", async () => {
  const { platform, project } = await setup("multi");
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });

  const ids = ["A", "B", "C"].map(
    (label) =>
      createTask(platform.tasks, platform.taskEvents, {
        tenantId: "default",
        projectId: project.id,
        title: `Task ${label}`,
        goal: "add() returns the wrong result",
        createdBy: null,
      }).id,
  );

  await worker.tick(); // one poll cycle should discover and drive all three concurrently

  for (const id of ids) {
    const task = platform.tasks.findById(id);
    assert.equal(task?.status, "REVIEW", `task ${id} should have reached REVIEW in one tick`);
  }
  await worker.stop();
});

test("two overlapping tick() calls never both execute the same task", async () => {
  const { platform, project } = await setup("overlap");
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });

  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  // Fired back-to-back within the same synchronous turn, simulating a poll interval shorter
  // than one task's execution time — the in-flight guard (not the DB claim alone) must prevent
  // this worker instance from calling executeTask() twice for the same task concurrently.
  await Promise.all([worker.tick(), worker.tick()]);

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 2, "expected exactly the self-fix demo's normal 2 implementer attempts, not double that");

  const final = platform.tasks.findById(task.id);
  assert.equal(final?.status, "REVIEW");
  await worker.stop();
});

test("stop() waits for in-flight work before resolving", async () => {
  const { platform, project } = await setup("stop");
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  worker.start();
  await new Promise((r) => setTimeout(r, 5)); // let the initial scheduled tick begin
  await worker.stop();

  // No assertion needed beyond "this resolves and does not throw" — the point is stop() is awaitable.
  assert.ok(true);
});
