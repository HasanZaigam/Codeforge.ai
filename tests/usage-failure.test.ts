import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenCodeAdapter } from "../src/coding-engine/opencode-adapter.js";
import { EngineCancelledError, EngineExecutionError, EngineTimeoutError, usageFromError, type EngineInvocationRequest } from "../src/coding-engine/coding-engine.js";
import { UsageAccumulator, mergeCostMetadata } from "../src/coding-engine/engine-usage.js";
import { rollupUsage } from "../src/reporting/usage-rollup.js";
import { buildTaskReport } from "../src/reporting/task-report.js";
import { buildPlatform } from "../src/platform.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import type { AgentRun, ContextBundle, CostMetadata, Project } from "../src/domain/types.js";

/**
 * GAP-034 (Phase 4A.4) — usage from an invocation that did NOT complete normally. These tests drive the REAL
 * OpenCodeAdapter event-parsing path against a mock `opencode` executable that emits genuine `step_finish`
 * events (the shape captured live) and then succeeds, fails, hangs or is cancelled. Unavailable usage is
 * `null` (never 0); partial usage is labelled partial (never complete); a provider estimate stays distinct.
 */

const CTX: ContextBundle = {
  taskGoal: "g", taskPlan: null, priorDecisions: [], repoPath: "/tmp", projectConventionPointer: "", lastFailure: null, reviewEvidence: null,
  reviewerFeedback: null, humanReviewFeedback: null, projectContext: null, approvedVerificationChecks: [], verificationEvidence: null, bugFixEvidence: null,
};

/** Only fields given are emitted — an engine that reports no cache/reasoning numbers emits none (a reported 0 is a real 0; an omitted field is unavailable). */
const step = (input: number, output: number, opts: { reasoning?: number; cacheRead?: number; cacheWrite?: number; cost?: number } = {}) => {
  const tokens: Record<string, unknown> = { input, output };
  if (opts.reasoning !== undefined) tokens.reasoning = opts.reasoning;
  if (opts.cacheRead !== undefined || opts.cacheWrite !== undefined) tokens.cache = { ...(opts.cacheRead !== undefined ? { read: opts.cacheRead } : {}), ...(opts.cacheWrite !== undefined ? { write: opts.cacheWrite } : {}) };
  return JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens, ...(opts.cost !== undefined ? { cost: opts.cost } : {}) } });
};
const text = (t: string) => JSON.stringify({ type: "text", part: { type: "text", text: t } });

async function mock(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usage-mock-"));
  const p = join(dir, "mock-opencode.mjs");
  await writeFile(p, `#!/usr/bin/env node\n${script}`);
  await chmod(p, 0o755);
  return p;
}
const emit = (...lines: string[]) => lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n");

function adapter(executablePath: string, over: ConstructorParameters<typeof OpenCodeAdapter>[0] = {}) {
  return new OpenCodeAdapter({ executablePath, model: "google/test", maxRetries: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 2, ...over });
}
const req = (over: Partial<EngineInvocationRequest> = {}): EngineInvocationRequest => ({
  role: "implementer", context: CTX, workspacePath: tmpdir(), timeoutMs: 10_000, signal: new AbortController().signal, modelSelection: null, ...over,
});

test("1. SUCCESS: usage is `complete`, exact, and the provider estimate is kept separate", async () => {
  const exe = await mock(emit(step(100, 10, { reasoning: 5, cacheRead: 20, cost: 0.001 }), step(50, 5, { cost: 0.0005 }), text("done")));
  const out = await adapter(exe).run(req());
  assert.deepEqual(out.cost, { usageStatus: "complete", inputTokens: 150, outputTokens: 15, reasoningTokens: 5, cacheReadTokens: 20, estimatedCost: { amount: 0.0015, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null } });
});

test("2. PROVIDER/ENGINE FAILURE after usage: the error carries the usage, labelled partial", async () => {
  const exe = await mock(`${emit(step(120, 12, { cost: 0.002 }), JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "invalid api key", statusCode: 401 } } }))}\nprocess.exit(1);`);
  await assert.rejects(adapter(exe).run(req()), (err: unknown) => {
    assert.ok(err instanceof EngineExecutionError);
    const u = usageFromError(err)!;
    assert.equal(u.usageStatus, "partial");
    assert.equal(u.inputTokens, 120);
    assert.equal(u.outputTokens, 12);
    assert.equal(u.estimatedCost?.amount, 0.002);
    assert.equal(u.reasoningTokens, undefined, "a field nobody reported is absent — not 0");
    return true;
  });
});

test("3. PROCESS crash (non-zero exit, no structured error) after usage keeps the usage as partial", async () => {
  const exe = await mock(`${emit(step(7, 3))}\nconsole.error("segfault");\nprocess.exit(139);`);
  await assert.rejects(adapter(exe).run(req()), (err: unknown) => {
    assert.equal(usageFromError(err)?.usageStatus, "partial");
    assert.equal(usageFromError(err)?.inputTokens, 7);
    return true;
  });
});

test("4. TIMEOUT after usage: usage emitted before the kill is captured (partial)", async () => {
  const exe = await mock(`${emit(step(300, 30, { cacheRead: 100, cost: 0.004 }))}\nsetInterval(() => {}, 1000);`);
  await assert.rejects(adapter(exe).run(req({ timeoutMs: 1500 })), (err: unknown) => {
    assert.ok(err instanceof EngineTimeoutError);
    assert.deepEqual(usageFromError(err), { usageStatus: "partial", inputTokens: 300, outputTokens: 30, cacheReadTokens: 100, estimatedCost: { amount: 0.004, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null } });
    return true;
  });
});

test("5. FAILURE BEFORE ANY USAGE: usage is null (unavailable) — never a zero-filled record", async () => {
  const noEvents = await mock(`console.error("boom");\nprocess.exit(1);`);
  await assert.rejects(adapter(noEvents).run(req()), (err: unknown) => {
    assert.equal(usageFromError(err), null);
    return true;
  });
  const hang = await mock("setInterval(() => {}, 1000);");
  await assert.rejects(adapter(hang).run(req({ timeoutMs: 800 })), (err: unknown) => {
    assert.ok(err instanceof EngineTimeoutError);
    assert.equal(usageFromError(err), null);
    return true;
  });
  // A step that reported no numbers is not usage either.
  const empty = await mock(`${emit(JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }))}\nprocess.exit(1);`);
  await assert.rejects(adapter(empty).run(req()), (err: unknown) => {
    assert.equal(usageFromError(err), null);
    return true;
  });
});

test("6. CANCELLATION after usage keeps it (partial); a truncated last line is ignored, not counted", async () => {
  const exe = await mock(`${emit(step(11, 2))}\nprocess.stdout.write('{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":999');\nsetInterval(() => {}, 1000);`);
  const ac = new AbortController();
  const promise = adapter(exe).run(req({ signal: ac.signal, timeoutMs: 20_000 }));
  setTimeout(() => ac.abort(), 700);
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof EngineCancelledError);
    assert.equal(usageFromError(err)?.inputTokens, 11, "the half-written 999 line is not usage");
    assert.equal(usageFromError(err)?.usageStatus, "partial");
    return true;
  });
});

test("7. RETRY: usage from a failed-then-retried attempt is included in the eventual success (each emitted step counted once)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-retry-"));
  const counter = join(dir, "n");
  const exe = await mock(`
    import { existsSync, writeFileSync } from "node:fs";
    if (!existsSync(${JSON.stringify(counter)})) {
      writeFileSync(${JSON.stringify(counter)}, "1");
      ${emit(step(40, 4, { cost: 0.0004 }), JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Service Unavailable", statusCode: 503, isRetryable: true } } }))}
      process.exit(1);
    }
    ${emit(step(60, 6, { cost: 0.0006 }), text("ok"))}
  `);
  const out = await adapter(exe, { maxRetries: 2 }).run(req());
  assert.equal(out.cost?.inputTokens, 100);
  assert.equal(out.cost?.outputTokens, 10);
  assert.equal(out.cost?.usageStatus, "complete", "the process finished normally and every emitted event is in");
  assert.ok(Math.abs(out.cost!.estimatedCost!.amount - 0.001) < 1e-12);
});

test("8. merge/accumulator invariants: no fabricated zeros, no fabricated summed price, partial infects complete", () => {
  const a = new UsageAccumulator({ currency: "USD", pricingSource: "opencode-reported", pricingVersion: null });
  assert.equal(a.toCostMetadata("partial"), null, "nothing added ⇒ unavailable");
  a.addStdout("garbage\n{not json}\n" + step(1, 1));
  assert.equal(a.toCostMetadata("partial")!.inputTokens, 1);
  const priced = { usageStatus: "complete" as const, inputTokens: 1, estimatedCost: { amount: 1, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null } };
  const unpriced = { usageStatus: "complete" as const, inputTokens: 2 };
  const m = mergeCostMetadata(priced, unpriced)!;
  assert.equal(m.inputTokens, 3);
  assert.equal(m.estimatedCost, undefined, "a sum of a priced and an unpriced part would be a fabricated total");
  assert.equal(m.usageStatus, "complete");
  assert.equal(mergeCostMetadata(priced, { usageStatus: "partial", inputTokens: 5 })!.usageStatus, "partial");
  assert.equal(mergeCostMetadata(null, null), null);
  assert.equal(mergeCostMetadata(null, unpriced), unpriced);
});

// ---------------------------------------------------------------------------
// Persistence + task roll-up through the REAL orchestrator with the REAL adapter
// ---------------------------------------------------------------------------

test("9. TASK: one run times out AFTER emitting usage, is retried and the task succeeds — the failed run's usage is persisted (partial) and the task total includes it exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-task-"));
  const counter = join(root, "calls");
  const GOOD = "function add(a, b) {\\n  return a + b;\\n}\\nmodule.exports = { add };\\n";
  const exe = await mock(`
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const n = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
    writeFileSync(${JSON.stringify(counter)}, String(n + 1));
    if (n === 0) {
      ${emit(step(1000, 100, { reasoning: 10, cost: 0.01 }))}
      setInterval(() => {}, 1000);            // hangs ⇒ killed by the engine timeout
    } else if (n === 1) {
      writeFileSync("add.js", "${GOOD}");
      ${emit(step(2000, 200, { cost: 0.02 }), text("Fixed add().")).replace(/\n/g, "\n      ")}
    } else {
      ${emit(step(500, 50, { cost: 0.005 }), text("VERDICT: APPROVED")).replace(/\n/g, "\n      ")}
    }
  `);
  const engine = new OpenCodeAdapter({ executablePath: exe, model: "google/test", maxRetries: 0 });
  const platform = buildPlatform({
    dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "ws"), engine, ownerId: "w",
    orchestratorConfig: { agentInvocationTimeoutMs: 2500, maxInfrastructureRetries: 2, infrastructureRetryBaseDelayMs: 10, infrastructureRetryMaxDelayMs: 50 },
  });
  try {
    const repoPath = await createFixtureRepo(root);
    const now = new Date().toISOString();
    const user = { id: randomUUID(), tenantId: "default", email: "u@example.com", name: "U", passwordHash: "", createdAt: now };
    platform.users.insert(user);
    const project: Project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: "P", repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
    platform.projects.insert(project);
    const created = createReadyTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Fix add()", goal: "add is wrong", createdBy: user.id });
    const done = await platform.orchestrator.executeTask(created.id);
    assert.equal(done.status, "REVIEW");

    const runs = platform.agentRuns.listForTask(created.id);
    const failed = runs.find((r) => r.status === "failed")!;
    assert.ok(failed, "the timed-out run is a failed AgentRun");
    assert.deepEqual(failed.cost, { usageStatus: "partial", inputTokens: 1000, outputTokens: 100, reasoningTokens: 10, estimatedCost: { amount: 0.01, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null } });
    assert.ok(runs.filter((r) => r.status === "completed").every((r) => r.cost?.usageStatus === "complete"));

    const report = buildTaskReport(platform.tasks.findById(created.id)!, runs, platform.taskEvents.listForTask(created.id), "main");
    assert.equal(report.usage.usageStatus, "partial", "a task containing a partial run is partial — its totals are lower bounds");
    assert.equal(report.usage.runsCounted, runs.length);
    assert.equal(report.usage.totals.inputTokens, 1000 + 2000 + 500, "failed run included exactly once");
    assert.equal(report.usage.totals.reasoningTokens, 10);
    assert.equal(report.usage.totals.cacheWriteTokens, null, "no run reported cache writes ⇒ null, not 0");
    assert.ok(Math.abs(report.usage.providerReportedEstimate!.amount - 0.035) < 1e-12);
    assert.equal(report.usage.codeforgeCalculatedCost, null);
    const failedRow = report.usage.runs.find((r) => r.runId === failed.id)!;
    assert.equal(failedRow.usageStatus, "partial");
  } finally {
    platform.db.close();
  }
});

test("10. TASK: a run that failed BEFORE any usage is `unavailable` (null), not zero — and the task is partial, never complete", async () => {
  const mk = (over: Partial<AgentRun>): AgentRun =>
    ({ id: randomUUID(), taskId: "t", role: "implementer", engine: "opencode", attemptNumber: 1, status: "completed", input: {}, result: null, error: null, cost: null, startedAt: "x", completedAt: "y", ownerGeneration: 0, modelId: "m", providerId: "p", fallbackIndex: 0, ...over }) as AgentRun;
  const r = rollupUsage([
    mk({ status: "failed", error: "boom", cost: null }),
    mk({ cost: { usageStatus: "complete", inputTokens: 10, outputTokens: 1 } }),
  ]);
  assert.equal(r.runs[0]!.usageStatus, "unavailable");
  assert.equal(r.runs[0]!.usage, null);
  assert.equal(r.usageStatus, "partial");
  assert.equal(r.totals.inputTokens, 10);
  // Nothing reported anywhere ⇒ unavailable at task level; all complete ⇒ complete.
  assert.equal(rollupUsage([mk({ status: "failed", cost: null })]).usageStatus, "unavailable");
  assert.equal(rollupUsage([mk({ cost: { usageStatus: "complete", inputTokens: 1 } })]).usageStatus, "complete");
  assert.equal(rollupUsage([]).usageStatus, "unavailable");
  // Legacy rows (no usageStatus field): completed ⇒ complete; anything else ⇒ partial — never silently 'complete'.
  assert.equal(rollupUsage([mk({ status: "failed", cost: { inputTokens: 5 } })]).runs[0]!.usageStatus, "partial");
  assert.equal(rollupUsage([mk({ status: "completed", cost: { inputTokens: 5 } })]).runs[0]!.usageStatus, "complete");
  // Partial usage can never be represented as complete: an explicit `partial` survives even on a 'completed' row.
  assert.equal(rollupUsage([mk({ status: "completed", cost: { usageStatus: "partial", inputTokens: 5 } })]).usageStatus, "partial");
});

test("11. reviewer VERIFICATION follow-up usage stays in its own phase next to a partial failed run", () => {
  const mk = (over: Partial<AgentRun>): AgentRun =>
    ({ id: randomUUID(), taskId: "t", role: "implementer", engine: "opencode", attemptNumber: 1, status: "completed", input: {}, result: null, error: null, cost: null, startedAt: "x", completedAt: "y", ownerGeneration: 0, modelId: "m", providerId: "p", fallbackIndex: 0, ...over }) as AgentRun;
  const r = rollupUsage([
    mk({ status: "failed", cost: { usageStatus: "partial", inputTokens: 100 } }),
    mk({ role: "reviewer", cost: { usageStatus: "complete", inputTokens: 7 } }),
    mk({ role: "reviewer", input: { verificationEvidence: { outcome: "passed" } } as never, cost: { usageStatus: "complete", inputTokens: 9 } }),
  ]);
  assert.equal(r.byPhase.verification.totals.inputTokens, 9);
  assert.equal(r.byPhase.review.totals.inputTokens, 7);
  assert.equal(r.totals.inputTokens, 116);
  assert.equal(r.usageStatus, "partial");
});

test("12. CANCELLED task: usage the engine emitted before the cancel is kept on the cancelled AgentRun (partial), through the real orchestrator", async () => {
  const { FixtureCodingEngine } = await import("../src/coding-engine/fixture-coding-engine.js");
  const root = await mkdtemp(join(tmpdir(), "usage-cancel-"));
  const engine = new FixtureCodingEngine({
    implementer: (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          const err = new EngineCancelledError("implementer");
          err.usage = { usageStatus: "partial", inputTokens: 5, outputTokens: 1 };
          reject(err);
        });
      }),
  });
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "ws"), engine, ownerId: "w", orchestratorConfig: { cancellationPollIntervalMs: 30 } });
  try {
    const repoPath = await createFixtureRepo(root);
    const now = new Date().toISOString();
    const user = { id: randomUUID(), tenantId: "default", email: "c@example.com", name: "C", passwordHash: "", createdAt: now };
    platform.users.insert(user);
    const project: Project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: "P", repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
    platform.projects.insert(project);
    const task = createReadyTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Cancel me", goal: "g", createdBy: null });
    const running = platform.orchestrator.executeTask(task.id);
    for (let i = 0; i < 200 && !platform.taskEvents.listForTask(task.id).some((e) => e.type === "AGENT_STARTED"); i++) await new Promise((r) => setTimeout(r, 25));
    await platform.orchestrator.requestCancellation(task.id, user.id);
    assert.equal((await running).status, "CANCELLED");
    const runs = platform.agentRuns.listForTask(task.id);
    assert.equal(runs[0]!.status, "cancelled");
    assert.deepEqual(runs[0]!.cost, { usageStatus: "partial", inputTokens: 5, outputTokens: 1 });
  } finally {
    platform.db.close();
  }
});

test("13. BACKLOG ANALYSIS: a failed model call keeps the usage it emitted on the failed analysis (partial); one with none records null", async () => {
  const { setupBacklogHarness } = await import("./helpers/backlog-harness.js");
  for (const [usage, expected] of [
    [{ usageStatus: "partial" as const, inputTokens: 321, outputTokens: 4 }, { usageStatus: "partial", inputTokens: 321, outputTokens: 4 }],
    [null, null],
  ] as const) {
    const h = await setupBacklogHarness("usage-fail-analysis", {
      respond: () => {
        const err = new EngineExecutionError("reviewer", "invalid api key", { attempts: 1, retryable: false, classification: "auth" });
        err.usage = usage;
        throw err;
      },
    });
    try {
      const item = h.item("x");
      await h.analyze(item.id);
      const a = h.platform.backlogAnalyses.findLatestForItem(item.id)!;
      assert.equal(a.status, "failed");
      assert.deepEqual(a.cost, expected);
    } finally {
      await h.platform.backlogRunner.stop();
      h.close();
    }
  }
});
