import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform, type BuildPlatformOptions } from "../src/platform.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { FakeSourceControlProvider } from "./helpers/fake-source-control-provider.js";
import { CancellationError } from "../src/domain/errors.js";
import type { OrchestratorConfig } from "../src/orchestrator/config.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { HumanReviewFeedbackItem, Project, StepResult } from "../src/domain/types.js";

const CORRECT_ADD = `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`;

/**
 * Two Orchestrators, different `ownerId`, sharing one sqlite file (WAL mode)
 * and one workspaces directory — the same relationship a real API process
 * and a real worker process (or a worker before/after a restart) have. This
 * is what lets these tests simulate "a second process picks up an
 * abandoned task" for real, through the real claim/lease/recovery code
 * paths, instead of hand-seeding database rows.
 */
async function setupTwoWorkerPlatform(
  label: string,
  engine: FixtureCodingEngine,
  options: {
    orchestratorConfig?: Partial<OrchestratorConfig>;
    sourceControlProvider?: string;
    owner?: string | null;
    repo?: string | null;
    additionalSourceControlProviders?: BuildPlatformOptions["additionalSourceControlProviders"];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `recovery-${label}-`));
  const dbPath = join(root, "platform.sqlite");
  const workspacesRoot = join(root, "workspaces");
  const buildOpts: BuildPlatformOptions = {
    dbPath,
    workspacesRoot,
    engine,
    orchestratorConfig: options.orchestratorConfig,
    additionalSourceControlProviders: options.additionalSourceControlProviders,
  };
  const platformA = buildPlatform({ ...buildOpts, ownerId: `${label}-worker-A` });
  const platformB = buildPlatform({ ...buildOpts, ownerId: `${label}-worker-B` });

  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: `${label}@example.com`, name: "Tester", passwordHash: "", createdAt: now };
  platformA.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: options.sourceControlProvider ?? "local-git",
    owner: options.owner ?? null,
    repo: options.repo ?? null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platformA.projects.insert(project);
  return { platformA, platformB, project, root };
}

function makeTask(platform: Platform, project: Project) {
  return createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

async function correctImplementerResult(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
  await writeFile(join(request.workspacePath, "add.js"), CORRECT_ADD);
  const result: StepResult = {
    status: "completed",
    summary: "Fixed add() to return the sum of its arguments.",
    filesChanged: ["add.js"],
    diffRef: null,
    confidence: "high",
    findings: [],
    needsInput: null,
  };
  return { result, cost: null, logExcerpt: "fixture implementer" };
}

async function approvingReviewerHandler(): Promise<EngineInvocationResult> {
  const result: StepResult = {
    status: "completed",
    summary: "Change is correct and passes all checks.",
    filesChanged: [],
    diffRef: null,
    confidence: "high",
    findings: [],
    needsInput: null,
  };
  return { result, cost: null, logExcerpt: "fixture reviewer (always approves)" };
}

async function driveToReview(platform: Platform, project: Project) {
  const task = makeTask(platform, project);
  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  return result;
}

function changesRequestedItem(): HumanReviewFeedbackItem {
  return {
    id: "review:1",
    kind: "review",
    verdict: "changes_requested",
    body: "Please add a comment explaining the edge cases.",
    authorLogin: "human-reviewer",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A gate a handler can `await` to simulate "the process died mid-call." The test treats the
 * original call as abandoned (never awaits its result) but still calls `release()` at the very
 * end, after every assertion, so the stuck call's own cancellation-watcher/lease-heartbeat timers
 * (which only clear once the call itself settles) don't keep the test process alive.
 */
function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Releases a stuck call's gate and waits for it to settle (ignoring whatever it resolves/rejects
 *  to — it's abandoned work from a "crashed" process) so no timers are left dangling. */
async function abandon(stuck: Promise<unknown>, release: () => void): Promise<void> {
  release();
  await stuck.catch(() => {});
}

/**
 * Polls until a `role` AgentRun is actually "running" — used instead of a fixed sleep before
 * declaring the "crashed" process stuck: real work (git clone, validation, commit, push) happens
 * before the target role's own invocation, and its duration varies with machine load, so a fixed
 * sleep either fires too early (nothing to recover yet — the "crashed" process is still quietly
 * making real progress in the background, since a dangling promise doesn't actually stop
 * executing) or wastes time. Once this resolves, the target call is genuinely, permanently stuck
 * (it's blocked on a gate that's never released), so waiting out the lease afterward is safe.
 */
async function waitForRunningAgentRun(platform: Platform, taskId: string, role: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (platform.agentRuns.listForTask(taskId).some((r) => r.role === role && r.status === "running")) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for a running ${role} AgentRun`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// 1. Worker restart during implementation
// ---------------------------------------------------------------------------

test("worker restart during implementation: a second process resumes, no duplicate workspace/branch, correct next attemptNumber", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (implementerCalls === 1) await gate.promise; // "crashes" — never returns
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("impl", engine, {
    orchestratorConfig: { taskLeaseMs: 80, leaseHeartbeatIntervalMs: 1_000_000 }, // heartbeat effectively disabled
  });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id); // never resolves — attempt 1 is stuck on the gate
  await waitForRunningAgentRun(platformB, task.id, "implementer");
  await new Promise((r) => setTimeout(r, 120)); // let the 80ms lease genuinely expire

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platformB.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const runs = platformB.agentRuns.listForTask(task.id);
  const implementerRuns = runs.filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 2, "the interrupted attempt plus the real, completed resumed attempt");
  assert.equal(implementerRuns[0]!.status, "interrupted");
  assert.deepEqual(implementerRuns.map((r) => r.attemptNumber), [1, 2], "no attemptNumber collision across the crash");

  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1, "no duplicate workspace event on recovery");
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1, "no duplicate branch event on recovery");

  const workspace = platformB.workspaces.findByTaskId(task.id);
  assert.equal(workspace!.status, "ready");

  await abandon(stuck, gate.release);
});

// ---------------------------------------------------------------------------
// 2. Worker restart during validation (no AgentRun in flight, but the episode was mid-way)
// ---------------------------------------------------------------------------

test("worker restart during validation: recovery re-runs safely with no duplicate workspace/branch/PR", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("validation", engine, { orchestratorConfig: { taskLeaseMs: 60 } });
  const task = makeTask(platformA, project);

  // Simulate "the implementer finished for real, then the process died before/during validation":
  // claim as worker A for a very short lease and let it expire without ever finishing the episode.
  const now = new Date().toISOString();
  platformA.tasks.claimTodo(task.id, "validation-worker-A", 30, now);
  await new Promise((r) => setTimeout(r, 60));

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platformB.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1);
});

// ---------------------------------------------------------------------------
// 3. Worker restart during the AI reviewer's own invocation
// ---------------------------------------------------------------------------

test("worker restart during the AI reviewer invocation: a second process resumes to REVIEW with correct reviewer attemptNumbers, one PR", async () => {
  const gate = makeGate();
  let reviewerCalls = 0;
  const reviewerHandler = async (): Promise<EngineInvocationResult> => {
    reviewerCalls += 1;
    if (reviewerCalls === 1) await gate.promise;
    return approvingReviewerHandler();
  };
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: reviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("review", engine, {
    orchestratorConfig: { taskLeaseMs: 80, leaseHeartbeatIntervalMs: 1_000_000 },
  });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id); // implementer completes for real; reviewer call 1 hangs
  await waitForRunningAgentRun(platformB, task.id, "reviewer");
  await new Promise((r) => setTimeout(r, 120));

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platformB.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest);

  const runs = platformB.agentRuns.listForTask(task.id);
  const implementerRuns = runs.filter((r) => r.role === "implementer");
  const reviewerRuns = runs.filter((r) => r.role === "reviewer");
  // Recovery restarts the whole episode from the top (see /docs/TASK_LIFECYCLE.md "Crash
  // recovery") — the self-fix loop runs the Implementer again too, not just the Reviewer.
  // Every AgentRun's attemptNumber must still be unique per role regardless.
  const implementerAttempts = implementerRuns.map((r) => r.attemptNumber);
  assert.equal(new Set(implementerAttempts).size, implementerAttempts.length, "no duplicate implementer attemptNumbers");
  const reviewAttempts = reviewerRuns.map((r) => r.attemptNumber);
  assert.equal(new Set(reviewAttempts).size, reviewAttempts.length, "no duplicate reviewer attemptNumbers");
  assert.equal(reviewerRuns[0]!.status, "interrupted");

  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1, "still exactly one PR despite the redundant re-run");

  await abandon(stuck, gate.release);
});

// ---------------------------------------------------------------------------
// 4. Worker restart during an AI review/fix cycle (reviewer rejected, fix implementer in flight)
// ---------------------------------------------------------------------------

test("worker restart during an AI reviewer fix cycle: resumes correctly, one PR, correct attemptNumbers", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  let reviewerCalls = 0;
  const implementerHandler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (request.context.reviewerFeedback) await gate.promise; // the fix pass hangs — "crash" mid-fix
    return correctImplementerResult(request);
  };
  const reviewerHandler = async (): Promise<EngineInvocationResult> => {
    reviewerCalls += 1;
    const rejected = reviewerCalls === 1;
    const result: StepResult = {
      status: "completed",
      summary: rejected ? "Found an issue." : "Looks correct now.",
      filesChanged: [],
      diffRef: null,
      confidence: rejected ? "low" : "high",
      findings: rejected ? [{ category: "correctness", severity: "blocker", summary: "off-by-one" }] : [],
      needsInput: null,
    };
    return { result, cost: null, logExcerpt: "fixture reviewer" };
  };
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: reviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("fix-cycle", engine, {
    orchestratorConfig: { taskLeaseMs: 80, leaseHeartbeatIntervalMs: 1_000_000, maxReviewerRejections: 2 },
  });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id); // implementer -> validate -> commit/push -> reviewer rejects -> fix implementer hangs
  // Wait for the SECOND implementer run specifically (the fix pass) — the first one runs and
  // completes for real before the reviewer ever rejects it.
  const fixPassStart = Date.now();
  for (;;) {
    const implRuns = platformB.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
    if (implRuns.length >= 2 && implRuns[1]!.status === "running") break;
    if (Date.now() - fixPassStart > 4000) throw new Error("Timed out waiting for the fix-pass implementer run");
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 120));

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platformB.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest);

  const implementerRuns = platformB.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  const attemptNumbers = implementerRuns.map((r) => r.attemptNumber);
  assert.equal(new Set(attemptNumbers).size, attemptNumbers.length, "no duplicate implementer attemptNumbers across the crash");
  assert.ok(implementerRuns.some((r) => r.status === "interrupted"));

  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1);

  await abandon(stuck, gate.release);
});

// ---------------------------------------------------------------------------
// 5. Worker restart during a human review feedback fix cycle — the key dispatch-correctness test
// ---------------------------------------------------------------------------

test("worker restart during a human review feedback fix cycle: a plain executeTask() resume (not checkHumanReviewFeedback) still completes the fix correctly, one PR, no duplicate trigger event", async () => {
  const gate = makeGate();
  let humanFixCalls = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    if (request.context.humanReviewFeedback) {
      humanFixCalls += 1;
      if (humanFixCalls === 1) await gate.promise; // only the first (original, interrupted) fix pass hangs
    }
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const scProvider = new FakeSourceControlProvider("github");
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("human-fix-cycle", engine, {
    orchestratorConfig: { taskLeaseMs: 80, leaseHeartbeatIntervalMs: 1_000_000 },
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    additionalSourceControlProviders: [scProvider],
  });
  const task = await driveToReview(platformA, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);

  const stuck = platformA.orchestrator.checkHumanReviewFeedback(task.id); // claims REVIEW -> WORKING, fix pass hangs
  await waitForRunningAgentRun(platformB, task.id, "implementer");
  await new Promise((r) => setTimeout(r, 120));

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  // The worker's own poll loop only ever calls executeTask() for a WORKING task — never
  // checkHumanReviewFeedback directly. This is the exact call recovery must get right.
  const result = await platformB.orchestrator.executeTask(task.id);

  assert.equal(result.status, "REVIEW", "resumed the human-feedback fix cycle, not the original pipeline");
  assert.equal(result.taskRecord.pendingHumanReviewFeedback, null, "cleared once the cycle completed");
  assert.ok(result.taskRecord.pullRequest);
  assert.equal(scProvider.pullRequestsCreated, 1, "still exactly one PR");

  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "HUMAN_REVIEW_CHANGES_REQUESTED").length, 1, "not duplicated by the recovery re-entry");
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1);

  const implementerRuns = platformB.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 3, "original pass + interrupted fix attempt + real resumed fix attempt");
  assert.equal(implementerRuns[1]!.status, "interrupted");
  assert.deepEqual(implementerRuns.map((r) => r.attemptNumber), [1, 2, 3]);

  await abandon(stuck, gate.release);
});

// ---------------------------------------------------------------------------
// 6. Stale WORKING task recovery (lease expired, no live process)
// ---------------------------------------------------------------------------

test("a stale WORKING task (no live process, expired lease) is found by recoverOrphanedTasks and safely resumed", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("stale", engine, { orchestratorConfig: { taskLeaseMs: 30 } });
  const task = makeTask(platformA, project);

  const now = new Date().toISOString();
  platformA.tasks.claimTodo(task.id, "long-gone-worker", 1, now);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(platformA.orchestrator.recoverOrphanedTasks(), [task.id]);

  const result = await platformA.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
});

// ---------------------------------------------------------------------------
// 7. A genuinely slow (not crashed) episode is not mistaken for orphaned — lease heartbeat
// ---------------------------------------------------------------------------

test("a genuinely slow but still-alive episode is never treated as orphaned: the lease heartbeat keeps renewing it", async () => {
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 250));
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    await gate;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("alive", engine, {
    orchestratorConfig: { taskLeaseMs: 80, leaseHeartbeatIntervalMs: 20 },
  });
  const task = makeTask(platformA, project);

  const inFlight = platformA.orchestrator.executeTask(task.id);
  await new Promise((r) => setTimeout(r, 150)); // longer than taskLeaseMs, but heartbeat renews every 20ms

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [], "must not be considered orphaned while the heartbeat keeps renewing the lease");

  const stillOwned = await platformB.orchestrator.executeTask(task.id);
  assert.equal(stillOwned.status, "WORKING", "worker B could not claim it — worker A genuinely still owns it");

  const finished = await inFlight;
  assert.equal(finished.status, "REVIEW");
});

// ---------------------------------------------------------------------------
// 8. Cancellation after recovery
// ---------------------------------------------------------------------------

test("cancellation is honored on a task resumed after recovery — CANCELLED, no further work", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  let cancelled = false;
  let platformBRef: Platform;
  let taskId = "";
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (implementerCalls === 1) await gate.promise; // first attempt "crashes"
    if (implementerCalls === 2) {
      // Second (recovered) attempt: cancel this task as a side effect, then honor it.
      await platformBRef.orchestrator.requestCancellation(taskId, "tester");
      cancelled = true;
      throw new CancellationError();
    }
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("cancel-after-recovery", engine, {
    orchestratorConfig: { taskLeaseMs: 80, leaseHeartbeatIntervalMs: 1_000_000 },
  });
  platformBRef = platformB;
  const task = makeTask(platformA, project);
  taskId = task.id;

  const stuck = platformA.orchestrator.executeTask(task.id);
  await waitForRunningAgentRun(platformB, task.id, "implementer");
  await new Promise((r) => setTimeout(r, 120));
  platformB.orchestrator.recoverOrphanedTasks();

  const result = await platformB.orchestrator.executeTask(task.id);

  assert.equal(result.status, "CANCELLED");
  assert.ok(cancelled);
  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("TASK_MOVED_TO_REVIEW"));

  await abandon(stuck, gate.release);
});

// ---------------------------------------------------------------------------
// 9. Recovery after an unexpected exception (same process, not a crash) still fails cleanly
// ---------------------------------------------------------------------------

test("an unexpected exception mid-episode fails the task cleanly (existing behavior), and it is not left claimable forever", async () => {
  const handler = async (): Promise<EngineInvocationResult> => {
    throw new Error("simulated unexpected exception");
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("exception", engine, {});
  const task = makeTask(platformA, project);

  const result = await platformA.orchestrator.executeTask(task.id);

  assert.equal(result.status, "FAILED");
  assert.equal(result.lockOwner, null, "the lock is released even on an unhandled exception — never left stuck");
  const events = platformA.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("TASK_FAILED"));
});
