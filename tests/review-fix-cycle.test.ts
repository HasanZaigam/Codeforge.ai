import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { CancellationError } from "../src/domain/errors.js";
import { buildTaskReport } from "../src/reporting/task-report.js";
import type { OrchestratorConfig } from "../src/orchestrator/config.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { Finding, Project, StepResult } from "../src/domain/types.js";

const CORRECT_ADD = `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`;

async function setupPlatform(label: string, engine: FixtureCodingEngine, orchestratorConfig?: Partial<OrchestratorConfig>) {
  const root = await mkdtemp(join(tmpdir(), `review-cycle-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    orchestratorConfig,
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
  return { platform, project, user, root };
}

function makeTask(platform: Platform, project: Project) {
  return createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

/** Always produces a correct, passing implementation — isolates review-cycle behavior from self-fix-loop behavior. */
async function implementerHandler(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
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

const BLOCKER_FINDING: Finding = { category: "correctness", severity: "blocker", summary: "add() still has an off-by-one in the caller", location: "add.js" };

/** Rejects the first `rejectionsBeforeApproval` calls (with a real structured blocker finding), then approves. */
function scriptedReviewer(rejectionsBeforeApproval: number): { handler: (r: EngineInvocationRequest) => Promise<EngineInvocationResult>; calls: EngineInvocationRequest[] } {
  const calls: EngineInvocationRequest[] = [];
  let callCount = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    calls.push(request);
    callCount += 1;
    const rejected = callCount <= rejectionsBeforeApproval;
    const result: StepResult = {
      status: "completed",
      summary: rejected ? "Found a real issue with this implementation." : "Change is correct and passes all checks.",
      filesChanged: [],
      diffRef: null,
      confidence: rejected ? "low" : "high",
      findings: rejected ? [BLOCKER_FINDING] : [],
      needsInput: null,
    };
    return { result, cost: null, logExcerpt: "fixture reviewer" };
  };
  return { handler, calls };
}

function alwaysRejectingReviewer(): (r: EngineInvocationRequest) => Promise<EngineInvocationResult> {
  return async () => {
    const result: StepResult = {
      status: "completed",
      summary: "Still not acceptable.",
      filesChanged: [],
      diffRef: null,
      confidence: "low",
      findings: [BLOCKER_FINDING],
      needsInput: null,
    };
    return { result, cost: null, logExcerpt: "fixture reviewer (always rejects)" };
  };
}

// ---------------------------------------------------------------------------
// 1. APPROVED path — existing behavior unchanged
// ---------------------------------------------------------------------------

test("reviewer APPROVED on the first pass: existing behavior unchanged — one implementer run, one reviewer run, REVIEW with a PR", async () => {
  const { calls: reviewerCalls, handler: reviewerHandler } = scriptedReviewer(0);
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("approved-first-pass", engine);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest);
  assert.equal(reviewerCalls.length, 1);

  const runs = platform.agentRuns.listForTask(task.id);
  assert.equal(runs.filter((r) => r.role === "implementer").length, 1);
  assert.equal(runs.filter((r) => r.role === "reviewer").length, 1);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.deepEqual(events, [
    "TASK_CREATED",
    "TASK_CLAIMED",
    "TASK_STARTED",
    "WORKSPACE_CREATED",
    "BRANCH_CREATED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "VALIDATION_STARTED",
    "VALIDATION_COMPLETED",
    "COMMIT_CREATED",
    "BRANCH_PUSHED",
    "REVIEW_STARTED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "REVIEW_COMPLETED",
    "PULL_REQUEST_CREATED",
    "TASK_MOVED_TO_REVIEW",
  ]);
  assert.ok(!events.includes("REVIEW_CHANGES_REQUESTED"), "no rejection ever happened");
});

// ---------------------------------------------------------------------------
// 2-4, 10, 11. CHANGES_REQUESTED → implementer runs again, with feedback, through validation/commit/push, back to reviewer
// ---------------------------------------------------------------------------

test("reviewer CHANGES_REQUESTED: implementer runs again in the SAME workspace/branch, findings reach it, then validation/commit/push/reviewer repeat", async () => {
  const { calls: reviewerCalls, handler: reviewerHandler } = scriptedReviewer(1);
  const implementerCalls: EngineInvocationRequest[] = [];
  const capturingImplementer = async (request: EngineInvocationRequest) => {
    implementerCalls.push(request);
    return implementerHandler(request);
  };
  const engine = new FixtureCodingEngine({ implementer: capturingImplementer, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("changes-requested", engine, { maxReviewerRejections: 2 });
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest);
  assert.equal(reviewerCalls.length, 2, "rejected once, approved on the second review");
  assert.equal(implementerCalls.length, 2, "initial implementation + one fix pass");

  // Point 3: reviewer findings reach the implementer's fix-pass context, via the existing
  // ContextBundle/prompt architecture (reviewerFeedback), not a parallel prompting system.
  const fixCallContext = implementerCalls[1]!.context;
  assert.equal(fixCallContext.lastFailure, null, "a review-triggered fix is not a validation failure");
  assert.ok(fixCallContext.reviewerFeedback);
  assert.equal(fixCallContext.reviewerFeedback!.verdict, "rejected");
  assert.equal(fixCallContext.reviewerFeedback!.findings[0]!.summary, BLOCKER_FINDING.summary);

  // Point 4/11: fix -> validation -> commit -> push -> reviewer, using the existing event/AgentRun
  // mechanisms — same workspace/branch throughout (see the invariant tests below for the explicit
  // no-duplicate assertions).
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.deepEqual(events, [
    "TASK_CREATED",
    "TASK_CLAIMED",
    "TASK_STARTED",
    "WORKSPACE_CREATED",
    "BRANCH_CREATED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "VALIDATION_STARTED",
    "VALIDATION_COMPLETED",
    "COMMIT_CREATED",
    "BRANCH_PUSHED",
    "REVIEW_STARTED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "REVIEW_COMPLETED",
    "REVIEW_CHANGES_REQUESTED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "VALIDATION_STARTED",
    "VALIDATION_COMPLETED",
    "COMMIT_CREATED",
    "BRANCH_PUSHED",
    "REVIEW_STARTED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "REVIEW_COMPLETED",
    "PULL_REQUEST_CREATED",
    "TASK_MOVED_TO_REVIEW",
  ]);

  // Point 11: AgentRun records are distinguishable by role + attemptNumber, correctly completed.
  const runs = platform.agentRuns.listForTask(task.id);
  const implementerRuns = runs.filter((r) => r.role === "implementer");
  const reviewerRuns = runs.filter((r) => r.role === "reviewer");
  assert.deepEqual(implementerRuns.map((r) => r.attemptNumber), [1, 2]);
  assert.deepEqual(reviewerRuns.map((r) => r.attemptNumber), [1, 2]);
  assert.ok(implementerRuns.every((r) => r.status === "completed"));
  assert.ok(reviewerRuns.every((r) => r.status === "completed"));
  // Point 8: reviewer findings are associated with the correct reviewer run's own result.
  assert.equal((reviewerRuns[0]!.result!.findings[0] as Finding).summary, BLOCKER_FINDING.summary);
  assert.equal(reviewerRuns[1]!.result!.findings.length, 0);
});

// ---------------------------------------------------------------------------
// 5, 16. Multiple review/fix cycles, then approval
// ---------------------------------------------------------------------------

test("multiple review/fix cycles (rejected twice) then approved: bounded by config, ends in REVIEW", async () => {
  const { calls: reviewerCalls, handler: reviewerHandler } = scriptedReviewer(2);
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("multi-cycle", engine, { maxReviewerRejections: 3 });
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "REVIEW");
  assert.equal(reviewerCalls.length, 3);

  const runs = platform.agentRuns.listForTask(task.id);
  assert.equal(runs.filter((r) => r.role === "implementer").length, 3, "initial + 2 fix passes");
  assert.equal(runs.filter((r) => r.role === "reviewer").length, 3);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "REVIEW_CHANGES_REQUESTED").length, 2);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1, "still exactly one PR despite two rejections");
});

// ---------------------------------------------------------------------------
// 6. Maximum cycle exhaustion
// ---------------------------------------------------------------------------

test("review/fix cycle exhaustion: reviewer always rejects -> task FAILS cleanly with a clear reason, not NEEDS_INPUT, not an infinite loop", async () => {
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: alwaysRejectingReviewer() });
  const { platform, project } = await setupPlatform("exhaustion", engine, { maxReviewerRejections: 2 });
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "FAILED");
  assert.equal(result.taskRecord.pullRequest, null, "never approved, so never opened a PR");

  const runs = platform.agentRuns.listForTask(task.id);
  // maxReviewerRejections=2 means: initial review + 2 fix/re-review cycles = 3 reviewer calls total
  // before exceeding budget (cycles > 2 on the 3rd rejection).
  assert.equal(runs.filter((r) => r.role === "reviewer").length, 3);
  assert.equal(runs.filter((r) => r.role === "implementer").length, 3);

  const events = platform.taskEvents.listForTask(task.id);
  const failedEvent = events.find((e) => e.type === "TASK_FAILED");
  assert.ok(failedEvent, "must reach the existing TASK_FAILED event mechanism, not a new one");
  const reason = failedEvent!.payload.error as string;
  assert.ok(reason.includes("3 fix attempt"), reason);
  assert.ok(reason.includes(BLOCKER_FINDING.summary), "the clear failure reason must include real evidence, not a generic message");
  assert.ok(!reason.includes('{"type"'), "must be human-readable, never raw serialized data");

  // The report surfaces the same reason through the existing report mechanism (see reporting/task-report.ts).
  const report = buildTaskReport(result, runs, events, project.defaultBranch);
  assert.equal(report.failureReason, reason);

  // Never an infinite loop: exactly maxReviewerRejections+1 review attempts, not unbounded.
  assert.equal(events.filter((e) => e.type === "REVIEW_STARTED").length, 3);
});

// ---------------------------------------------------------------------------
// 7-9. Workspace / branch / PR invariants
// ---------------------------------------------------------------------------

test("invariants: one workspace, one branch, one PR across multiple review/fix cycles — never duplicated", async () => {
  const { handler: reviewerHandler } = scriptedReviewer(2);
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("no-duplicates", engine, { maxReviewerRejections: 3 });
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1);

  const workspace = platform.workspaces.findByTaskId(task.id);
  assert.ok(workspace);
  assert.equal(workspace!.branch, result.taskRecord.branchName);
});

// ---------------------------------------------------------------------------
// 12-14. Cancellation
// ---------------------------------------------------------------------------

test("cancellation during reviewer execution stops the cycle cleanly — CANCELLED, no fix/re-review continues", async () => {
  let platformRef: Platform;
  const taskIdHolder: { id: string } = { id: "" };
  let reviewerCallCount = 0;
  const cancellingReviewer = async (): Promise<EngineInvocationResult> => {
    reviewerCallCount += 1;
    // Simulates a real adapter observing the abort mid-invocation (see coding-engine.ts's
    // cancellation contract: reject with a CancellationError, never resolve normally).
    await platformRef.orchestrator.requestCancellation(taskIdHolder.id, "tester");
    throw new CancellationError();
  };
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: cancellingReviewer });
  const { platform, project } = await setupPlatform("cancel-reviewer", engine);
  platformRef = platform;
  const task = makeTask(platform, project);
  taskIdHolder.id = task.id;

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "CANCELLED");
  assert.equal(reviewerCallCount, 1, "must not retry the reviewer after cancellation");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("REVIEW_CHANGES_REQUESTED"));
  assert.ok(!events.includes("TASK_MOVED_TO_REVIEW"));
});

test("cancellation during the implementer fix pass stops the cycle cleanly — CANCELLED, no commit/push/re-review", async () => {
  let platformRef: Platform;
  const taskIdHolder: { id: string } = { id: "" };
  let implementerCallCount = 0;
  const implementerThatCancelsOnFix = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCallCount += 1;
    if (request.context.reviewerFeedback) {
      // This is the fix pass triggered by a rejection — cancel here.
      await platformRef.orchestrator.requestCancellation(taskIdHolder.id, "tester");
      throw new CancellationError();
    }
    return implementerHandler(request);
  };
  const { handler: reviewerHandler } = scriptedReviewer(1);
  const engine = new FixtureCodingEngine({ implementer: implementerThatCancelsOnFix, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("cancel-fix", engine, { maxReviewerRejections: 2 });
  platformRef = platform;
  const task = makeTask(platform, project);
  taskIdHolder.id = task.id;

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "CANCELLED");
  assert.equal(implementerCallCount, 2, "initial implementer ran, fix pass started then cancelled");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("PULL_REQUEST_CREATED"));
  // Only the FIRST commit/push (before the rejection) — the fix pass never reached commit/push.
  assert.equal(events.filter((t) => t === "COMMIT_CREATED").length, 1);
});

test("cancellation requested right after a fix's commit/push, before the reviewer restarts, is honored — CANCELLED, no second REVIEW_STARTED", async () => {
  let platformRef: Platform;
  const taskIdHolder: { id: string } = { id: "" };
  const implementerThatCancelsAfterFix = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    const res = await implementerHandler(request);
    if (request.context.reviewerFeedback) {
      // Request cancellation as a side effect of the fix pass completing — the actual interruption
      // must happen at the Orchestrator's own checkpoint (top of the review loop), not here.
      await platformRef.orchestrator.requestCancellation(taskIdHolder.id, "tester");
    }
    return res;
  };
  const { handler: reviewerHandler } = scriptedReviewer(1);
  const engine = new FixtureCodingEngine({ implementer: implementerThatCancelsAfterFix, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("cancel-before-restart", engine, {
    maxReviewerRejections: 2,
    cancellationPollIntervalMs: 5,
  });
  platformRef = platform;
  const task = makeTask(platform, project);
  taskIdHolder.id = task.id;

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "CANCELLED");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "REVIEW_STARTED").length, 1, "must not have restarted the reviewer after cancellation");
  assert.ok(!events.includes("TASK_MOVED_TO_REVIEW"));
});

// ---------------------------------------------------------------------------
// 15. Validation failure during the fix cycle
// ---------------------------------------------------------------------------

test("if the fix pass's own change fails validation, the existing validation-failure behavior applies (NEEDS_INPUT), not a silent continuation", async () => {
  const implementerThatBreaksOnFix = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    if (request.context.reviewerFeedback) {
      // The initial pass already left add.js correctly fixed — merely "not touching" it here would
      // leave validation passing regardless, defeating the point of this test. Deliberately
      // re-break it so the fix pass's own validation run genuinely fails.
      await writeFile(join(request.workspacePath, "add.js"), `function add(a, b) {\n  return a - b; // still broken\n}\nmodule.exports = { add };\n`);
      const result: StepResult = {
        status: "completed",
        summary: "Attempted a fix but the logic is still wrong.",
        filesChanged: ["add.js"],
        diffRef: null,
        confidence: "low",
        findings: [],
        needsInput: null,
      };
      return { result, cost: null, logExcerpt: "fixture implementer (bad fix)" };
    }
    return implementerHandler(request);
  };
  const { handler: reviewerHandler } = scriptedReviewer(1);
  const engine = new FixtureCodingEngine({ implementer: implementerThatBreaksOnFix, reviewer: reviewerHandler });
  const { platform, project } = await setupPlatform("fix-validation-fails", engine, { maxReviewerRejections: 2 });
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);

  assert.equal(result.status, "NEEDS_INPUT", "an unfixed validation failure during the fix cycle uses the existing self-fix-exhaustion path");
  const request = platform.humanInput.findOpenForTask(task.id);
  assert.ok(request);
  assert.ok(request!.discovered.length > 0);
});
