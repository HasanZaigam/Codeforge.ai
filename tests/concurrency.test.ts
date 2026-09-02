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
import type { OrchestratorConfig } from "../src/orchestrator/config.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { HumanReviewFeedbackItem, Project, StepResult } from "../src/domain/types.js";

/**
 * Worker-concurrency tests: two real Orchestrator instances, different
 * `ownerId`, sharing one sqlite file (WAL mode + busy_timeout) and one
 * workspaces directory — genuinely two DB connections racing, not a mock.
 * See /docs/TASK_LIFECYCLE.md "Worker concurrency and lease loss".
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
  const root = await mkdtemp(join(tmpdir(), `concurrency-${label}-`));
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

const CORRECT_ADD = `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`;

async function correctImplementerResult(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
  await writeFile(join(request.workspacePath, "add.js"), CORRECT_ADD);
  const result: StepResult = { status: "completed", summary: "Fixed.", filesChanged: ["add.js"], diffRef: null, confidence: "high", findings: [], needsInput: null };
  return { result, cost: null, logExcerpt: "" };
}

async function approvingReviewerHandler(): Promise<EngineInvocationResult> {
  const result: StepResult = { status: "completed", summary: "Looks good.", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null };
  return { result, cost: null, logExcerpt: "" };
}

async function driveToReview(platform: Platform, project: Project) {
  const task = makeTask(platform, project);
  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  return result;
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function abandon(stuck: Promise<unknown>, release: () => void): Promise<void> {
  release();
  await stuck.catch(() => {});
}

// ---------------------------------------------------------------------------
// 1-2. Two workers claiming the same TODO task
// ---------------------------------------------------------------------------

test("two workers racing to claim the same TODO task: exactly one wins, atomically, across two real DB connections", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("claim-race", engine);
  const task = makeTask(platformA, project);
  const now = new Date().toISOString();

  const [wonA, wonB] = await Promise.all([
    Promise.resolve(platformA.tasks.claimTodo(task.id, "A", 60_000, now)),
    Promise.resolve(platformB.tasks.claimTodo(task.id, "B", 60_000, now)),
  ]);

  assert.equal(wonA !== wonB, true, "exactly one of the two claims must win");
  const winner = wonA ? "A" : "B";
  const row = platformA.tasks.findById(task.id)!;
  assert.equal(row.lockOwner, winner);
  assert.equal(row.status, "WORKING");
});

test("a task claimed and held by one worker cannot be executed concurrently by a second worker while the lease is valid", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (implementerCalls === 1) await gate.promise;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("concurrent-block", engine, { orchestratorConfig: { taskLeaseMs: 60_000 } });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id); // claims + starts, then hangs
  try {
    for (let i = 0; i < 200 && implementerCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(implementerCalls, 1, "worker A must have genuinely started");

    const resultB = await platformB.orchestrator.executeTask(task.id);
    assert.equal(resultB.status, "WORKING", "worker B must not execute — the lease is still validly held by A");
    assert.equal(implementerCalls, 1, "worker B never invoked the implementer while A's lease is valid");
  } finally {
    // See the comment on test 8 — must run even on a thrown assertion, or A's stuck executeTask()
    // call leaves live heartbeat/watcher timers running forever, hanging this file's process.
    await abandon(stuck, gate.release);
  }
});

// ---------------------------------------------------------------------------
// 3-5. Lease expiry, recovery races
// ---------------------------------------------------------------------------

test("a valid (unexpired) lease prevents recoverOrphanedTasks from finding the task", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("valid-lease", engine);
  const task = makeTask(platformA, project);
  platformA.tasks.claimTodo(task.id, "A", 60_000, new Date().toISOString());

  assert.deepEqual(platformA.orchestrator.recoverOrphanedTasks(), [], "a task with a valid, unexpired lease is never orphaned");
});

test("an expired lease allows recovery — recoverOrphanedTasks finds it, a new claim succeeds", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("expired-lease", engine);
  const task = makeTask(platformA, project);
  platformA.tasks.claimTodo(task.id, "A", 1, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 15));

  assert.deepEqual(platformB.orchestrator.recoverOrphanedTasks(), [task.id]);
  assert.equal(platformB.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString()), true);
});

test("two workers racing to recover the same orphaned task: only one recovery execution actually proceeds", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("recovery-race", engine);
  const task = makeTask(platformA, project);
  platformA.tasks.claimTodo(task.id, "long-gone", 1, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 15));

  const [resultA, resultB] = await Promise.all([platformA.orchestrator.executeTask(task.id), platformB.orchestrator.executeTask(task.id)]);

  const statuses = [resultA.status, resultB.status].sort();
  // Exactly one of the two calls actually drives the task (to REVIEW); the other's claim loses and
  // it returns the task unchanged (still WORKING, claimed by the winner).
  assert.ok(statuses.includes("REVIEW"), "one of the two racing recoveries must have actually executed the task");
  const runs = platformA.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 1, "only ONE recovery execution actually ran the implementer — never both");
});

// ---------------------------------------------------------------------------
// 6-7. Lease renewal ownership
// ---------------------------------------------------------------------------

test("lease renewal succeeds for the current owner and fails for a different owner while the lease is valid", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("renewal-ownership", engine);
  const task = makeTask(platformA, project);
  const now = new Date().toISOString();
  platformA.tasks.claimTodo(task.id, "A", 60_000, now);

  assert.equal(platformA.tasks.claimWorking(task.id, "A", 60_000, new Date().toISOString()), true, "the current owner can renew");
  assert.equal(platformA.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString()), false, "a different owner cannot steal a still-valid lease");
});

test("releaseLock is owner-guarded: a stale worker's release cannot un-claim another worker's active lease", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("release-guard", engine);
  const task = makeTask(platformA, project);
  platformA.tasks.claimTodo(task.id, "A", 1, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 15));
  // B legitimately recovers the now-expired lease.
  assert.equal(platformB.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString()), true);

  // A, unaware it lost the lease, tries to release what it thinks is its own lock.
  platformA.tasks.releaseLock(task.id, "A", new Date().toISOString());

  const row = platformA.tasks.findById(task.id)!;
  assert.equal(row.lockOwner, "B", "A's stale release must be a no-op — B's active lease is untouched");
  assert.ok(row.lockExpiresAt, "B's lease expiry is still set");
});

// ---------------------------------------------------------------------------
// 8. A worker that loses its lease mid-execution stops cleanly (LeaseLostError)
// ---------------------------------------------------------------------------

test("a worker whose lease expires before its own first heartbeat renewal stops cleanly once it detects the loss, never corrupting the new owner's completed work", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (implementerCalls === 1) await gate.promise; // worker A's first attempt hangs
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  // Deliberately: taskLeaseMs shorter than leaseHeartbeatIntervalMs, so the very first heartbeat
  // tick fires AFTER the initial lease has already lapsed — the realistic failure mode this
  // mechanism defends against (a heartbeat too infrequent relative to the lease it's renewing).
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("lease-loss", engine, {
    orchestratorConfig: { taskLeaseMs: 60, leaseHeartbeatIntervalMs: 200 },
  });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id); // claims with a 60ms lease, hangs on the gate
  try {
    await new Promise((r) => setTimeout(r, 100)); // past the 60ms lease; A's first heartbeat isn't due until 200ms

    // Worker B recovers and fully completes the task while A is still stuck.
    assert.deepEqual(platformB.orchestrator.recoverOrphanedTasks(), [task.id]);
    const resultB = await platformB.orchestrator.executeTask(task.id);
    assert.equal(resultB.status, "REVIEW", "worker B must be able to fully complete the task once A's lease genuinely expired");

    // Let A's heartbeat get its turn (fires at ~200ms) and discover the lost lease, then release A's
    // stuck implementer call so its own execution can finally unwind.
    await new Promise((r) => setTimeout(r, 150));

    const finalTask = platformA.tasks.findById(task.id)!;
    assert.equal(finalTask.status, "REVIEW", "B's real, completed work must survive — A's lease-lost unwind must not touch task status");
    const runs = platformA.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
    // A's own single (interrupted, then abandoned) attempt + B's one real completed attempt — never
    // a second attempt from A actually completing and colliding with B's.
    assert.ok(runs.length <= 2, `expected at most 2 implementer runs (A's interrupted one + B's), got ${runs.length}`);
    assert.ok(runs.some((r) => r.status === "completed"), "B's real work is present");
    const workspace = platformA.workspaces.findByTaskId(task.id);
    assert.ok(workspace, "the workspace A might have torn down (it must not have) is still present");
    assert.equal(workspace!.status, "ready", "A's lease-loss unwind must never destroy the workspace B is using");
  } finally {
    // Must run even if an assertion above throws: platformA's executeTask() call is parked on the
    // gate, which means the Orchestrator's own heartbeat/cancellation-watcher setIntervals for that
    // call are still live (their `finally { clearInterval }` only fires once work() settles). Skipping
    // this on a thrown assertion leaves those timers running forever, which hangs this file's process
    // (and, transitively, `npm test` waiting on it) — this is the exact mechanism that produced the
    // reported "npm test hangs with no failure shown" symptom.
    await abandon(stuck, gate.release);
  }
});

// ---------------------------------------------------------------------------
// 9. AgentRun uniqueness — DB-level defense in depth
// ---------------------------------------------------------------------------

test("the database rejects two AgentRun rows for the same (task, role, attemptNumber) — defense in depth against the narrow lease-loss race window", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("agentrun-unique", engine);
  const task = makeTask(platformA, project);
  const now = new Date().toISOString();
  const makeRun = (id: string) => ({
    id,
    taskId: task.id,
    role: "implementer" as const,
    engine: "fixture",
    attemptNumber: 1,
    status: "running" as const,
    input: { taskGoal: "g", taskPlan: null, priorDecisions: [], repoPath: "/tmp", projectConventionPointer: "", lastFailure: null, reviewEvidence: null, reviewerFeedback: null, humanReviewFeedback: null },
    result: null,
    error: null,
    cost: null,
    startedAt: now,
    completedAt: null,
  });

  platformA.agentRuns.insert(makeRun("run-1"));
  assert.throws(() => platformA.agentRuns.insert(makeRun("run-2")), "a colliding (task, role, attemptNumber) must be rejected, not silently accepted");
});

// ---------------------------------------------------------------------------
// 10. SQLite concurrent writes — busy_timeout
// ---------------------------------------------------------------------------

test("two connections writing to the same SQLite file concurrently never throw SQLITE_BUSY — busy_timeout absorbs the contention", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("sqlite-busy", engine);

  const tasksA = Array.from({ length: 15 }, () => makeTask(platformA, project));
  const tasksB = Array.from({ length: 15 }, () => makeTask(platformB, project));

  // Hammer both connections with real, rapid concurrent writes (event appends) — if busy_timeout
  // weren't set, at least one of these would be expected to throw SQLITE_BUSY under contention.
  await Promise.all([
    ...tasksA.map((t, i) => Promise.resolve(platformA.taskEvents.append(t.id, "TASK_CREATED", { i }, new Date().toISOString()))),
    ...tasksB.map((t, i) => Promise.resolve(platformB.taskEvents.append(t.id, "TASK_CREATED", { i }, new Date().toISOString()))),
    ...tasksA.map((t) => Promise.resolve(platformB.tasks.claimTodo(t.id, "B", 60_000, new Date().toISOString()))),
  ]);

  // If we got here without throwing, busy_timeout did its job. Sanity-check the writes landed.
  assert.equal(platformA.tasks.listByProject(project.id).length, 30);
});

// ---------------------------------------------------------------------------
// 11. Human-review polling concurrency
// ---------------------------------------------------------------------------

test("two workers polling the same task's human review feedback concurrently: only one processes it, atomically", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const scProvider = new FakeSourceControlProvider("github");
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("review-poll-race", engine, {
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    additionalSourceControlProviders: [scProvider],
  });
  const task = await driveToReview(platformA, project);
  const branch = task.taskRecord.branchName!;
  const feedback: HumanReviewFeedbackItem = {
    id: "review:1",
    kind: "review",
    verdict: "changes_requested",
    body: "please fix",
    authorLogin: "octocat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  scProvider.setPullRequestFeedback(branch, [feedback]);

  const [resultA, resultB] = await Promise.all([platformA.orchestrator.checkHumanReviewFeedback(task.id), platformB.orchestrator.checkHumanReviewFeedback(task.id)]);

  assert.ok([resultA.status, resultB.status].includes("REVIEW") || [resultA.status, resultB.status].includes("WORKING"));
  const events = platformA.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "HUMAN_REVIEW_CHANGES_REQUESTED").length, 1, "the same feedback must never be processed twice, even when two workers poll concurrently");
  const implementerRuns = platformA.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(implementerRuns.length, 2, "original pass + exactly one fix cycle — never two competing fix cycles");
});

// ---------------------------------------------------------------------------
// 12. Cancellation during a contested execution
// ---------------------------------------------------------------------------

test("cancellation during a contested (lease-lost) execution is still honored cleanly by whichever process legitimately continues", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (implementerCalls === 1) await gate.promise;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("cancel-contested", engine, {
    orchestratorConfig: { taskLeaseMs: 60, leaseHeartbeatIntervalMs: 200 },
  });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id);
  try {
    await new Promise((r) => setTimeout(r, 100));
    platformB.orchestrator.recoverOrphanedTasks();
    await platformB.orchestrator.requestCancellation(task.id, "tester");
    const resultB = await platformB.orchestrator.executeTask(task.id);

    assert.equal(resultB.status, "CANCELLED");
    const finalTask = platformA.tasks.findById(task.id)!;
    assert.equal(finalTask.status, "CANCELLED", "the cancellation must stick — A's lease-lost unwind must not resurrect or fail the task");
  } finally {
    // See the identical comment on test 8 — this must run even on a thrown assertion, or A's stuck
    // executeTask() call leaves live heartbeat/watcher timers running forever.
    await abandon(stuck, gate.release);
  }
});

// ---------------------------------------------------------------------------
// 13. Invariants across a recovery race: no duplicate workspace/branch/PR, clean event history
// ---------------------------------------------------------------------------

test("across a full recovery race, invariants hold: one workspace, one branch, one PR, no duplicate creation events", async () => {
  const scProvider = new FakeSourceControlProvider("github");
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("race-invariants", engine, {
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    additionalSourceControlProviders: [scProvider],
  });
  const task = makeTask(platformA, project);
  platformA.tasks.claimTodo(task.id, "long-gone", 1, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 15));

  await Promise.all([platformA.orchestrator.executeTask(task.id), platformB.orchestrator.executeTask(task.id)]);

  const events = platformA.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1);
  assert.equal(scProvider.pullRequestsCreated, 1);
});
