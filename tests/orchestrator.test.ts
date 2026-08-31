import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine, createNeedsInputDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import type { Project, StepResult } from "../src/domain/types.js";

async function setupPlatform(label: string, engine: ReturnType<typeof createSelfFixDemoEngine>, orchestratorConfig?: Partial<import("../src/orchestrator/config.js").OrchestratorConfig>) {
  const root = await mkdtemp(join(tmpdir(), `orch-test-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    orchestratorConfig,
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
  return { platform, project, user, root };
}

test("happy path: self-fix loop reaches REVIEW after one retry", async () => {
  const { platform, project } = await setupPlatform("happy", createSelfFixDemoEngine());
  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("RETRY_STARTED"), "expected the self-fix loop to have retried at least once");
  assert.ok(events.includes("TASK_MOVED_TO_REVIEW"));

  const runs = platform.agentRuns.listForTask(task.id);
  assert.equal(runs.filter((r) => r.role === "implementer").length, 2, "one failing attempt + one fixing attempt");
  assert.equal(runs.filter((r) => r.role === "reviewer").length, 1);
});

test("implementer-signaled ambiguity raises NEEDS_INPUT with non-trivial evidence, then resumes to REVIEW", async () => {
  const { platform, project, user } = await setupPlatform("needs-input", createNeedsInputDemoEngine());
  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  const afterFirstRun = await platform.orchestrator.executeTask(task.id);
  assert.equal(afterFirstRun.status, "NEEDS_INPUT");

  const request = platform.humanInput.findOpenForTask(task.id);
  assert.ok(request);
  assert.ok(request!.discovered.length > 0);
  assert.ok(request!.attempted.length > 0);
  assert.ok(request!.blocker.length > 0);
  assert.ok(request!.question.length > 0);

  const resumed = platform.orchestrator.submitHumanAnswer(
    task.id,
    { selectedOption: "Fix add() to return a + b", freeText: "Fix add() to return a + b" },
    user.id,
  );
  assert.equal(resumed.status, "WORKING");

  const final = await platform.orchestrator.executeTask(task.id);
  assert.equal(final.status, "REVIEW");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("NEEDS_INPUT_RAISED"));
  assert.ok(events.includes("NEEDS_INPUT_ANSWERED"));
});

test("self-fix budget exhaustion (never fixes, no explicit needs_input signal) escalates to NEEDS_INPUT with failure evidence", async () => {
  const neverFixEngine = new FixtureCodingEngine(
    {
      implementer: () => {
        const result: StepResult = {
          status: "completed",
          summary: "Attempted a fix.",
          filesChanged: [],
          diffRef: null,
          confidence: "low",
          findings: [],
          needsInput: null,
        };
        return { result, cost: null, logExcerpt: "" };
      },
    },
    "never-fix",
  );

  const { platform, project } = await setupPlatform("exhaust", neverFixEngine, { maxSelfFixAttempts: 2 });
  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "NEEDS_INPUT");

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 2, "should stop exactly at the configured attempt budget");

  const request = platform.humanInput.findOpenForTask(task.id);
  assert.ok(request?.blocker.includes("attempt limit"));
});

test("a claimed WORKING task is not re-executed by a second concurrent executeTask() call", async () => {
  const { platform, project } = await setupPlatform("concurrency", createSelfFixDemoEngine());
  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  // Simulate a second worker instance racing on the same task id.
  const secondOwnerClaimed = platform.tasks.claimTodo(task.id, "rogue-worker", 60_000, new Date().toISOString());
  const result = await platform.orchestrator.executeTask(task.id);

  // Either the rogue claim or the orchestrator's own claim wins, never both —
  // and whichever loses must not have mutated the task.
  if (secondOwnerClaimed) {
    assert.equal(result.status, "WORKING", "orchestrator's own claim must have been rejected");
  } else {
    assert.equal(result.status, "REVIEW");
  }
});

test("recoverOrphanedTasks finds a task whose lease expired mid-execution and lets it be re-claimed", async () => {
  const { platform, project } = await setupPlatform("recovery", createSelfFixDemoEngine(), { taskLeaseMs: 50 });
  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  // Simulate a crash: claim the lease directly (bypassing executeTask) and let it expire.
  const t0 = new Date().toISOString();
  platform.tasks.claimTodo(task.id, "crashed-worker", 1, t0);
  await new Promise((r) => setTimeout(r, 10));

  const orphaned = platform.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
});
