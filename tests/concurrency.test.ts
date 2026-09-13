import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform, type BuildPlatformOptions } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
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
    /**
     * Worker B's own CodingEngine instance, independent of `engine` (worker A's). Defaults to the
     * same `engine` for every existing test that doesn't care which "side" happens to call the
     * implementer first. Give this explicitly whenever a test's fixture handler depends on being
     * called by a SPECIFIC worker (e.g. a gate meant to stall only worker A) — a single shared
     * engine/handler closure has no way to know which platform is actually calling it, since
     * neither EngineInvocationRequest nor ContextBundle carries an owner/worker identity (see the
     * "lease expires before its own first heartbeat renewal" test below for why this matters: it
     * used to assume worker A always reaches the implementer first, which a real concurrent
     * fresh-workspace-provisioning race can falsify).
     */
    engineB?: FixtureCodingEngine;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `concurrency-${label}-`));
  const dbPath = join(root, "platform.sqlite");
  const workspacesRoot = join(root, "workspaces");
  const buildOptsCommon = {
    dbPath,
    workspacesRoot,
    orchestratorConfig: options.orchestratorConfig,
    additionalSourceControlProviders: options.additionalSourceControlProviders,
  };
  const platformA = buildPlatform({ ...buildOptsCommon, engine, ownerId: `${label}-worker-A` });
  const platformB = buildPlatform({ ...buildOptsCommon, engine: options.engineB ?? engine, ownerId: `${label}-worker-B` });

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
  return createReadyTask(platform.tasks, platform.taskEvents, {
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
  assert.notEqual(platformB.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString()), null);
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

test("lease renewal (renewWorkingLease) succeeds for the current owner without advancing lock_generation, and fails for a different owner while the lease is valid", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("renewal-ownership", engine);
  const task = makeTask(platformA, project);
  const now = new Date().toISOString();
  const generation = platformA.tasks.claimTodo(task.id, "A", 60_000, now);

  assert.equal(platformA.tasks.renewWorkingLease(task.id, "A", 60_000, new Date().toISOString()), true, "the current owner can renew");
  assert.equal(platformA.tasks.findById(task.id)?.lockGeneration, generation, "renewal never advances the generation");
  assert.equal(platformA.tasks.renewWorkingLease(task.id, "B", 60_000, new Date().toISOString()), false, "a different owner cannot steal a still-valid lease via renewal");
  // claimWorking (ownership acquisition, not renewal) also refuses a different owner while the
  // lease is valid — see task-repository.test.ts for its full generation-advancing behavior.
  assert.equal(platformA.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString()), null, "a different owner cannot steal a still-valid lease via claimWorking either");
});

test("releaseLock is owner-guarded: a stale worker's release cannot un-claim another worker's active lease", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("release-guard", engine);
  const task = makeTask(platformA, project);
  platformA.tasks.claimTodo(task.id, "A", 1, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 15));
  // B legitimately recovers the now-expired lease.
  assert.notEqual(platformB.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString()), null);

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
  let implementerCallsA = 0;
  // Worker A's own engine: its first implementer attempt hangs on the gate. Deliberately a
  // SEPARATE engine instance from worker B's (see setupTwoWorkerPlatform's `engineB` option) —
  // EngineInvocationRequest/ContextBundle carry no owner/worker identity, so a single shared
  // handler has no reliable way to know whether it's being called by A or by B. A prior version of
  // this test shared one handler/counter between both workers and assumed A would always reach the
  // implementer first; that assumption can be falsified by a real concurrent fresh-workspace-
  // provisioning race between A and B (both provisioning the same never-before-seen task's
  // workspace at once — see /docs/TASK_LIFECYCLE.md "Worker concurrency and lease loss" and this
  // test suite's own workspace-fencing tests, which cover *reused* workspace claims, not two
  // owners racing a *fresh* one). When that race lands in A's favor for the failure, B's call
  // becomes the shared counter's "first" call instead and gets wrongly gated, deadlocking the test
  // (B's own executeTask() is awaited directly below, with no gate-release path of its own). Two
  // independent engines make the gate structurally A-only, regardless of provisioning timing.
  const handlerA = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCallsA += 1;
    if (implementerCallsA === 1) await gate.promise; // worker A's first attempt hangs
    return correctImplementerResult(request);
  };
  const engineA = new FixtureCodingEngine({ implementer: handlerA, reviewer: approvingReviewerHandler });
  // Worker B's engine never gates — B must always be free to recover and complete regardless of
  // call order.
  const engineB = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  // Deliberately: taskLeaseMs shorter than leaseHeartbeatIntervalMs, so the very first heartbeat
  // tick fires AFTER the initial lease has already lapsed — the realistic failure mode this
  // mechanism defends against (a heartbeat too infrequent relative to the lease it's renewing).
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("lease-loss", engineA, {
    orchestratorConfig: { taskLeaseMs: 60, leaseHeartbeatIntervalMs: 200 },
    engineB,
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
    ownerGeneration: 1,
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

// ---------------------------------------------------------------------------
// Concurrency V1: lease-generation fencing (see /docs/TASK_LIFECYCLE.md
// "Worker concurrency and lease loss" and migrations/009_lock_generation.sql)
// ---------------------------------------------------------------------------

test("14. lock_generation semantics: first claim gets generation 1, a same-owner heartbeat renewal preserves it, and a new owner after expiry gets the next generation, monotonically", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("gen-semantics", engine);
  const task = makeTask(platformA, project);

  const gen1 = platformA.tasks.claimTodo(task.id, "A", 60_000, new Date().toISOString());
  assert.equal(gen1, 1, "the first-ever claim on a fresh task takes it to generation 1");

  // Any number of heartbeat renewals by the SAME owner must never advance the generation.
  for (let i = 0; i < 5; i++) {
    assert.equal(platformA.tasks.renewWorkingLease(task.id, "A", 60_000, new Date().toISOString()), true);
  }
  assert.equal(platformA.tasks.findById(task.id)?.lockGeneration, 1, "repeated heartbeats never advance the generation");

  // Force A's own lease to an already-expired value (simulating time passing without a heartbeat),
  // then let worker B take over — this MUST advance the generation past 1.
  platformA.tasks.claimWorking(task.id, "A", 1, new Date(Date.now() - 10_000).toISOString());
  await new Promise((r) => setTimeout(r, 5));
  const gen2 = platformB.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString());
  assert.equal(gen2, 3, "claimWorking always advances the generation on success (A's own self-reclaim above took it to 2, B's takeover to 3) — monotonically increasing");
});

test("15. TaskRepository.saveOwned: the current generation's write succeeds; a stale generation's write fails cleanly and does not overwrite the current owner's state", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("save-owned", engine);
  const task = makeTask(platformA, project);
  const staleGeneration = platformA.tasks.claimTodo(task.id, "A", 60_000, new Date().toISOString())!;

  // A different owner takes over after expiry — advances the generation.
  await new Promise((r) => setTimeout(r, 5));
  platformA.tasks.claimWorking(task.id, "A", 1, new Date(Date.now() - 10_000).toISOString());
  await new Promise((r) => setTimeout(r, 5));
  const currentGeneration = platformA.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString())!;
  assert.notEqual(currentGeneration, staleGeneration);

  const freshRead = platformA.tasks.findById(task.id)!;
  freshRead.taskRecord.plan = "B's real plan";
  assert.equal(platformA.tasks.saveOwned(freshRead, currentGeneration, new Date().toISOString()), true, "the current owner's fenced save succeeds");
  assert.equal(platformA.tasks.findById(task.id)?.taskRecord.plan, "B's real plan");

  const staleWrite = platformA.tasks.findById(task.id)!;
  staleWrite.taskRecord.plan = "A's stale, discarded plan";
  assert.equal(platformA.tasks.saveOwned(staleWrite, staleGeneration, new Date().toISOString()), false, "a stale generation's fenced save must fail, not silently succeed");
  assert.equal(platformA.tasks.findById(task.id)?.taskRecord.plan, "B's real plan", "the current owner's state must survive the stale write attempt untouched");
});

test("16. AgentRunRepository.complete: the current execution can complete its own AgentRun; a stale execution cannot complete/overwrite one after ownership changed", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("agentrun-fencing", engine);
  const task = makeTask(platformA, project);
  const genA = platformA.tasks.claimTodo(task.id, "A", 60_000, new Date().toISOString())!;

  const baseInput = { taskGoal: "g", taskPlan: null, priorDecisions: [], repoPath: "/tmp", projectConventionPointer: "", lastFailure: null, reviewEvidence: null, reviewerFeedback: null, humanReviewFeedback: null };
  platformA.agentRuns.insert({
    id: "run-A",
    taskId: task.id,
    role: "implementer",
    engine: "fixture",
    attemptNumber: 1,
    status: "running",
    input: baseInput,
    result: null,
    error: null,
    cost: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    ownerGeneration: genA,
  });

  // Ownership moves on — a new generation takes over the task.
  await new Promise((r) => setTimeout(r, 5));
  platformA.tasks.claimWorking(task.id, "A", 1, new Date(Date.now() - 10_000).toISOString());
  await new Promise((r) => setTimeout(r, 5));
  const genB = platformA.tasks.claimWorking(task.id, "B", 60_000, new Date().toISOString())!;
  assert.notEqual(genB, genA);

  platformA.agentRuns.insert({
    id: "run-B",
    taskId: task.id,
    role: "implementer",
    engine: "fixture",
    attemptNumber: 2,
    status: "running",
    input: baseInput,
    result: null,
    error: null,
    cost: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    ownerGeneration: genB,
  });

  // The stale run (created under genA, now no longer the task's current generation) must fail to complete.
  const staleCompleted = platformA.agentRuns.complete("run-A", "completed", null, null, null, new Date().toISOString());
  assert.equal(staleCompleted, false, "a stale execution's AgentRun completion must be rejected");
  assert.equal(platformA.agentRuns.listForTask(task.id).find((r) => r.id === "run-A")?.status, "running", "the stale run's row must be left untouched, not silently marked completed");

  // The current run (created under genB, the task's current generation) completes normally.
  const currentCompleted = platformA.agentRuns.complete("run-B", "completed", null, null, null, new Date().toISOString());
  assert.equal(currentCompleted, true, "the current execution's own AgentRun completion must succeed");
  assert.equal(platformA.agentRuns.listForTask(task.id).find((r) => r.id === "run-B")?.status, "completed");
});

// ---------------------------------------------------------------------------
// 17. Zombie-worker scenario: stale execution is fully fenced out at every write
// ---------------------------------------------------------------------------

test("17. zombie worker: A's stalled execution cannot mutate task state, cannot overwrite the AgentRun, and produces no extra commit/push/PR after B fully recovers and completes the task", async () => {
  const gate = makeGate();
  let implementerCalls = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    implementerCalls += 1;
    if (implementerCalls === 1) await gate.promise; // A's first attempt stalls indefinitely
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const scProvider = new FakeSourceControlProvider("github");
  const { platformA, platformB, project } = await setupTwoWorkerPlatform("zombie-worker", engine, {
    orchestratorConfig: { taskLeaseMs: 60, leaseHeartbeatIntervalMs: 100_000 }, // heartbeat effectively disabled — the DB-level generation fence must still catch it
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    additionalSourceControlProviders: [scProvider],
  });
  const task = makeTask(platformA, project);

  const stuck = platformA.orchestrator.executeTask(task.id); // A claims (generation 1), stalls on the implementer gate
  try {
    for (let i = 0; i < 200 && implementerCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(implementerCalls, 1, "worker A must have genuinely started");

    // A's 60ms lease is now long expired (no heartbeat will save it — it's set to fire in
    // 100_000ms, i.e. effectively never during this test). B recovers and fully completes the task.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(platformB.orchestrator.recoverOrphanedTasks(), [task.id]);
    const resultB = await platformB.orchestrator.executeTask(task.id);
    assert.equal(resultB.status, "REVIEW", "worker B must fully complete the task while A is still stalled");

    const genAfterB = platformA.tasks.findById(task.id)!.lockGeneration;
    assert.ok(genAfterB > 1, "B's takeover must have advanced the generation past A's");

    // Now release A's stalled implementer call — every write it attempts from here on must be a
    // no-op against the DB, since it's operating under a stale generation.
    gate.release();
    await stuck.catch(() => {});

    const finalTask = platformA.tasks.findById(task.id)!;
    assert.equal(finalTask.status, "REVIEW", "B's real, completed work must survive — A's belated resumption must not touch task status");
    assert.equal(finalTask.lockGeneration, genAfterB, "A's belated resumption must not advance or otherwise touch the generation");
    assert.ok(finalTask.taskRecord.pullRequest, "B's legitimately-opened PR reference must be present and untouched");

    // No duplicate side effects: exactly one commit/push/PR, from B's real run — never a second one
    // from A's belated (fenced-out) resumption.
    assert.equal(scProvider.pullRequestsCreated, 1, "A's stale resumption must never open a second PR");
    const events = platformA.taskEvents.listForTask(task.id).map((e) => e.type);
    assert.equal(events.filter((t) => t === "COMMIT_CREATED").length, 1, "no duplicate commit from A");
    assert.equal(events.filter((t) => t === "BRANCH_PUSHED").length, 1, "no duplicate push from A");
    assert.equal(events.filter((t) => t === "PULL_REQUEST_CREATED").length, 1, "no duplicate PR from A");

    // A's own (interrupted-then-abandoned) AgentRun must never have been mutated to "completed" by
    // its belated resumption once it lost the lease.
    const implementerRuns = platformA.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
    assert.ok(implementerRuns.some((r) => r.status === "completed"), "B's real completed run is present");
    const staleRun = implementerRuns.find((r) => r.attemptNumber === 1);
    assert.ok(staleRun, "A's own first-attempt AgentRun row must still exist");
    assert.notEqual(staleRun!.status, "completed", "A's belated resumption must never be able to mark its own stale AgentRun completed");
  } finally {
    await abandon(stuck, gate.release);
  }
});

// ---------------------------------------------------------------------------
// 18. Workspace fencing
// ---------------------------------------------------------------------------

test("18. workspace fencing: two different generations cannot both claim the same workspace directory as active — a stale generation loses and must not reuse it", async () => {
  const engine = new FixtureCodingEngine({ implementer: correctImplementerResult, reviewer: approvingReviewerHandler });
  const { platformA, project } = await setupTwoWorkerPlatform("workspace-fencing", engine);
  const task = makeTask(platformA, project);
  const now = new Date().toISOString();

  const workspace: import("../src/domain/types.js").Workspace = {
    id: randomUUID(),
    taskId: task.id,
    provider: "local-git",
    path: "/tmp/does-not-matter",
    repoUrl: project.repoUrl,
    branch: "task/abc",
    baseCommit: "deadbeef",
    status: "ready",
    createdAt: now,
    destroyedAt: null,
  };
  platformA.workspaces.insert(workspace);

  // Generation 2 (a newer execution) claims the workspace first.
  assert.equal(platformA.workspaces.claimForGeneration(workspace.id, 2), true, "a newer generation can claim an unclaimed (generation 0) workspace");

  // Generation 1 (a stale, older execution — e.g. A resuming after B already took over) must lose.
  assert.equal(platformA.workspaces.claimForGeneration(workspace.id, 1), false, "a stale (lower) generation must not be able to claim a workspace a newer generation already owns");

  // The same generation calling again is also refused (strictly increasing only — not idempotent
  // re-claim by design, since a real execution only calls this once per provisionWorkspace).
  assert.equal(platformA.workspaces.claimForGeneration(workspace.id, 2), false, "claiming is strictly-increasing: the same generation cannot re-claim");

  // A genuinely newer generation can still take over from generation 2.
  assert.equal(platformA.workspaces.claimForGeneration(workspace.id, 5), true, "a strictly newer generation can still take over");
});
