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
import { FakeSourceControlProvider } from "./helpers/fake-source-control-provider.js";
import { CancellationError } from "../src/domain/errors.js";
import { GitHubAuthError, GitHubRateLimitError } from "../src/integrations/github/errors.js";
import { Worker } from "../src/worker/worker.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { HumanReviewFeedbackItem, Project, StepResult } from "../src/domain/types.js";

const CORRECT_ADD = `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`;

async function setupPlatform(label: string) {
  const root = await mkdtemp(join(tmpdir(), `human-review-${label}-`));
  const scProvider = new FakeSourceControlProvider("github");
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: approvingReviewerHandler });
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    additionalSourceControlProviders: [scProvider],
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
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  return { platform, project, scProvider, root };
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

/** Always produces a correct, passing implementation regardless of what triggered this pass. */
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

/** Always approves — isolates human-feedback-loop behavior from AI-reviewer behavior. */
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

/** Drives a task all the way to REVIEW with a real (fake) PR opened, ready for human feedback tests. */
async function driveToReview(platform: Platform, project: Project) {
  const task = makeTask(platform, project);
  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest);
  return result;
}

function changesRequestedItem(overrides: Partial<HumanReviewFeedbackItem> = {}): HumanReviewFeedbackItem {
  return {
    id: "review:1",
    kind: "review",
    verdict: "changes_requested",
    body: "Please add a doc comment explaining the edge cases.",
    authorLogin: "human-reviewer",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Human approval — stays REVIEW, no fix cycle, no auto-merge
// ---------------------------------------------------------------------------

test("human PR review approved: task stays REVIEW, no fix cycle, no new terminal state", async () => {
  const { platform, project, scProvider } = await setupPlatform("approved");
  const task = await driveToReview(platform, project);

  scProvider.setPullRequestFeedback(task.taskRecord.branchName!, [
    { id: "review:1", kind: "review", verdict: "approved", body: "LGTM", authorLogin: "human-reviewer", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW", "never auto-merges, never invents a new terminal state");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("HUMAN_REVIEW_DETECTED"));
  assert.ok(events.includes("HUMAN_REVIEW_APPROVED"));
  assert.ok(!events.includes("HUMAN_REVIEW_CHANGES_REQUESTED"), "an approval must never trigger a fix cycle");

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 1, "only the original implementer run — no fix pass triggered");
});

// ---------------------------------------------------------------------------
// 2-4, 13. CHANGES_REQUESTED → implementer runs again, feedback reaches it, full fix cycle, correct events
// ---------------------------------------------------------------------------

test("human review requests changes: same workspace/branch, feedback reaches implementer, full fix -> validate -> commit -> push -> REVIEW", async () => {
  const { platform, project, scProvider } = await setupPlatform("changes-requested");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;

  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW");
  assert.equal(result.taskRecord.branchName, branch, "same branch reused");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  const idx = events.indexOf("PULL_REQUEST_CREATED"); // marks the end of the original pipeline
  const afterOriginal = events.slice(idx + 1);
  assert.deepEqual(afterOriginal, [
    "TASK_MOVED_TO_REVIEW", // from the original approved pipeline
    "HUMAN_REVIEW_DETECTED",
    "HUMAN_REVIEW_CHANGES_REQUESTED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "VALIDATION_STARTED",
    "VALIDATION_COMPLETED",
    "COMMIT_CREATED",
    "BRANCH_PUSHED",
    "TASK_MOVED_TO_REVIEW",
  ]);

  const runs = platform.agentRuns.listForTask(task.id);
  const implementerRuns = runs.filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 2, "original + one human-feedback fix pass");
  assert.equal(implementerRuns[1]!.attemptNumber, 2);
  assert.equal(implementerRuns[1]!.status, "completed");

  // Point 4: distinguishable from the original task requirements, AI reviewer feedback, and
  // validation failures — via its own ContextBundle field, not buried in generic prior decisions.
  const fixContext = implementerRuns[1]!.input;
  assert.equal(fixContext.lastFailure, null);
  assert.equal(fixContext.reviewerFeedback, null);
  assert.ok(fixContext.humanReviewFeedback);
  assert.equal(fixContext.humanReviewFeedback!.reviewerLogin, "human-reviewer");
  assert.ok(fixContext.humanReviewFeedback!.comments.includes("doc comment"));
});

// ---------------------------------------------------------------------------
// 5-8. PR / branch / workspace reuse — never duplicated
// ---------------------------------------------------------------------------

test("PR, branch, and workspace are all reused across a human feedback cycle — never duplicated", async () => {
  const { platform, project, scProvider } = await setupPlatform("no-duplicates");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  const workspaceBefore = platform.workspaces.findByTaskId(task.id);

  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);
  await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(scProvider.pullRequestsCreated, 1, "still exactly one PR");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1);

  const workspaceAfter = platform.workspaces.findByTaskId(task.id);
  assert.equal(workspaceAfter!.id, workspaceBefore!.id, "same workspace row, never re-provisioned");
  assert.equal(workspaceAfter!.branch, branch);
});

// ---------------------------------------------------------------------------
// 9. Idempotency — the same GitHub feedback never triggers a second fix cycle
// ---------------------------------------------------------------------------

test("duplicate GitHub feedback is ignored: calling checkHumanReviewFeedback again with the same items is a safe no-op", async () => {
  const { platform, project, scProvider } = await setupPlatform("idempotent");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;

  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);

  await platform.orchestrator.checkHumanReviewFeedback(task.id);
  const afterFirst = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer").length;
  assert.equal(afterFirst, 2);

  // Same feedback set is still "returned by GitHub" on a repeated poll (nothing new was submitted).
  const second = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  const afterSecond = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer").length;

  assert.equal(afterSecond, afterFirst, "no second fix cycle for feedback already processed");
  assert.equal(second.status, "REVIEW");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "HUMAN_REVIEW_CHANGES_REQUESTED").length, 1);

  // A third poll via the exact same public entrypoint the worker itself uses — also a no-op.
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  await worker.tick();
  const afterTick = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer").length;
  assert.equal(afterTick, afterFirst, "worker polling a REVIEW task with already-processed feedback changes nothing");
});

// ---------------------------------------------------------------------------
// 10. Multiple human review/fix cycles
// ---------------------------------------------------------------------------

test("multiple human review/fix cycles: a second round of changes-requested after the first fix runs another cycle", async () => {
  const { platform, project, scProvider } = await setupPlatform("multi-cycle");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;

  scProvider.setPullRequestFeedback(branch, [changesRequestedItem({ id: "review:1" })]);
  const afterFirst = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(afterFirst.status, "REVIEW");

  // A second, later review requesting more changes — a fresh id, so it's genuinely new.
  scProvider.setPullRequestFeedback(branch, [
    changesRequestedItem({ id: "review:1" }),
    changesRequestedItem({ id: "review:2", body: "Also add a test for negative numbers.", updatedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" }),
  ]);
  const afterSecond = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(afterSecond.status, "REVIEW");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "HUMAN_REVIEW_CHANGES_REQUESTED").length, 2);

  const implementerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 3, "original + two human-feedback fix passes");
  assert.deepEqual(implementerRuns.map((r) => r.attemptNumber), [1, 2, 3]);

  // Still exactly one PR and one workspace across both cycles.
  assert.equal(scProvider.pullRequestsCreated, 1);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
});

// ---------------------------------------------------------------------------
// 11. Multiple comments/reviews handled correctly
// ---------------------------------------------------------------------------

test("multiple comments alongside a changes-requested review are folded into the implementer's feedback and all marked processed", async () => {
  const { platform, project, scProvider } = await setupPlatform("multi-comment");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;

  scProvider.setPullRequestFeedback(branch, [
    changesRequestedItem({ id: "review:1", body: "Please handle the empty-array case." }),
    { id: "comment:1", kind: "comment", verdict: null, body: "Also, can you rename the variable?", authorLogin: "human-reviewer", createdAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" },
    { id: "comment:2", kind: "comment", verdict: null, body: "Thanks for the quick turnaround!", authorLogin: "other-person", createdAt: "2026-01-01T00:02:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z" },
  ]);

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(result.status, "REVIEW");

  const implementerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  const feedback = implementerRuns[1]!.input.humanReviewFeedback!;
  assert.ok(feedback.comments.includes("empty-array"));
  assert.ok(feedback.comments.includes("rename the variable"));
  assert.ok(feedback.comments.includes("quick turnaround"));

  assert.deepEqual(
    [...result.taskRecord.processedHumanFeedbackIds].sort(),
    ["comment:1", "comment:2", "review:1"],
    "every new item is marked processed, not just the actionable review",
  );
});

// ---------------------------------------------------------------------------
// 12, 14. Cancellation during a human feedback cycle
// ---------------------------------------------------------------------------

test("cancellation during the human-feedback fix pass stops the cycle cleanly — CANCELLED, no commit/push/return-to-review", async () => {
  let platformRef: Platform;
  const taskIdHolder: { id: string } = { id: "" };
  let implementerCallCount = 0;
  const implementerThatCancelsOnHumanFeedback = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCallCount += 1;
    if (request.context.humanReviewFeedback) {
      await platformRef.orchestrator.requestCancellation(taskIdHolder.id, "tester");
      throw new CancellationError();
    }
    return implementerHandler(request);
  };
  const root = await mkdtemp(join(tmpdir(), "human-review-cancel-"));
  const scProvider = new FakeSourceControlProvider("github");
  const engine = new FixtureCodingEngine({ implementer: implementerThatCancelsOnHumanFeedback, reviewer: approvingReviewerHandler });
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: "test-worker-cancel",
    additionalSourceControlProviders: [scProvider],
  });
  platformRef = platform;
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "cancel@example.com", name: "Tester", passwordHash: "", createdAt: now };
  platform.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);

  const task = await driveToReview(platform, project);
  taskIdHolder.id = task.id;
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "CANCELLED");
  assert.equal(implementerCallCount, 2, "original implementer ran, human-feedback fix pass started then cancelled");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("HUMAN_REVIEW_CHANGES_REQUESTED"));
  assert.ok(!events.filter((t) => t === "TASK_MOVED_TO_REVIEW")[1], "must not have returned to REVIEW after cancellation");
  // Only the ORIGINAL commit/push (before human feedback) — the fix pass never reached commit/push.
  assert.equal(events.filter((t) => t === "COMMIT_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "BRANCH_PUSHED").length, 1);
});

// ---------------------------------------------------------------------------
// 15. Feedback scoped to the correct task/PR
// ---------------------------------------------------------------------------

test("feedback is scoped to the task's own PR: another task's scripted feedback never leaks in", async () => {
  const { platform, project, scProvider } = await setupPlatform("scoped");
  const taskA = await driveToReview(platform, project);
  const taskB = await driveToReview(platform, project);
  assert.notEqual(taskA.taskRecord.branchName, taskB.taskRecord.branchName);

  // Only task A's branch/PR gets scripted feedback.
  scProvider.setPullRequestFeedback(taskA.taskRecord.branchName!, [changesRequestedItem()]);

  const resultB = await platform.orchestrator.checkHumanReviewFeedback(taskB.id);
  assert.equal(resultB.status, "REVIEW");
  const eventsB = platform.taskEvents.listForTask(taskB.id).map((e) => e.type);
  assert.ok(!eventsB.includes("HUMAN_REVIEW_DETECTED"), "task B must never see task A's PR feedback");

  const resultA = await platform.orchestrator.checkHumanReviewFeedback(taskA.id);
  assert.equal(resultA.status, "REVIEW");
  const eventsA = platform.taskEvents.listForTask(taskA.id).map((e) => e.type);
  assert.ok(eventsA.includes("HUMAN_REVIEW_CHANGES_REQUESTED"), "task A does see its own feedback");
});

// ---------------------------------------------------------------------------
// 16-17. Existing AI reviewer self-correction and approved path remain unchanged
// ---------------------------------------------------------------------------

test("checkHumanReviewFeedback is a no-op for tasks that are not REVIEW (e.g. still WORKING, or REVIEW with no PR)", async () => {
  const { platform, project } = await setupPlatform("non-review");
  const task = makeTask(platform, project); // still TODO — never executed

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(result.status, "TODO");
  assert.equal(platform.taskEvents.listForTask(task.id).length, 1, "only TASK_CREATED — no human-review machinery touched an unexecuted task");
});

test("existing AI-reviewer-approved path is unaffected when no human GitHub feedback exists yet", async () => {
  const { platform, project } = await setupPlatform("approved-path-unaffected");
  const task = await driveToReview(platform, project);
  const eventsBefore = platform.taskEvents.listForTask(task.id).map((e) => e.type);

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id); // no feedback scripted at all

  assert.equal(result.status, "REVIEW");
  const eventsAfter = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.deepEqual(eventsAfter, eventsBefore, "polling with nothing new to report changes nothing");
});

// ---------------------------------------------------------------------------
// 18-19. PR state handling: merged / closed PRs are never actionable
// ---------------------------------------------------------------------------

test("a merged PR's feedback is never processed — no fix cycle, task completes to DONE, no accidental re-run of implementation", async () => {
  const { platform, project, scProvider } = await setupPlatform("merged-pr");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);
  scProvider.setPullRequestState(branch, "merged");

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  // PR-merge sync (see /docs/TASK_LIFECYCLE.md "PR merge sync"): a merged PR is a real, final
  // acceptance signal — the task completes to DONE — but never via re-running implementation off a
  // stray review that happens to exist on the now-merged PR.
  assert.equal(result.status, "DONE", "a merged PR completes the task — closing the REVIEW->DONE sync gap");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("HUMAN_REVIEW_DETECTED"));
  assert.ok(!events.includes("HUMAN_REVIEW_CHANGES_REQUESTED"));
  assert.ok(events.includes("PULL_REQUEST_MERGED"), "the merge is recorded in the task's own activity/event timeline");
  const implementerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 1, "only the original pass — no fix cycle was triggered");
});

test("a closed (not merged) PR's feedback is never processed either", async () => {
  const { platform, project, scProvider } = await setupPlatform("closed-pr");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);
  scProvider.setPullRequestState(branch, "closed");

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW");
  const implementerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 1);
});

test("once a PR is merged, a later worker poll completes the task to DONE and never re-triggers implementation", async () => {
  const { platform, project, scProvider } = await setupPlatform("merged-pr-worker-poll");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  await worker.tick();

  const result = platform.tasks.findById(task.id)!;
  assert.equal(result.status, "DONE", "the worker's own existing REVIEW poll is what detects the merge — no second poller was added");
  const implementerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 1);
});

// ---------------------------------------------------------------------------
// PR merge sync — the REVIEW -> DONE gap this milestone closes.
// See /docs/TASK_LIFECYCLE.md "PR merge sync" and /docs/GITHUB_INTEGRATION.md "PR state handling".
// ---------------------------------------------------------------------------

test("REVIEW task + OPEN PR: remains REVIEW, no completion event", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-open");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "open");

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("PULL_REQUEST_MERGED"));
});

test("REVIEW task + MERGED PR: becomes DONE, records PULL_REQUEST_MERGED with the PR's own number/url, preserves the PR reference", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-merged");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  const prBefore = task.taskRecord.pullRequest!;
  scProvider.setPullRequestState(branch, "merged");

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "DONE");
  assert.ok(result.completedAt, "completedAt is set on the PR-merge completion path, same as manual accept");
  assert.deepEqual(result.taskRecord.pullRequest, prBefore, "the PR reference itself is preserved, never cleared or mutated");
  const events = platform.taskEvents.listForTask(task.id);
  const merged = events.find((e) => e.type === "PULL_REQUEST_MERGED");
  assert.ok(merged);
  assert.equal(merged!.payload.number, prBefore.number);
  assert.equal(merged!.payload.url, prBefore.url);
});

test("REVIEW task + CLOSED-not-merged PR: does NOT become DONE, stays REVIEW, no completion event, no new TaskStatus was invented", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-closed");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "closed");

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW", "closed-without-merge is never treated as completion");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("PULL_REQUEST_MERGED"));
  assert.ok(!events.includes("TASK_COMPLETED"));
});

test("already-DONE task + merged PR: no duplicate transition, no duplicate PULL_REQUEST_MERGED event (idempotent across repeated polls)", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-idempotent");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");

  const first = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(first.status, "DONE");
  const completedAtAfterFirst = first.completedAt;

  const second = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  const third = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(second.status, "DONE");
  assert.equal(third.status, "DONE");
  assert.equal(second.completedAt, completedAtAfterFirst, "completedAt is not rewritten by a repeated poll");
  const mergedEvents = platform.taskEvents.listForTask(task.id).filter((e) => e.type === "PULL_REQUEST_MERGED");
  assert.equal(mergedEvents.length, 1, "repeated detection of an already-merged PR is harmless — no duplicate finalization/events");
});

test("worker restart/recovery: a merge that happened while the platform was offline is still detected and completes the task on the next poll", async () => {
  // Simulates "must work after API/worker restart or crash" (requirement 3): nothing special is
  // persisted while offline — the task simply sits in REVIEW with its PR, and the very next poll of
  // a freshly constructed Worker/Orchestrator pair (a stand-in for a fresh process) discovers the
  // merge exactly the same way a live one would, because the check is stateless (reads GitHub's own
  // current PR state, not anything the platform itself tracked before "restarting").
  const { platform, project, scProvider } = await setupPlatform("sync-restart");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged"); // merge "happened" while nothing was polling

  const workerAfterRestart = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  await workerAfterRestart.tick();

  const result = platform.tasks.findById(task.id)!;
  assert.equal(result.status, "DONE", "the next appropriate poll after a restart eventually detects an already-merged PR");
});

test("multiple workers/pollers racing the same merged PR: only one finalizes, no double PULL_REQUEST_MERGED event", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-race-multi-worker");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");

  // Two "processes" (no shared in-memory state, both racing the same atomic DB-level guard) observe
  // the same merged PR at effectively the same time.
  const [a, b] = await Promise.all([
    platform.orchestrator.checkHumanReviewFeedback(task.id),
    platform.orchestrator.checkHumanReviewFeedback(task.id),
  ]);

  assert.equal(a.status, "DONE");
  assert.equal(b.status, "DONE");
  const mergedEvents = platform.taskEvents.listForTask(task.id).filter((e) => e.type === "PULL_REQUEST_MERGED");
  assert.equal(mergedEvents.length, 1, "TaskRepository.finalizeReviewAsDoneOnMerge's atomic UPDATE guard lets only one caller actually finalize");
});

test("GitHub transient error reading PR status: task stays REVIEW, no SOURCE_CONTROL_FAILED event, next poll retries normally", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-transient-error");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");
  scProvider.failNextCallToStatus(new Error("fetch failed: socket hang up"));

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(result.status, "REVIEW", "a transient failure reading PR status must never fail the task or falsely mark it DONE");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("SOURCE_CONTROL_FAILED"));
  assert.ok(!events.includes("PULL_REQUEST_MERGED"));

  const retried = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(retried.status, "DONE", "the very next poll (no failure scripted) picks the merge up normally");
});

test("GitHub rate limit reading PR status: existing rate-limit behavior respected (silent, retried, never a false DONE)", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-rate-limit");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");
  scProvider.failNextCallToStatus(new GitHubRateLimitError(new Date(Date.now() + 1000), 1000));

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(result.status, "REVIEW");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("SOURCE_CONTROL_FAILED"), "a rate limit is expected to self-heal — no permanent audit-trail entry");
  assert.ok(!events.includes("PULL_REQUEST_MERGED"));
});

test("GitHub auth failure reading PR status: surfaced via SOURCE_CONTROL_FAILED, task must NOT incorrectly become DONE", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-auth-failure");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");
  scProvider.failNextCallToStatus(new GitHubAuthError());

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(result.status, "REVIEW", "an auth failure must never be treated as if the PR were confirmed merged");
  const events = platform.taskEvents.listForTask(task.id);
  const failure = events.find((e) => e.type === "SOURCE_CONTROL_FAILED");
  assert.ok(failure, "a persistent (non-transient) status-read failure must leave a visible audit-trail entry");
  assert.equal(failure!.payload.step, "check_pull_request_status");
  assert.ok(!events.some((e) => e.type === "PULL_REQUEST_MERGED"));

  // Reconnecting (no failure scripted this time) lets the task recover and complete on its own.
  const recovered = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(recovered.status, "DONE");
});

test("cancellation race: a cancellation requested against a REVIEW task with a merged PR does not corrupt state — cancel is a documented no-op from REVIEW, merge sync still completes it", async () => {
  // REVIEW has no outgoing "cancel" transition (see task-state-machine.ts's own doc comment: nothing
  // is running to interrupt, and discarding an already-reviewed result is a different capability).
  // A cancellation request racing a merge must not produce a contradictory status.
  const { platform, project, scProvider } = await setupPlatform("sync-cancel-race");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestState(branch, "merged");

  await assert.rejects(() => platform.orchestrator.requestCancellation(task.id, "tester"), /Invalid task transition/);

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(result.status, "DONE", "the merge sync still completes the task cleanly; cancellation never partially applied");
});

test("PR merge sync never re-runs implementation and never opens a second PR", async () => {
  const { platform, project, scProvider } = await setupPlatform("sync-no-rerun");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  const pullRequestsBefore = scProvider.pullRequestsCreated;
  scProvider.setPullRequestState(branch, "merged");

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "DONE");
  assert.equal(scProvider.pullRequestsCreated, pullRequestsBefore, "never opens another PR");
  const implementerRuns = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 1, "never re-runs implementation");
});

// ---------------------------------------------------------------------------
// 20-21. GitHub read-failure visibility: transient vs. persistent (auth/permission)
// ---------------------------------------------------------------------------

test("a transient GitHub read failure never fails the task and leaves no permanent audit-trail event — the next poll just retries", async () => {
  const { platform, project, scProvider } = await setupPlatform("transient-read-failure");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);
  // A plain Error (no GitHub-specific type) classifies as retryable_transient — see error-classifier.ts's fallback.
  scProvider.failNextCallToFeedback(new Error("fetch failed: socket hang up"));

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW", "a transient read failure must never fail the task");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("SOURCE_CONTROL_FAILED"), "a transient failure doesn't need a permanent audit-trail entry");

  // The very next poll succeeds normally (no failNextCallToFeedback scripted this time).
  const retried = await platform.orchestrator.checkHumanReviewFeedback(task.id);
  assert.equal(retried.status, "REVIEW");
  const eventsAfterRetry = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(eventsAfterRetry.includes("HUMAN_REVIEW_CHANGES_REQUESTED"), "the retry picks the feedback up normally");
});

test("an auth/permission GitHub read failure is surfaced via the existing SOURCE_CONTROL_FAILED event, without failing the task", async () => {
  const { platform, project, scProvider } = await setupPlatform("auth-read-failure");
  const task = await driveToReview(platform, project);
  const branch = task.taskRecord.branchName!;
  scProvider.setPullRequestFeedback(branch, [changesRequestedItem()]);
  scProvider.failNextCallToFeedback(new GitHubAuthError());

  const result = await platform.orchestrator.checkHumanReviewFeedback(task.id);

  assert.equal(result.status, "REVIEW", "an auth failure is visible, not fatal — a human can reconnect GitHub and the task recovers on its own");
  const events = platform.taskEvents.listForTask(task.id);
  const failure = events.find((e) => e.type === "SOURCE_CONTROL_FAILED");
  assert.ok(failure, "a persistent (non-transient) read failure must leave a visible audit-trail entry");
  assert.equal(failure!.payload.step, "check_review_feedback");
  assert.ok(typeof failure!.payload.error === "string" && !failure!.payload.error.includes("ghp_"), "never leaks a credential into the event");
});
