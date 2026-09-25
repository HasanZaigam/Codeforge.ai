import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentRunHistory, computeExecutionDurations, deriveFailureContext } from "../src/reporting/execution-history.js";
import { buildTaskReport } from "../src/reporting/task-report.js";
import type { AgentRun, ContextBundle, Task, TaskEvent, TaskRecord } from "../src/domain/types.js";

function makeContextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    taskGoal: "Fix add()",
    taskPlan: null,
    priorDecisions: [],
    repoPath: "/tmp/workspace",
    projectConventionPointer: "See CLAUDE.md",
    lastFailure: null,
    reviewEvidence: null,
    reviewerFeedback: null,
    humanReviewFeedback: null,
    projectContext: null,
    approvedVerificationChecks: [],
    verificationEvidence: null,
    bugFixEvidence: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    taskId: "task-1",
    role: "implementer",
    engine: "fixture",
    attemptNumber: 1,
    status: "completed",
    input: makeContextBundle(),
    result: {
      status: "completed",
      summary: "Fixed add() to return the sum.",
      filesChanged: ["add.js"],
      diffRef: null,
      confidence: "high",
      findings: [],
      needsInput: null,
    },
    error: null,
    cost: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    ownerGeneration: 1,
    modelId: null,
    providerId: null,
    fallbackIndex: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: "event-1",
    taskId: "task-1",
    type: "TASK_CREATED",
    payload: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_TASK_RECORD: TaskRecord = {
  plan: null,
  decisions: [],
  branchName: "task/abc12345",
  latestDiffRef: null,
  selfFixAttempts: 0,
  workingEpisodes: 0,
  pullRequest: null,
  processedHumanFeedbackIds: [],
  pendingHumanReviewFeedback: null,
  bugFixVerification: null,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "default",
    projectId: "project-1",
    title: "Fix add()",
    goal: "add() returns the wrong result",
    status: "REVIEW",
    taskRecord: { ...EMPTY_TASK_RECORD },
    branchMode: "new",
    workingBranch: null,
    baseBranch: null,
    currentAgentRunId: null,
    workspaceId: null,
    lockOwner: null,
    lockExpiresAt: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    lockGeneration: 1,
    nextReviewCheckAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAgentRunHistory: trigger derivation
// ---------------------------------------------------------------------------

test("buildAgentRunHistory: an original implementer pass is trigger 'initial'", () => {
  const [item] = buildAgentRunHistory([makeRun()]);
  assert.equal(item!.trigger, "initial");
  assert.equal(item!.role, "implementer");
  assert.equal(item!.attemptNumber, 1);
  assert.equal(item!.summary, "Fixed add() to return the sum.");
  assert.deepEqual(item!.filesChanged, ["add.js"]);
  assert.equal(item!.confidence, "high");
});

test("buildAgentRunHistory: a self-fix retry (lastFailure present) is trigger 'self_fix_retry'", () => {
  const run = makeRun({
    attemptNumber: 2,
    input: makeContextBundle({ lastFailure: { status: "failed", outcome: "checks_failed", checks: [], durationMs: 100 } }),
  });
  const [item] = buildAgentRunHistory([run]);
  assert.equal(item!.trigger, "self_fix_retry");
});

test("buildAgentRunHistory: an AI-reviewer-triggered fix pass is trigger 'ai_review_fix'", () => {
  const run = makeRun({
    attemptNumber: 2,
    input: makeContextBundle({
      reviewerFeedback: { verdict: "rejected", findings: [], confidence: "low", summary: "Found an issue.", verificationMethod: "static", verification: null },
    }),
  });
  const [item] = buildAgentRunHistory([run]);
  assert.equal(item!.trigger, "ai_review_fix");
});

test("buildAgentRunHistory: a human-review-triggered fix pass is trigger 'human_review_fix' and exposes the reviewer's feedback", () => {
  const run = makeRun({
    attemptNumber: 2,
    input: makeContextBundle({ humanReviewFeedback: { reviewerLogin: "octocat", comments: "Please add a comment." } }),
  });
  const [item] = buildAgentRunHistory([run]);
  assert.equal(item!.trigger, "human_review_fix");
  assert.deepEqual(item!.humanReviewFeedback, { reviewerLogin: "octocat", comments: "Please add a comment." });
});

test("buildAgentRunHistory: a reviewer run is always trigger 'review', with verdict/findings derived from its result", () => {
  const run = makeRun({
    role: "reviewer",
    result: {
      status: "completed",
      summary: "VERDICT: CHANGES_REQUESTED\n\nFINDING: blocker | correctness | Off-by-one error.",
      filesChanged: [],
      diffRef: null,
      confidence: "low",
      findings: [],
      needsInput: null,
    },
  });
  const [item] = buildAgentRunHistory([run]);
  assert.equal(item!.trigger, "review");
  assert.equal(item!.verdict, "rejected");
  assert.equal(item!.findings!.length, 1);
  assert.equal(item!.findings![0]!.summary, "Off-by-one error.");
});

// ---------------------------------------------------------------------------
// buildAgentRunHistory: failed / interrupted / recovery
// ---------------------------------------------------------------------------

test("buildAgentRunHistory: a failed run exposes its sanitized error, and the next attempt is distinguishable", () => {
  const runs = [
    makeRun({ id: "r1", attemptNumber: 1, status: "failed", result: null, error: "Coding engine invocation (implementer) failed after 2 attempts: HTTP 503" }),
    makeRun({ id: "r2", attemptNumber: 2 }),
  ];
  const items = buildAgentRunHistory(runs);
  assert.equal(items[0]!.status, "failed");
  assert.equal(items[0]!.error, "Coding engine invocation (implementer) failed after 2 attempts: HTTP 503");
  assert.equal(items[0]!.summary, null, "no fabricated summary for a failed run");
  assert.equal(items[1]!.resumedAfterInterruption, false, "a plain failure is not an interruption");
});

test("buildAgentRunHistory: a run following an interrupted attempt of the same role is marked resumedAfterInterruption", () => {
  const runs = [
    makeRun({ id: "r1", attemptNumber: 1, status: "interrupted", result: null, error: "worker crashed before completion", completedAt: null }),
    makeRun({ id: "r2", attemptNumber: 2 }),
    makeRun({ id: "r3", role: "reviewer", attemptNumber: 1 }), // different role — must not be affected
  ];
  const items = buildAgentRunHistory(runs);
  assert.equal(items[0]!.resumedAfterInterruption, false);
  assert.equal(items[1]!.resumedAfterInterruption, true, "attempt 2 followed an interrupted attempt 1 of the same role");
  assert.equal(items[2]!.resumedAfterInterruption, false, "reviewer attempt 1 has no prior reviewer run at all");
});

test("buildAgentRunHistory: a still-running run has no completedAt and no error — never fabricated", () => {
  const run = makeRun({ status: "running", result: null, completedAt: null });
  const [item] = buildAgentRunHistory([run]);
  assert.equal(item!.completedAt, null);
  assert.equal(item!.error, null);
  assert.equal(item!.summary, null);
});

// ---------------------------------------------------------------------------
// computeExecutionDurations
// ---------------------------------------------------------------------------

test("computeExecutionDurations: totalMs is null until the task actually completes", () => {
  const task = makeTask({ completedAt: null });
  const d = computeExecutionDurations(task, [], []);
  assert.equal(d.totalMs, null);
});

test("computeExecutionDurations: totalMs, implementationMs, and reviewMs are all correctly derived from real timestamps", () => {
  const task = makeTask({ startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:10:00.000Z" });
  const runs = [
    makeRun({ role: "implementer", startedAt: "2026-01-01T00:00:10.000Z", completedAt: "2026-01-01T00:01:10.000Z" }), // 60s
    makeRun({ role: "implementer", attemptNumber: 2, startedAt: "2026-01-01T00:05:00.000Z", completedAt: "2026-01-01T00:05:20.000Z" }), // 20s
    makeRun({ role: "reviewer", startedAt: "2026-01-01T00:02:00.000Z", completedAt: "2026-01-01T00:02:15.000Z" }), // 15s
  ];
  const d = computeExecutionDurations(task, [], runs);
  assert.equal(d.totalMs, 10 * 60 * 1000);
  assert.equal(d.implementationMs, 80 * 1000);
  assert.equal(d.reviewMs, 15 * 1000);
});

test("computeExecutionDurations: validationMs sums every paired VALIDATION_STARTED/VALIDATION_COMPLETED", () => {
  const events = [
    makeEvent({ type: "VALIDATION_STARTED", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeEvent({ type: "VALIDATION_COMPLETED", createdAt: "2026-01-01T00:00:10.000Z" }), // 10s
    makeEvent({ type: "VALIDATION_STARTED", createdAt: "2026-01-01T00:01:00.000Z" }),
    makeEvent({ type: "VALIDATION_COMPLETED", createdAt: "2026-01-01T00:01:05.000Z" }), // 5s
  ];
  const d = computeExecutionDurations(makeTask(), events, []);
  assert.equal(d.validationMs, 15 * 1000);
});

test("computeExecutionDurations: waitingForHumanReviewMs spans from TASK_MOVED_TO_REVIEW to the human's response", () => {
  const events = [
    makeEvent({ type: "TASK_MOVED_TO_REVIEW", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeEvent({ type: "HUMAN_REVIEW_CHANGES_REQUESTED", createdAt: "2026-01-01T02:00:00.000Z" }), // 2h later
  ];
  const d = computeExecutionDurations(makeTask({ status: "WORKING" }), events, []);
  assert.equal(d.waitingForHumanReviewMs, 2 * 60 * 60 * 1000);
});

test("computeExecutionDurations: waitingForHumanReviewMs is null if the task never reached REVIEW", () => {
  const d = computeExecutionDurations(makeTask({ status: "WORKING" }), [], []);
  assert.equal(d.waitingForHumanReviewMs, null);
});

test("computeExecutionDurations: waitingForHumanReviewMs falls back to task.completedAt when the task finished with no explicit human-response event (e.g. accepted)", () => {
  const events = [makeEvent({ type: "TASK_MOVED_TO_REVIEW", createdAt: "2026-01-01T00:00:00.000Z" })];
  const task = makeTask({ status: "DONE", completedAt: "2026-01-01T00:30:00.000Z" });
  const d = computeExecutionDurations(task, events, []);
  assert.equal(d.waitingForHumanReviewMs, 30 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// deriveFailureContext
// ---------------------------------------------------------------------------

test("deriveFailureContext: null for any non-FAILED task", () => {
  assert.equal(deriveFailureContext(makeTask({ status: "REVIEW" }), [], []), null);
  assert.equal(deriveFailureContext(makeTask({ status: "WORKING" }), [], []), null);
  assert.equal(deriveFailureContext(makeTask({ status: "CANCELLED" }), [], []), null);
});

test("deriveFailureContext: identifies the failed run, its attempt number, and the stage from the real preceding event", () => {
  const events = [
    makeEvent({ id: "e1", type: "AGENT_STARTED", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeEvent({ id: "e2", type: "AGENT_FAILED", createdAt: "2026-01-01T00:00:05.000Z" }),
    makeEvent({ id: "e3", type: "TASK_FAILED", createdAt: "2026-01-01T00:00:06.000Z", payload: { error: "engine failed" } }),
  ];
  const runs = [makeRun({ attemptNumber: 3, status: "failed", result: null, error: "engine failed" })];
  const ctx = deriveFailureContext(makeTask({ status: "FAILED" }), events, runs);
  assert.ok(ctx);
  assert.equal(ctx!.stage, "Agent invocation");
  assert.equal(ctx!.failedRole, "implementer");
  assert.equal(ctx!.attemptNumber, 3);
  assert.equal(ctx!.recoveredFromCrash, false);
});

test("deriveFailureContext: recoveredFromCrash is true whenever any AgentRun was ever left interrupted, even if a later attempt is what actually failed", () => {
  const events = [makeEvent({ type: "TASK_FAILED", createdAt: "2026-01-01T00:01:00.000Z", payload: { error: "still failing" } })];
  const runs = [
    makeRun({ id: "r1", attemptNumber: 1, status: "interrupted", result: null, completedAt: null }),
    makeRun({ id: "r2", attemptNumber: 2, status: "failed", result: null, error: "still failing" }),
  ];
  const ctx = deriveFailureContext(makeTask({ status: "FAILED" }), events, runs);
  assert.ok(ctx);
  assert.equal(ctx!.recoveredFromCrash, true);
  assert.equal(ctx!.attemptNumber, 2, "the run that actually failed, not the interrupted one");
});

// ---------------------------------------------------------------------------
// buildTaskReport integration — backward compatibility + wiring
// ---------------------------------------------------------------------------

test("buildTaskReport: existing fields are completely unchanged, new fields are additive", () => {
  const task = makeTask({ status: "REVIEW" });
  const runs = [makeRun(), makeRun({ id: "r2", role: "reviewer" })];
  const events = [
    makeEvent({ type: "COMMIT_CREATED", payload: { commitSha: "abc123", branch: "task/abc12345", changedFiles: ["add.js"] } }),
    makeEvent({ type: "TASK_MOVED_TO_REVIEW" }),
  ];
  const report = buildTaskReport(task, runs, events, "main");

  // Existing shape untouched.
  assert.equal(report.title, "Fix add()");
  assert.equal(report.whatChanged, "Fixed add() to return the sum.");
  assert.equal(report.filesChanged, 1);
  assert.equal(report.status, "Ready for review");

  // New fields present and correctly wired.
  assert.equal(report.agentRuns.length, 2);
  assert.equal(report.agentRuns[0]!.role, "implementer");
  assert.equal(report.agentRuns[1]!.role, "reviewer");
  assert.equal(report.recoveredFromCrash, false);
  assert.equal(report.failureContext, null);
  assert.equal(typeof report.durations, "object");
});

// See PLATFORM_GAPS.md GAP-024: "filesChanged" must be the platform's own git evidence, never the
// coding engine's self-reported StepResult.filesChanged — the two are deliberately made to
// disagree here so a regression that reads the wrong source is caught immediately.
test("GAP-024: buildTaskReport.filesChanged comes from the platform's COMMIT_CREATED evidence, not the implementer's self-reported StepResult.filesChanged", () => {
  const task = makeTask({ status: "REVIEW" });
  // The implementer's own StepResult claims one file (see makeRun's default: filesChanged: ["add.js"]).
  const runs = [makeRun()];
  const events = [
    makeEvent({
      type: "COMMIT_CREATED",
      payload: { commitSha: "abc123", branch: "task/abc12345", changedFiles: ["add.js", "add.test.js", "README.md"] },
    }),
  ];
  const report = buildTaskReport(task, runs, events, "main");

  assert.equal(report.filesChanged, 3, "must reflect the 3 files git evidence shows, not the implementer's claimed 1");
  assert.deepEqual(report.gitEvidence.changedFiles, ["add.js", "add.test.js", "README.md"]);
  assert.equal(report.gitEvidence.commitSha, "abc123");
  assert.equal(report.gitEvidence.branch, "task/abc12345");
});

test("GAP-024/GAP-004: buildTaskReport carries no git or validation evidence, and validationOutcome is honestly null, when no such event has ever fired", () => {
  const task = makeTask({ status: "WORKING" });
  const report = buildTaskReport(task, [], [], "main");

  assert.equal(report.filesChanged, 0);
  assert.deepEqual(report.gitEvidence, { branch: null, changedFiles: [], commitSha: null, pushedCommitSha: null, remoteBranchSha: null });
  assert.equal(report.validationOutcome, null);
  assert.equal(report.reviewVerificationMethod, null);
});

test("GAP-004: buildTaskReport.validationOutcome distinguishes 'no checks configured' from a genuine pass, even though both are ValidationResult.status === \"passed\"", () => {
  const task = makeTask({ status: "REVIEW" });
  const noCommandsReport = buildTaskReport(
    task,
    [],
    [makeEvent({ type: "VALIDATION_COMPLETED", payload: { status: "passed", outcome: "no_checks_configured", checks: [] } })],
    "main",
  );
  assert.equal(noCommandsReport.validationOutcome, "no_checks_configured");

  const realPassReport = buildTaskReport(
    task,
    [],
    [
      makeEvent({
        type: "VALIDATION_COMPLETED",
        payload: { status: "passed", outcome: "checks_passed", checks: [{ name: "test", passed: true, outcome: "passed" }] },
      }),
    ],
    "main",
  );
  assert.equal(realPassReport.validationOutcome, "checks_passed");
});

test("GAP-016: buildTaskReport.reviewVerificationMethod reflects the Reviewer's own declared method, defaulting to 'unknown' rather than assuming thoroughness", () => {
  const task = makeTask({ status: "REVIEW" });
  const executed = buildTaskReport(
    task,
    [],
    [makeEvent({ type: "REVIEW_COMPLETED", payload: { verdict: "approved", findings: [], verificationMethod: "executed" } })],
    "main",
  );
  assert.equal(executed.reviewVerificationMethod, "executed");

  const unstated = buildTaskReport(
    task,
    [],
    [makeEvent({ type: "REVIEW_COMPLETED", payload: { verdict: "approved", findings: [] } })],
    "main",
  );
  assert.equal(unstated.reviewVerificationMethod, null, "an event predating this convention must not be read as 'executed'");
});

test("buildTaskReport: a cancelled task's report carries no failureContext and no fabricated durations", () => {
  const task = makeTask({ status: "CANCELLED", completedAt: "2026-01-01T00:05:00.000Z" });
  const report = buildTaskReport(task, [], [], "main");
  assert.equal(report.failureContext, null);
  assert.equal(report.recoveredFromCrash, false);
  assert.equal(report.agentRuns.length, 0);
});
