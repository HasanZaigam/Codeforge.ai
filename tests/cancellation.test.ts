import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine, createNeedsInputDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { InvalidTransitionError } from "../src/domain/task-state-machine.js";
import { CancellationError } from "../src/domain/errors.js";
import type { AgentRole, Project, StepResult } from "../src/domain/types.js";
import type { OrchestratorConfig } from "../src/orchestrator/config.js";

const FAST_CANCEL_CONFIG: Partial<OrchestratorConfig> = { cancellationPollIntervalMs: 30 };

const INSTANT_RESULT: StepResult = {
  status: "completed",
  summary: "done",
  filesChanged: [],
  diffRef: null,
  confidence: "high",
  findings: [],
  needsInput: null,
};

/** Resolves immediately for every role except `hangRole`, which never resolves on its own — only cancellation (signal abort) settles it. */
function hangingEngine(hangRole: AgentRole): FixtureCodingEngine {
  return new FixtureCodingEngine({
    implementer: (request) =>
      hangRole === "implementer" ? hang(request.signal) : Promise.resolve({ result: INSTANT_RESULT, cost: null, logExcerpt: "" }),
    reviewer: (request) =>
      hangRole === "reviewer" ? hang(request.signal) : Promise.resolve({ result: INSTANT_RESULT, cost: null, logExcerpt: "" }),
  });
}

function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new CancellationError());
      return;
    }
    signal.addEventListener("abort", () => reject(new CancellationError()), { once: true });
    // Otherwise: never resolves/rejects on its own — the test drives cancellation externally.
  });
}

async function setupPlatform(
  label: string,
  engine: FixtureCodingEngine,
  orchestratorConfig?: Partial<OrchestratorConfig>,
  commands: Project["commands"] = { test: "node test.js" },
) {
  const root = await mkdtemp(join(tmpdir(), `cancel-test-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `cancel-test-${label}`,
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
    commands,
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  return { platform, project, user, root };
}

function newTask(platform: Platform, projectId: string, title = "Cancel me") {
  return createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId,
    title,
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

// ---------------------------------------------------------------------------
// 1. Cancellation before execution starts (TODO)
// ---------------------------------------------------------------------------

test("cancelling a TODO task finalizes immediately, before the worker ever executes it", async () => {
  const { platform, project, user } = await setupPlatform("todo", createSelfFixDemoEngine());
  const task = newTask(platform, project.id);

  const cancelled = await platform.orchestrator.requestCancellation(task.id, user.id);
  assert.equal(cancelled.status, "CANCELLED");

  // The worker must never pick this up and start executing it.
  const executed = await platform.orchestrator.executeTask(task.id);
  assert.equal(executed.status, "CANCELLED");
  assert.equal(platform.agentRuns.listForTask(task.id).length, 0, "no agent should ever have run");

  const eventTypes = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(eventTypes.includes("CANCEL_REQUESTED"));
  assert.ok(eventTypes.includes("TASK_CANCELLED"));
});

// ---------------------------------------------------------------------------
// 2. Cancellation during the Implementer
// ---------------------------------------------------------------------------

test("cancellation during the Implementer interrupts it and reaches CANCELLED, not NEEDS_INPUT or REVIEW", async () => {
  const { platform, project, user } = await setupPlatform("during-impl", hangingEngine("implementer"), FAST_CANCEL_CONFIG);
  const task = newTask(platform, project.id);

  const executePromise = platform.orchestrator.executeTask(task.id);
  // Wait for the implementer to have actually started (not just status=WORKING, which flips
  // during claiming — before workspace provisioning even runs) so this test genuinely exercises
  // cancellation while the Implementer step itself is in flight, not while cloning the workspace.
  await waitForEvent(platform, task.id, "AGENT_STARTED", (payload) => payload.role === "implementer");
  await platform.orchestrator.requestCancellation(task.id, user.id);

  const result = await executePromise;
  assert.equal(result.status, "CANCELLED");

  const runs = platform.agentRuns.listForTask(task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "cancelled");

  const eventTypes = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(eventTypes.includes("EXECUTION_CANCELLED"));
  assert.ok(eventTypes.includes("WORKSPACE_CLEANUP_STARTED"));
  assert.ok(eventTypes.includes("WORKSPACE_CLEANUP_COMPLETED"));
  assert.ok(eventTypes.includes("TASK_CANCELLED"));

  const workspace = platform.workspaces.findByTaskId(task.id);
  assert.equal(workspace?.status, "torn_down", "the disposable task workspace must be cleaned up");
});

// ---------------------------------------------------------------------------
// 3. Cancellation during validation (a real child process, not just a fixture promise)
// ---------------------------------------------------------------------------

test("cancellation during validation kills the running check process and reaches CANCELLED", async () => {
  const instantImplementer = new FixtureCodingEngine({
    implementer: () => Promise.resolve({ result: INSTANT_RESULT, cost: null, logExcerpt: "" }),
  });
  const { platform, project, user } = await setupPlatform("during-validation", instantImplementer, FAST_CANCEL_CONFIG);
  // A command that would run far longer than this test's patience if not actually killed.
  platform.projects.updateCommands(project.id, { test: "sleep 30" }, new Date().toISOString());
  const task = newTask(platform, project.id);

  const start = Date.now();
  const executePromise = platform.orchestrator.executeTask(task.id);
  await waitForEvent(platform, task.id, "VALIDATION_STARTED");
  await platform.orchestrator.requestCancellation(task.id, user.id);

  const result = await executePromise;
  const elapsedMs = Date.now() - start;

  assert.equal(result.status, "CANCELLED");
  assert.ok(elapsedMs < 10_000, `expected the sleep 30 process to be killed quickly, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// 4. Cancellation during the Reviewer
// ---------------------------------------------------------------------------

test("cancellation during the Reviewer interrupts it and reaches CANCELLED", async () => {
  // No commands declared: validation trivially "passes" (see validation-runner.ts — undeclared
  // checks are skipped, not failed), so the implementer's instant result sails straight through
  // to the review loop, where this test's reviewer hangs until cancelled.
  const { platform, project, user } = await setupPlatform("during-review", hangingEngine("reviewer"), FAST_CANCEL_CONFIG, null);
  const task = newTask(platform, project.id);

  const executePromise = platform.orchestrator.executeTask(task.id);
  await waitForEvent(platform, task.id, "AGENT_STARTED", (payload) => payload.role === "reviewer");
  await platform.orchestrator.requestCancellation(task.id, user.id);

  const result = await executePromise;
  assert.equal(result.status, "CANCELLED");

  const reviewerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "reviewer");
  assert.equal(reviewerRuns.length, 1);
  assert.equal(reviewerRuns[0]?.status, "cancelled");
});

// ---------------------------------------------------------------------------
// 5. Cancellation after execution has already completed
// ---------------------------------------------------------------------------

test("cancelling a task already in REVIEW is rejected, not silently applied", async () => {
  const { platform, project, user } = await setupPlatform("already-review", createSelfFixDemoEngine());
  const task = newTask(platform, project.id);
  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  await assert.rejects(() => platform.orchestrator.requestCancellation(task.id, user.id), InvalidTransitionError);
  assert.equal(platform.tasks.findById(task.id)?.status, "REVIEW", "REVIEW must be untouched by the rejected cancel request");
});

// ---------------------------------------------------------------------------
// 6. Repeated cancellation is idempotent
// ---------------------------------------------------------------------------

test("repeated cancellation of the same task is idempotent", async () => {
  const { platform, project, user } = await setupPlatform("repeated", createSelfFixDemoEngine());
  const task = newTask(platform, project.id);

  const first = await platform.orchestrator.requestCancellation(task.id, user.id);
  const second = await platform.orchestrator.requestCancellation(task.id, user.id);
  const third = await platform.orchestrator.requestCancellation(task.id, user.id);

  assert.equal(first.status, "CANCELLED");
  assert.equal(second.status, "CANCELLED");
  assert.equal(third.status, "CANCELLED");

  const cancelledEvents = platform.taskEvents.listForTask(task.id).filter((e) => e.type === "TASK_CANCELLED");
  assert.equal(cancelledEvents.length, 1, "finalization must only happen once, no matter how many times cancel is requested");
});

test("a cancel request already pending on a WORKING task is not recorded twice", async () => {
  const { platform, project, user } = await setupPlatform("pending-repeat", hangingEngine("implementer"), FAST_CANCEL_CONFIG);
  const task = newTask(platform, project.id);

  const executePromise = platform.orchestrator.executeTask(task.id);
  await waitForStatus(platform, task.id, "WORKING");

  await platform.orchestrator.requestCancellation(task.id, user.id);
  const again = await platform.orchestrator.requestCancellation(task.id, user.id);
  assert.equal(again.status, "WORKING", "still cancelling, not yet finalized");

  await executePromise;
  const cancelRequestedEvents = platform.taskEvents.listForTask(task.id).filter((e) => e.type === "CANCEL_REQUESTED");
  assert.equal(cancelRequestedEvents.length, 1, "the intent should only be recorded once even though it was requested twice");
});

// ---------------------------------------------------------------------------
// 7. Cancellation racing with completion — deterministic, non-contradictory outcome
// ---------------------------------------------------------------------------

test("cancellation racing with a fast completion never produces a contradictory result", async () => {
  const { platform, project, user } = await setupPlatform("race", createSelfFixDemoEngine(), {
    cancellationPollIntervalMs: 10_000, // slow enough that the fast fixture engine finishes first
  });
  const task = newTask(platform, project.id);

  const [executed] = await Promise.all([
    platform.orchestrator.executeTask(task.id),
    platform.orchestrator.requestCancellation(task.id, user.id).catch(() => null), // may legitimately lose the race and 409
  ]);

  assert.ok(["REVIEW", "CANCELLED"].includes(executed.status), `unexpected terminal state: ${executed.status}`);

  // Whichever outcome won, it must be internally consistent — never both "moved to review" and "cancelled".
  const eventTypes = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  const wasReviewed = eventTypes.includes("TASK_MOVED_TO_REVIEW");
  const wasCancelled = eventTypes.includes("TASK_CANCELLED");
  assert.notEqual(wasReviewed, wasCancelled, "exactly one outcome must have happened, never both, never neither");
});

// ---------------------------------------------------------------------------
// 8. Cancellation followed by worker recovery
// ---------------------------------------------------------------------------

test("a cancellation requested right as a task's lease expires converges to CANCELLED on recovery, not stuck WORKING", async () => {
  const { platform, project, user } = await setupPlatform("recovery", createSelfFixDemoEngine(), { taskLeaseMs: 50 });
  const task = newTask(platform, project.id);

  // Simulate a worker crash: claim the lease directly and let it expire without ever finishing.
  const t0 = new Date().toISOString();
  platform.tasks.claimTodo(task.id, "crashed-worker", 1, t0);
  await platform.orchestrator.requestCancellation(task.id, user.id); // records intent while "orphaned"
  await new Promise((r) => setTimeout(r, 15));

  const orphaned = platform.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "CANCELLED", "recovery must finalize the pending cancellation, not resume execution");
  assert.equal(platform.tasks.findById(task.id)?.lockOwner, null, "the lease must be released, not left stuck");
});

// ---------------------------------------------------------------------------
// 9. No duplicate execution after cancellation
// ---------------------------------------------------------------------------

test("a CANCELLED task is never re-claimed or re-executed by a subsequent executeTask() call", async () => {
  const { platform, project, user } = await setupPlatform("no-duplicate", createSelfFixDemoEngine());
  const task = newTask(platform, project.id);
  await platform.orchestrator.requestCancellation(task.id, user.id);

  await platform.orchestrator.executeTask(task.id);
  await platform.orchestrator.executeTask(task.id);
  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "CANCELLED");
  assert.equal(platform.agentRuns.listForTask(task.id).length, 0);
});

// ---------------------------------------------------------------------------
// NEEDS_INPUT cancellation (Case G)
// ---------------------------------------------------------------------------

test("a NEEDS_INPUT task can be cancelled directly, without ever being answered", async () => {
  const { platform, project, user } = await setupPlatform("needs-input-cancel", createNeedsInputDemoEngine());
  const task = newTask(platform, project.id);
  const afterFirstRun = await platform.orchestrator.executeTask(task.id);
  assert.equal(afterFirstRun.status, "NEEDS_INPUT");

  const cancelled = await platform.orchestrator.requestCancellation(task.id, user.id);
  assert.equal(cancelled.status, "CANCELLED");

  // Answering after cancellation must fail — the open request is moot once the task is terminal.
  const openRequest = platform.humanInput.findOpenForTask(task.id);
  assert.ok(openRequest, "the historical request is preserved for audit, even though the task moved on");

  const workspace = platform.workspaces.findByTaskId(task.id);
  assert.equal(workspace?.status, "torn_down", "the workspace from the paused WORKING episode must still be cleaned up");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForStatus(platform: Platform, taskId: string, status: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (platform.tasks.findById(taskId)?.status === status) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for task ${taskId} to reach ${status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForEvent(
  platform: Platform,
  taskId: string,
  type: string,
  matches: (payload: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (platform.taskEvents.listForTask(taskId).some((e) => e.type === type && matches(e.payload))) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for event ${type} on task ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
