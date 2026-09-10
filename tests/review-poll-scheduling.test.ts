import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type BuildPlatformOptions } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { FakeSourceControlProvider } from "./helpers/fake-source-control-provider.js";
import { GitHubAuthError, GitHubRateLimitError } from "../src/integrations/github/errors.js";
import { Worker } from "../src/worker/worker.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { Project, StepResult } from "../src/domain/types.js";

/**
 * "GitHub Review Polling Hardening" (follow-up to Phase 2): proves that
 * Worker.tick() no longer calls Orchestrator.checkHumanReviewFeedback (and
 * therefore never calls GitHub) for a REVIEW task whose next scheduled check
 * (`tasks.next_review_check_at`) isn't due yet, that exactly one of two
 * racing worker processes ever wins a due check, and that a rate-limited or
 * auth-failed GitHub read defers the next check instead of being retried
 * every tick. See /docs/TASK_LIFECYCLE.md "REVIEW polling" and
 * migrations/010_review_poll_scheduling.sql.
 *
 * Orchestrator.checkHumanReviewFeedback itself is deliberately NOT touched by
 * this milestone — every existing test in tests/human-review-feedback.test.ts
 * that calls it directly bypasses the new Worker-level gate entirely and
 * keeps passing unmodified. These tests exercise the gate itself, always via
 * Worker.tick() (the only call site the gate applies to), or via
 * TaskRepository.claimReviewCheck directly for the lowest-level race proof.
 */

const CORRECT_ADD = `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`;

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

async function setupPlatform(label: string, scProvider: FakeSourceControlProvider, extra: Partial<BuildPlatformOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), `review-poll-${label}-`));
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: approvingReviewerHandler });
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    additionalSourceControlProviders: [scProvider],
    ...extra,
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
  return { platform, project, root, dbPath: join(root, "platform.sqlite"), workspacesRoot: join(root, "workspaces"), engine };
}

function makeTask(platform: Awaited<ReturnType<typeof setupPlatform>>["platform"], project: Project) {
  return createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

async function driveToReview(platform: Awaited<ReturnType<typeof setupPlatform>>["platform"], project: Project) {
  const task = makeTask(platform, project);
  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest);
  return result;
}

// ---------------------------------------------------------------------------
// 1-2. Not due yet -> zero GitHub calls; due -> real check happens
// ---------------------------------------------------------------------------

test("a REVIEW task is not re-checked on every worker tick: a second tick before REVIEW_POLL_INTERVAL_MS elapses makes zero additional GitHub calls", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("not-due", scProvider);
  await driveToReview(platform, project);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: 30_000 });
  await worker.tick();
  assert.equal(scProvider.statusCalls.length, 1, "first tick after reaching REVIEW performs the initial check");

  await worker.tick();
  await worker.tick();
  assert.equal(scProvider.statusCalls.length, 1, "immediately-following ticks must not call GitHub again before the interval elapses");
});

test("review polling respects REVIEW_POLL_INTERVAL_MS: a due check after the interval elapses does call GitHub again", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("respects-interval", scProvider);
  await driveToReview(platform, project);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: 20 });
  await worker.tick();
  assert.equal(scProvider.statusCalls.length, 1);

  await new Promise((r) => setTimeout(r, 40));
  await worker.tick();
  assert.equal(scProvider.statusCalls.length, 2, "once the short interval has genuinely elapsed, the next tick checks GitHub again");
});

// ---------------------------------------------------------------------------
// 3-4. Cross-worker race: exactly one caller wins a due check, the loser makes zero calls
// ---------------------------------------------------------------------------

test("two workers racing the same due REVIEW task: exactly one calls GitHub, the other makes zero calls", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const root = await mkdtemp(join(tmpdir(), "review-poll-race-"));
  const dbPath = join(root, "platform.sqlite");
  const workspacesRoot = join(root, "workspaces");
  const engine = new FixtureCodingEngine({ implementer: implementerHandler, reviewer: approvingReviewerHandler });
  const buildOpts: BuildPlatformOptions = { dbPath, workspacesRoot, engine, additionalSourceControlProviders: [scProvider] };
  const platformA = buildPlatform({ ...buildOpts, ownerId: "race-worker-A" });
  const platformB = buildPlatform({ ...buildOpts, ownerId: "race-worker-B" });

  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "race@example.com", name: "Tester", passwordHash: "", createdAt: now };
  platformA.users.insert(user);
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
  platformA.projects.insert(project);

  const task = await driveToReview(platformA, project);
  // task is REVIEW with next_review_check_at still NULL (never checked) — both workers' next tick sees it as due.
  assert.equal(platformA.tasks.findById(task.id)!.nextReviewCheckAt, null);

  const workerA = new Worker(platformA.tasks, platformA.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: 30_000 });
  const workerB = new Worker(platformB.tasks, platformB.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: 30_000 });

  await Promise.all([workerA.tick(), workerB.tick()]);

  assert.equal(scProvider.statusCalls.length, 1, "only one of the two racing workers actually called GitHub — the other's claim lost and it never called checkHumanReviewFeedback at all");

  const after = platformA.tasks.findById(task.id)!;
  assert.ok(after.nextReviewCheckAt, "the winner's claim advanced the schedule");
});

// ---------------------------------------------------------------------------
// 5. Schedule advances by roughly REVIEW_POLL_INTERVAL_MS after a refresh
// ---------------------------------------------------------------------------

test("after a refresh, next_review_check_at advances by roughly REVIEW_POLL_INTERVAL_MS", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("advances-schedule", scProvider);
  const created = await driveToReview(platform, project);

  const intervalMs = 30_000;
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: intervalMs });
  const before = Date.now();
  await worker.tick();
  const after = Date.now();

  const task = platform.tasks.findById(created.id)!;
  assert.ok(task.nextReviewCheckAt);
  const scheduledMs = new Date(task.nextReviewCheckAt!).getTime();
  assert.ok(scheduledMs >= before + intervalMs - 1000, "scheduled at least ~intervalMs out");
  assert.ok(scheduledMs <= after + intervalMs + 1000, "scheduled roughly intervalMs out, not further");
});

// ---------------------------------------------------------------------------
// 6. Rate limit backs off further than the normal interval
// ---------------------------------------------------------------------------

test("a rate-limited GitHub response defers the next REVIEW check beyond the normal interval, honoring the suggested wait", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("rate-limited", scProvider);
  const task = await driveToReview(platform, project);

  const intervalMs = 5_000;
  const suggestedDelayMs = 60_000; // much longer than intervalMs
  scProvider.failNextCallToStatus(new GitHubRateLimitError(new Date(Date.now() + suggestedDelayMs), suggestedDelayMs));

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: intervalMs });
  const before = Date.now();
  await worker.tick();

  assert.equal(scProvider.statusCalls.length, 1);
  const after = platform.tasks.findById(task.id)!;
  const scheduledMs = new Date(after.nextReviewCheckAt!).getTime();
  assert.ok(
    scheduledMs >= before + suggestedDelayMs - 1000,
    `expected next check pushed out by ~${suggestedDelayMs}ms (rate limit's own suggested wait), not just the normal ${intervalMs}ms interval`,
  );

  // And a tick shortly after (well before the extended backoff, but after the normal interval)
  // must NOT call GitHub again — proves it's not just retried on the very next normal cadence.
  await new Promise((r) => setTimeout(r, intervalMs + 50));
  await worker.tick();
  assert.equal(scProvider.statusCalls.length, 1, "still rate-limit-deferred — must not retry at the normal interval");
});

// ---------------------------------------------------------------------------
// 7. Auth failure: surfaced, never DONE, and does not hammer every tick
// ---------------------------------------------------------------------------

test("an auth failure reading PR status is surfaced via SOURCE_CONTROL_FAILED, never marks the task DONE, and is not retried on the very next tick", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("auth-failure", scProvider);
  const task = await driveToReview(platform, project);
  scProvider.failNextCallToStatus(new GitHubAuthError());

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: 30_000 });
  await worker.tick();

  assert.equal(scProvider.statusCalls.length, 1);
  const afterFailure = platform.tasks.findById(task.id)!;
  assert.equal(afterFailure.status, "REVIEW", "an auth failure must never cause a false DONE");
  const events = platform.taskEvents.listForTask(task.id);
  assert.ok(events.some((e) => e.type === "SOURCE_CONTROL_FAILED" && e.payload.step === "check_pull_request_status"));

  // Immediately-following tick: the claim already deferred the schedule by a full
  // reviewPollIntervalMs, so this must not hammer GitHub again right away.
  await worker.tick();
  assert.equal(scProvider.statusCalls.length, 1, "auth failure must not be retried on the very next tick");
});

// ---------------------------------------------------------------------------
// 8. Regression: PR-merged detection still reaches DONE through the new gate
// ---------------------------------------------------------------------------

test("a merged PR is still detected and completes the task to DONE through the new Worker-level gate", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("merge-still-works", scProvider);
  const task = await driveToReview(platform, project);
  scProvider.setPullRequestState(task.taskRecord.branchName!, "merged");

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, reviewPollIntervalMs: 30_000 });
  await worker.tick();

  const result = platform.tasks.findById(task.id)!;
  assert.equal(result.status, "DONE", "the merge is still detected through the new due-check gate on its first eligible tick");
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("PULL_REQUEST_MERGED"));
});

// ---------------------------------------------------------------------------
// Low-level: claimReviewCheck itself is the atomic guard (mirrors claimTodo's own test style)
// ---------------------------------------------------------------------------

test("claimReviewCheck is atomic: only one of two racing claims for the same due task wins", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("claim-atomic", scProvider);
  const task = await driveToReview(platform, project);

  const now = new Date().toISOString();
  const nextCheckAt = new Date(Date.now() + 30_000).toISOString();
  const [wonA, wonB] = await Promise.all([
    Promise.resolve(platform.tasks.claimReviewCheck(task.id, now, nextCheckAt)),
    Promise.resolve(platform.tasks.claimReviewCheck(task.id, now, nextCheckAt)),
  ]);
  assert.equal(wonA !== wonB, true, "exactly one of the two claims must win");

  const row = platform.tasks.findById(task.id)!;
  assert.equal(row.nextReviewCheckAt, nextCheckAt);
});

test("claimReviewCheck never wins for a task not yet due", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const { platform, project } = await setupPlatform("claim-not-due", scProvider);
  const task = await driveToReview(platform, project);

  const now = new Date().toISOString();
  const farFuture = new Date(Date.now() + 60_000).toISOString();
  assert.equal(platform.tasks.claimReviewCheck(task.id, now, farFuture), true, "first claim (never checked before) wins");
  assert.equal(platform.tasks.claimReviewCheck(task.id, now, farFuture), false, "immediately re-claiming before the scheduled time fails");
});
