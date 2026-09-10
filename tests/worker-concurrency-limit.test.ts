import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { Worker } from "../src/worker/worker.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { Project, StepResult } from "../src/domain/types.js";

/**
 * WORKER_MAX_CONCURRENT_TASKS (see /docs/DEPLOYMENT.md "Concurrency", src/worker/worker.ts
 * WorkerConfig.maxConcurrentTasks) bounds how many TODO/WORKING task executions a single Worker
 * process has in flight at once. These tests use a controllable FixtureCodingEngine (gated
 * implementer handler) instead of the self-fix demo engine so a task's execution can be held open
 * long enough to directly observe the cap being enforced, not just infer it after the fact.
 */
async function setupConcurrencyLimitPlatform(label: string, engine: FixtureCodingEngine) {
  const root = await mkdtemp(join(tmpdir(), `worker-cap-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `worker-cap-${label}`,
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
  return { platform, project };
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

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function makeTasks(platform: Awaited<ReturnType<typeof setupConcurrencyLimitPlatform>>["platform"], project: Project, count: number) {
  return Array.from({ length: count }, (_, i) =>
    createReadyTask(platform.tasks, platform.taskEvents, {
      tenantId: "default",
      projectId: project.id,
      title: `Task ${i + 1}`,
      goal: "add() returns the wrong result",
      createdBy: null,
    }),
  );
}

test("WORKER_MAX_CONCURRENT_TASKS=2 with 4 executable TODO tasks: only 2 execute at once, the rest stay TODO, and once capacity frees they proceed — no task executes twice", async () => {
  let runningCount = 0;
  let maxObserved = 0;
  const heldTaskWorkspaces = new Set<string>(); // workspace dir basenames (= taskId) currently gated
  const gate1 = makeGate();

  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    runningCount++;
    maxObserved = Math.max(maxObserved, runningCount);
    const taskId = basename(request.workspacePath);
    if (heldTaskWorkspaces.has(taskId)) {
      await gate1.promise;
    }
    runningCount--;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platform, project } = await setupConcurrencyLimitPlatform("wave", engine);
  const tasks = makeTasks(platform, project, 4);
  const [t1, t2, t3, t4] = tasks;
  heldTaskWorkspaces.add(t1!.id);
  heldTaskWorkspaces.add(t2!.id);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, maxConcurrentTasks: 2 });

  const tick1 = worker.tick(); // dispatches at most 2 candidates — t1 and t2 (creation order)
  for (let i = 0; i < 200 && runningCount < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(runningCount, 2, "exactly 2 executions must be genuinely in flight");
  assert.equal(maxObserved, 2, "concurrency must never have exceeded the configured cap of 2");

  // The two beyond capacity must be left untouched — still TODO, never even claimed.
  assert.equal(platform.tasks.findById(t3!.id)?.status, "TODO", "task 3 must stay TODO — beyond capacity");
  assert.equal(platform.tasks.findById(t4!.id)?.status, "TODO", "task 4 must stay TODO — beyond capacity");
  assert.equal(platform.tasks.findById(t1!.id)?.status, "WORKING");
  assert.equal(platform.tasks.findById(t2!.id)?.status, "WORKING");

  gate1.release();
  await tick1;

  assert.equal(platform.tasks.findById(t1!.id)?.status, "REVIEW", "task 1 must have completed once capacity allowed it to run");
  assert.equal(platform.tasks.findById(t2!.id)?.status, "REVIEW", "task 2 must have completed once capacity allowed it to run");

  // Capacity has now freed up — a later poll picks up the remaining tasks.
  await worker.tick();
  await worker.tick(); // a second poll in case the first only claimed without finishing (fixture engine is fast, but be safe)

  assert.equal(platform.tasks.findById(t3!.id)?.status, "REVIEW", "task 3 must eventually run once capacity freed");
  assert.equal(platform.tasks.findById(t4!.id)?.status, "REVIEW", "task 4 must eventually run once capacity freed");

  for (const t of tasks) {
    const implementerRuns = platform.agentRuns.listForTask(t.id).filter((r) => r.role === "implementer");
    assert.equal(implementerRuns.length, 1, `task ${t.title} must have executed exactly once, never twice`);
  }

  await worker.stop();
});

test("overlapping tick() calls: a second tick() invoked while the first tick's dispatched executions are still in-flight/stalled never pushes real concurrency past the cap", async () => {
  let runningCount = 0;
  let maxObserved = 0;
  const heldTaskWorkspaces = new Set<string>();
  const gate = makeGate();

  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    runningCount++;
    maxObserved = Math.max(maxObserved, runningCount);
    const taskId = basename(request.workspacePath);
    if (heldTaskWorkspaces.has(taskId)) {
      await gate.promise;
    }
    runningCount--;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platform, project } = await setupConcurrencyLimitPlatform("overlap", engine);
  const tasks = makeTasks(platform, project, 4);
  const [t1, t2, t3, t4] = tasks;
  // Hold the first wave's executions open indefinitely (gate never released until asserted below) so
  // a second, genuinely overlapping tick() call is forced to observe them still in flight — proving
  // the capacity accounting (`executingTaskIds`) is shared/live across ticks, not just correct within
  // a single tick() call in isolation.
  heldTaskWorkspaces.add(t1!.id);
  heldTaskWorkspaces.add(t2!.id);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, maxConcurrentTasks: 2 });

  // tick1 dispatches t1 and t2 (fills capacity to 2) and stalls on the gate — do NOT await it yet.
  const tick1 = worker.tick();
  for (let i = 0; i < 200 && runningCount < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(runningCount, 2, "tick1's two dispatched executions must be genuinely in flight before tick2 starts");

  // Call tick() a SECOND time while tick1's executions are still stalled and in-flight — the actual
  // overlap scenario. Capacity is exhausted (2/2), so tick2 must dispatch zero new real executions:
  // t3/t4 must be left untouched (still TODO, never claimed), and real concurrency must never exceed 2.
  const tick2 = worker.tick();
  await tick2;

  assert.equal(runningCount, 2, "concurrent real executions must still be exactly 2 after the overlapping tick2 resolves");
  assert.equal(maxObserved, 2, "real execution concurrency must never have exceeded the configured cap of 2, even across overlapping tick() calls");
  assert.equal(platform.tasks.findById(t3!.id)?.status, "TODO", "task 3 must not have been dispatched by the overlapping tick2 — capacity was already full");
  assert.equal(platform.tasks.findById(t4!.id)?.status, "TODO", "task 4 must not have been dispatched by the overlapping tick2 — capacity was already full");
  assert.equal(platform.tasks.findById(t1!.id)?.status, "WORKING");
  assert.equal(platform.tasks.findById(t2!.id)?.status, "WORKING");

  // Release the gate, let tick1 finish, then a further poll should pick up t3/t4 now that capacity
  // has actually freed — and concurrency must still never exceed the cap while that happens.
  gate.release();
  await tick1;
  assert.equal(platform.tasks.findById(t1!.id)?.status, "REVIEW");
  assert.equal(platform.tasks.findById(t2!.id)?.status, "REVIEW");

  await worker.tick();
  await worker.tick(); // second poll in case the first only claimed without finishing

  assert.equal(platform.tasks.findById(t3!.id)?.status, "REVIEW", "task 3 must eventually run once capacity freed");
  assert.equal(platform.tasks.findById(t4!.id)?.status, "REVIEW", "task 4 must eventually run once capacity freed");
  assert.equal(maxObserved, 2, "real execution concurrency must never have exceeded the cap across the entire scenario");

  for (const t of tasks) {
    const implementerRuns = platform.agentRuns.listForTask(t.id).filter((r) => r.role === "implementer");
    assert.equal(implementerRuns.length, 1, `task ${t.title} must have executed exactly once, never twice, despite overlapping tick() calls`);
  }

  await worker.stop();
});

test("overlapping tick() calls never double-count the separate REVIEW/human-review-feedback poll against WORKER_MAX_CONCURRENT_TASKS", async () => {
  // A REVIEW task with no PR is a guaranteed no-op for checkHumanReviewFeedback (see
  // orchestrator.ts's own early-return doc comment), so this only needs to prove that REVIEW
  // candidates never consume `executingTaskIds` capacity, freeing it entirely for real TODO/WORKING
  // executions even under overlapping ticks — not that human-review-feedback logic itself behaves
  // (that's tests/human-review-feedback.test.ts's job).
  let runningCount = 0;
  let maxObserved = 0;
  const gate = makeGate();
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    runningCount++;
    maxObserved = Math.max(maxObserved, runningCount);
    await gate.promise;
    runningCount--;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platform, project } = await setupConcurrencyLimitPlatform("review-poll", engine);
  const [reviewTask] = makeTasks(platform, project, 1);
  // Force it straight to REVIEW with no PR — checkHumanReviewFeedback no-ops immediately.
  const freshReview = platform.tasks.findById(reviewTask!.id)!;
  freshReview.status = "REVIEW";
  platform.tasks.save(freshReview, new Date().toISOString());

  const [workTask1, workTask2, workTask3] = makeTasks(platform, project, 3);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000, maxConcurrentTasks: 2 });
  const tick1 = worker.tick(); // dispatches workTask1 + workTask2 (cap 2) and polls reviewTask (uncapped)
  for (let i = 0; i < 200 && runningCount < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(runningCount, 2, "two real executions must be in flight");

  const tick2 = worker.tick(); // overlapping: still fully at capacity, plus a second harmless REVIEW poll
  await tick2;
  assert.equal(maxObserved, 2, "the REVIEW poll must never count toward the real-execution cap, even overlapping");
  assert.equal(platform.tasks.findById(workTask3!.id)?.status, "TODO", "third work task stays TODO — capacity still full");
  assert.equal(platform.tasks.findById(reviewTask!.id)?.status, "REVIEW", "REVIEW task is untouched (no PR — a no-op)");

  gate.release();
  await tick1;
  await worker.tick();
  assert.equal(platform.tasks.findById(workTask1!.id)?.status, "REVIEW");
  assert.equal(platform.tasks.findById(workTask2!.id)?.status, "REVIEW");
  assert.equal(maxObserved, 2, "cap held for the whole scenario");

  await worker.stop();
});

test("WORKER_MAX_CONCURRENT_TASKS=1 fully serializes execution: never more than one task runs at a time", async () => {
  let runningCount = 0;
  let maxObserved = 0;
  const handler = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    runningCount++;
    maxObserved = Math.max(maxObserved, runningCount);
    await new Promise((r) => setTimeout(r, 20)); // hold briefly so a real overlap would be observable
    runningCount--;
    return correctImplementerResult(request);
  };
  const engine = new FixtureCodingEngine({ implementer: handler, reviewer: approvingReviewerHandler });
  const { platform, project } = await setupConcurrencyLimitPlatform("serialize", engine);
  const tasks = makeTasks(platform, project, 3);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 15, maxConcurrentTasks: 1 });
  worker.start();

  // Poll until all three tasks have reached a terminal-for-this-test state (REVIEW), bounded.
  for (let i = 0; i < 400; i++) {
    const statuses = tasks.map((t) => platform.tasks.findById(t.id)?.status);
    if (statuses.every((s) => s === "REVIEW")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await worker.stop();

  for (const t of tasks) {
    assert.equal(platform.tasks.findById(t.id)?.status, "REVIEW", `task ${t.title} must have reached REVIEW`);
    const implementerRuns = platform.agentRuns.listForTask(t.id).filter((r) => r.role === "implementer");
    assert.equal(implementerRuns.length, 1, `task ${t.title} must have executed exactly once, never twice`);
  }
  assert.equal(maxObserved, 1, "with maxConcurrentTasks=1, concurrency must never have exceeded 1");
});
