import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine, createNeedsInputDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { FakeSourceControlProvider } from "./helpers/fake-source-control-provider.js";
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
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
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
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
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
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
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
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
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
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
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

// ---------------------------------------------------------------------------
// Zero-change detection (see /docs/TASK_LIFECYCLE.md "Zero-change detection"):
// an implementer that correctly decides no file should be changed must never
// reach commitAll/push/openPullRequest — verified here against a
// FakeSourceControlProvider's own call log, the same pattern used elsewhere
// in this suite (github-source-control.test.ts, human-review-feedback.test.ts).
// ---------------------------------------------------------------------------

async function setupPlatformWithFakeSourceControl(label: string, engine: FixtureCodingEngine) {
  const root = await mkdtemp(join(tmpdir(), `orch-test-${label}-`));
  const scProvider = new FakeSourceControlProvider("local-git");
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    additionalSourceControlProviders: [scProvider],
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
    // No declared commands: validation trivially "passes" with zero checks, regardless of
    // add.js's content — isolates this test from the fixture repo's own (unrelated) bug/test.
    commands: null,
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  return { platform, project, user, scProvider };
}

const zeroChangeEngine = new FixtureCodingEngine(
  {
    implementer: () => {
      const result: StepResult = {
        status: "completed",
        summary: "Investigated the task; the target already exists and the task forbids modifying existing files, so no change was made.",
        filesChanged: [],
        diffRef: null,
        confidence: "high",
        findings: [],
        needsInput: null,
      };
      return { result, cost: null, logExcerpt: "" };
    },
  },
  "zero-change",
);

const realChangeEngine = new FixtureCodingEngine(
  {
    implementer: async (request) => {
      await writeFile(join(request.workspacePath, "add.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
      const result: StepResult = {
        status: "completed",
        summary: "Fixed add() to return the sum of its arguments.",
        filesChanged: ["add.js"],
        diffRef: null,
        confidence: "high",
        findings: [],
        needsInput: null,
      };
      return { result, cost: null, logExcerpt: "" };
    },
    reviewer: () => {
      const result: StepResult = {
        status: "completed",
        summary: "add() correctly sums its arguments.",
        filesChanged: [],
        diffRef: null,
        confidence: "high",
        findings: [],
        needsInput: null,
      };
      return { result, cost: null, logExcerpt: "" };
    },
  },
  "real-change",
);

test("zero-change: an implementer pass that produces literally no file changes never calls commitAll", async () => {
  const { platform, project, scProvider } = await setupPlatformWithFakeSourceControl("zero-commit", zeroChangeEngine);
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Add a NOTICE file only if missing",
    goal: "Do not modify any existing files.",
    createdBy: null,
  });

  await platform.orchestrator.executeTask(task.id);

  assert.ok(!scProvider.calls.some((c) => c.op === "commitAll"), "commitAll must never be called for a zero-change result");
});

test("zero-change: an implementer pass that produces literally no file changes never calls push", async () => {
  const { platform, project, scProvider } = await setupPlatformWithFakeSourceControl("zero-push", zeroChangeEngine);
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Add a NOTICE file only if missing",
    goal: "Do not modify any existing files.",
    createdBy: null,
  });

  await platform.orchestrator.executeTask(task.id);

  assert.ok(!scProvider.calls.some((c) => c.op === "push"), "push must never be called for a zero-change result");
});

test("zero-change: no GitHub/source-control API call of any kind happens for commit/push/PR, and the task lands in NEEDS_INPUT with a clear explanation", async () => {
  const { platform, project, scProvider } = await setupPlatformWithFakeSourceControl("zero-none", zeroChangeEngine);
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Add a NOTICE file only if missing",
    goal: "Do not modify any existing files.",
    createdBy: null,
  });

  const result = await platform.orchestrator.executeTask(task.id);

  // (4) verify via the fake's own call log — no commit/push/PR call of any kind.
  assert.deepEqual(
    scProvider.calls.filter((c) => c.op === "commitAll" || c.op === "push" || c.op === "openPullRequest"),
    [],
  );

  // (5) the task ends in the existing NEEDS_INPUT state — no new/bespoke status.
  assert.equal(result.status, "NEEDS_INPUT");

  const request = platform.humanInput.findOpenForTask(task.id);
  assert.ok(request, "expected an open human-input request explaining the zero-change result");
  assert.match(request!.discovered, /no files were changed/i);
  assert.match(request!.blocker, /nothing to commit/i);

  // A structured TaskEvent records the zero-change result, and the pipeline never even attempted
  // (let alone failed at) a source-control step for it.
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("NO_CHANGES_DETECTED"));
  assert.ok(events.includes("NEEDS_INPUT_RAISED"));
  assert.ok(!events.includes("COMMIT_CREATED"));
  assert.ok(!events.includes("BRANCH_PUSHED"));
  assert.ok(!events.includes("PULL_REQUEST_CREATED"));
  assert.ok(!events.includes("SOURCE_CONTROL_FAILED"), "must never surface as an opaque source-control/GitHub failure");
});

test("regression: an implementation WITH real changes still commits, pushes, and opens a PR normally", async () => {
  const { platform, project, scProvider } = await setupPlatformWithFakeSourceControl("real-change", realChangeEngine);
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "REVIEW");
  assert.ok(scProvider.calls.some((c) => c.op === "commitAll"));
  assert.ok(scProvider.calls.some((c) => c.op === "push"));
  assert.ok(scProvider.calls.some((c) => c.op === "openPullRequest"));

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("NO_CHANGES_DETECTED"), "a real-change result must never be misdetected as zero-change");
});
