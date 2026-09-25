import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupUsage, estimateOf } from "../src/reporting/usage-rollup.js";
import { buildTaskReport } from "../src/reporting/task-report.js";
import { UsageAccumulator } from "../src/coding-engine/engine-usage.js";
import type { AgentRun, CostMetadata, Task } from "../src/domain/types.js";

/**
 * GAP-031 (Phase 4A.3) — task-level usage roll-up invariants. Three concepts stay apart: RAW USAGE (what the
 * engine reported), the PROVIDER-REPORTED ESTIMATE (labelled with its source), and a CODEFORGE-CALCULATED cost
 * (always null: there is no explicit pricing source). `null` means "unavailable", never zero.
 */

let n = 0;
function agentRun(over: Partial<AgentRun> & { cost?: CostMetadata | null; trigger?: "initial" | "self_fix" | "reviewer_fix" | "human_fix" | "verify" } = {}): AgentRun {
  const { trigger, ...rest } = over;
  n++;
  const input: Record<string, unknown> = {};
  if (trigger === "self_fix") input.lastFailure = { summary: "x" };
  if (trigger === "reviewer_fix") input.reviewerFeedback = { summary: "x" };
  if (trigger === "human_fix") input.humanReviewFeedback = { reviewerLogin: "r", comments: "c" };
  if (trigger === "verify") input.verificationEvidence = { outcome: "passed" };
  return {
    id: `run-${n}`,
    taskId: "t",
    role: "implementer",
    engine: "opencode",
    attemptNumber: n,
    status: "completed",
    input: input as never,
    result: null,
    error: null,
    cost: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    ownerGeneration: 0,
    modelId: "google/gemini-3.1-flash-lite",
    providerId: "google",
    fallbackIndex: 0,
    ...rest,
  } as AgentRun;
}
const est = (amount: number, currency = "USD", pricingSource = "opencode-reported") => ({ amount, currency, pricingSource, pricingVersion: null });

test("no usage at all ⇒ every total is null (never 0), no estimate, and CodeForge-calculated cost is null", () => {
  const r = rollupUsage([agentRun(), agentRun({ cost: {} })]);
  assert.deepEqual(r.totals, { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
  assert.equal(r.providerReportedEstimate, null);
  assert.equal(r.codeforgeCalculatedCost, null);
  assert.equal(r.runsCounted, 2);
  assert.equal(r.runsWithUsage, 0);
  assert.deepEqual(rollupUsage([]).totals.inputTokens, null);
});

test("partial usage: only the reported fields are populated; the rest stay null (an output-only run does not invent input=0)", () => {
  const r = rollupUsage([agentRun({ cost: { outputTokens: 40 } }), agentRun({ cost: { outputTokens: 2, reasoningTokens: 7 } })]);
  assert.equal(r.totals.outputTokens, 42);
  assert.equal(r.totals.reasoningTokens, 7);
  assert.equal(r.totals.inputTokens, null);
  assert.equal(r.totals.cacheReadTokens, null);
  assert.deepEqual(r.runsReporting, { inputTokens: 0, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, "a partial total says how many runs it covers");
  const perRun = r.runs.map((x) => x.usage);
  assert.deepEqual(perRun[0], { inputTokens: null, outputTokens: 40, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
});

test("multiple AgentRuns are summed field by field; the task total equals the sum of its runs", () => {
  const costs: CostMetadata[] = [
    { inputTokens: 1000, outputTokens: 100, reasoningTokens: 10, cacheReadTokens: 500, cacheWriteTokens: 50, estimatedCost: est(0.01) },
    { inputTokens: 2000, outputTokens: 200, reasoningTokens: 20, cacheReadTokens: 600, estimatedCost: est(0.02) },
    { inputTokens: 3, outputTokens: 4 },
  ];
  const r = rollupUsage(costs.map((cost) => agentRun({ cost })));
  assert.deepEqual(r.totals, { inputTokens: 3003, outputTokens: 304, reasoningTokens: 30, cacheReadTokens: 1100, cacheWriteTokens: 50 });
  for (const f of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const sum = r.runs.reduce((t, x) => t + (x.usage?.[f] ?? 0), 0);
    assert.equal(r.totals[f], sum, `${f}: rollup equals the sum of runs`);
  }
  assert.equal(r.providerReportedEstimate!.amount, 0.01 + 0.02, "cost amounts are summed exactly as reported — not rounded");
  assert.equal(r.providerReportedEstimate!.runsCovered, 2);
  assert.equal(r.providerReportedEstimate!.runsWithoutEstimate, 1, "a partial estimate says it is partial");
});

test("retries are counted exactly once: every AgentRun row appears once, including failed/interrupted ones (which simply have no usage)", () => {
  const runs = [
    agentRun({ cost: { inputTokens: 10, outputTokens: 1 } }),
    agentRun({ status: "failed", error: "timeout", cost: null }),
    agentRun({ status: "interrupted", cost: null }),
    agentRun({ cost: { inputTokens: 20, outputTokens: 2 }, trigger: "self_fix" }),
  ];
  const r = rollupUsage(runs);
  assert.equal(r.runsCounted, 4);
  assert.deepEqual(r.runs.map((x) => x.runId), runs.map((x) => x.id));
  assert.equal(new Set(r.runs.map((x) => x.runId)).size, 4);
  assert.equal(r.totals.inputTokens, 30);
  // Rolling up twice, or the same rows in a different order, changes nothing (no hidden accumulation).
  assert.deepEqual(rollupUsage(runs), r);
  assert.equal(rollupUsage([...runs].reverse()).totals.inputTokens, 30);
});

test("provider and model are preserved per run; implementation, fix and review runs are distinguishable", () => {
  const r = rollupUsage([
    agentRun({ cost: { inputTokens: 1 }, modelId: "google/gemini-3.1-flash-lite", providerId: "google" }),
    agentRun({ cost: { inputTokens: 2 }, trigger: "self_fix", modelId: "openai/gpt-x", providerId: "openai" }),
    agentRun({ cost: { inputTokens: 4 }, trigger: "reviewer_fix" }),
    agentRun({ cost: { inputTokens: 8 }, role: "reviewer" }),
    // The Reviewer's follow-up call after the platform ran a check it requested: a model call ABOUT verification, not the review itself.
    agentRun({ cost: { inputTokens: 16 }, role: "reviewer", trigger: "verify" }),
  ]);
  assert.deepEqual(r.runs.map((x) => [x.role, x.trigger, x.phase]), [
    ["implementer", "initial", "implementation"],
    ["implementer", "self_fix_retry", "fix"],
    ["implementer", "ai_review_fix", "fix"],
    ["reviewer", "review", "review"],
    ["reviewer", "review_verification", "verification"],
  ]);
  assert.deepEqual([r.runs[0]!.providerId, r.runs[0]!.modelId], ["google", "google/gemini-3.1-flash-lite"]);
  assert.deepEqual([r.runs[1]!.providerId, r.runs[1]!.modelId], ["openai", "openai/gpt-x"]);
  assert.equal(r.byPhase.implementation.totals.inputTokens, 1);
  assert.equal(r.byPhase.fix.totals.inputTokens, 6);
  assert.equal(r.byPhase.review.totals.inputTokens, 8);
  assert.equal(r.byPhase.verification.totals.inputTokens, 16);
  assert.equal(r.byPhase.fix.runs, 2);
  assert.equal(r.totals.inputTokens, 1 + 2 + 4 + 8 + 16, "every phase is counted exactly once in the task total");
});

test("the provider-reported estimate is preserved WITH its source, and is never confused with a CodeForge-calculated cost", () => {
  const r = rollupUsage([agentRun({ cost: { inputTokens: 5, estimatedCost: est(0.005163, "USD", "opencode-reported") } })]);
  assert.deepEqual(r.providerReportedEstimate, { amount: 0.005163, currency: "USD", runsCovered: 1, runsWithoutEstimate: 0, sources: ["opencode-reported"] });
  assert.equal(r.runs[0]!.providerReportedEstimate!.pricingSource, "opencode-reported");
  assert.equal(r.codeforgeCalculatedCost, null, "no pricing source ⇒ CodeForge computes no cost of its own");
});

test("no fabricated cost: tokens without a reported cost give NO estimate (null, not 0); a reported 0 is not turned into a price; mixed currencies are never added", () => {
  assert.equal(rollupUsage([agentRun({ cost: { inputTokens: 1_000_000, outputTokens: 50_000 } })]).providerReportedEstimate, null);
  assert.equal(estimateOf({ inputTokens: 5, costUsd: 0 }), null);
  assert.equal(estimateOf({ inputTokens: 5, estimatedCost: { amount: Number.NaN, currency: "USD", pricingSource: "x", pricingVersion: null } }), null);
  // Legacy Claude Code `costUsd` is a real engine-reported figure and is surfaced as an estimate with that source.
  assert.deepEqual(estimateOf({ costUsd: 0.42 }), { amount: 0.42, currency: "USD", pricingSource: "engine-reported", pricingVersion: null });
  const mixed = rollupUsage([agentRun({ cost: { estimatedCost: est(1, "USD") } }), agentRun({ cost: { estimatedCost: est(1, "EUR") } })]);
  assert.equal(mixed.providerReportedEstimate, null, "USD and EUR are never summed");
});

test("meaningful usage is not rounded away: large and tiny values survive exactly", () => {
  const r = rollupUsage([agentRun({ cost: { inputTokens: 9_007_199_254_740, cacheReadTokens: 1, estimatedCost: est(0.000000123) } })]);
  assert.equal(r.totals.inputTokens, 9_007_199_254_740);
  assert.equal(r.totals.cacheReadTokens, 1);
  assert.equal(r.providerReportedEstimate!.amount, 0.000000123);
});

test("invalid stored values (negative, NaN, strings) are ignored rather than coerced into usage", () => {
  const r = rollupUsage([agentRun({ cost: { inputTokens: -5, outputTokens: Number.NaN, reasoningTokens: "12" as never, cacheReadTokens: 3 } })]);
  assert.equal(r.totals.inputTokens, null);
  assert.equal(r.totals.outputTokens, null);
  assert.equal(r.totals.reasoningTokens, null);
  assert.equal(r.totals.cacheReadTokens, 3);
});

test("normalization at the source: the accumulator only sets fields the engine reported, and the roll-up of that equals the sum of step usage", () => {
  const a = new UsageAccumulator({ currency: "USD", pricingSource: "opencode-reported", pricingVersion: null });
  a.addStep({ tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0.001 });
  a.addStep({ tokens: { input: 200, output: 20, reasoning: 5, cache: { read: 60, write: 0 } }, cost: 0.002 });
  const cost = a.toCostMetadata()!;
  const r = rollupUsage([agentRun({ cost })]);
  assert.equal(r.totals.inputTokens, 300);
  assert.equal(r.totals.reasoningTokens, 5);
  assert.equal(r.totals.cacheReadTokens, 110);
  assert.equal(r.totals.cacheWriteTokens, 0, "an explicitly reported 0 is a real zero (it WAS reported) — distinct from null");
  assert.equal(r.providerReportedEstimate!.amount, 0.003);
  const none = new UsageAccumulator({ currency: "USD", pricingSource: "x", pricingVersion: null });
  assert.equal(none.toCostMetadata(), null);
});

test("the TASK REPORT carries the roll-up, and its legacy telemetry token totals now agree with it (null, not 0, when unreported)", () => {
  const task = { id: "t", title: "T", goal: "g", status: "REVIEW", taskRecord: { pullRequest: null, branchName: null, latestDiffRef: null, bugFixVerification: null }, startedAt: null, completedAt: null } as unknown as Task;
  const withUsage = buildTaskReport(task, [agentRun({ cost: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2, estimatedCost: est(0.5) } }), agentRun({ cost: { inputTokens: 1, outputTokens: 1 } })], [], "main");
  assert.equal(withUsage.usage.runsCounted, 2);
  assert.equal(withUsage.usage.totals.inputTokens, 8);
  assert.equal(withUsage.telemetry.inputTokens, withUsage.usage.totals.inputTokens);
  assert.equal(withUsage.telemetry.outputTokens, withUsage.usage.totals.outputTokens);
  assert.equal(withUsage.usage.providerReportedEstimate!.amount, 0.5);
  assert.equal(withUsage.agentRuns.length, 2);

  const outputOnly = buildTaskReport(task, [agentRun({ cost: { outputTokens: 9 } })], [], "main");
  assert.equal(outputOnly.telemetry.inputTokens, null, "previously this was reported as 0");
  assert.equal(outputOnly.telemetry.outputTokens, 9);
  const nothing = buildTaskReport(task, [agentRun()], [], "main");
  assert.equal(nothing.telemetry.inputTokens, null);
  assert.equal(nothing.usage.providerReportedEstimate, null);
});

// ===========================================================================
// Persistence + reconciliation through the REAL orchestrator (raw engine usage ⇄ AgentRun rows ⇄ report)
// ===========================================================================

test("RECONCILIATION: engine-reported usage == persisted AgentRun usage == task report totals, across a self-fix retry and a review", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { buildPlatform } = await import("../src/platform.js");
  const { createFixtureRepo } = await import("../src/cli/fixture-repo.js");
  const { FixtureCodingEngine } = await import("../src/coding-engine/fixture-coding-engine.js");
  const { createReadyTask } = await import("./helpers/create-ready-task.js");

  const GOOD_ADD_JS = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
  const raw: Array<{ role: string; cost: CostMetadata }> = [];
  const reply = (role: string, cost: CostMetadata, summary: string, filesChanged: string[]) => {
    raw.push({ role, cost });
    return { result: { status: "completed" as const, summary, filesChanged, diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost, logExcerpt: "" };
  };
  let implementerCalls = 0;
  const engine = new FixtureCodingEngine({
    // 1st implementer run leaves the bug in (validation fails ⇒ self-fix); the 2nd fixes it.
    implementer: async (request) => {
      implementerCalls++;
      if (implementerCalls === 1) return reply("implementer", { inputTokens: 100, outputTokens: 10, estimatedCost: est(0.001) }, "Tried.", []);
      await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
      return reply("implementer", { inputTokens: 200, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 40, estimatedCost: est(0.002) }, "Fixed it.", ["add.js"]);
    },
    reviewer: async () => reply("reviewer", { inputTokens: 50, outputTokens: 5, cacheReadTokens: 500 }, "VERDICT: APPROVED", []),
  });
  const root = await mkdtemp(join(tmpdir(), "usage-recon-"));
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "ws"), engine, ownerId: "w" });
  try {
    const repoPath = await createFixtureRepo(root);
    const now = new Date().toISOString();
    const user = { id: randomUUID(), tenantId: "default", email: "u@example.com", name: "U", passwordHash: "", createdAt: now };
    platform.users.insert(user);
    const project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: "P", repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
    platform.projects.insert(project as never);
    const created = createReadyTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Fix add()", goal: "add() is wrong", createdBy: user.id });
    const done = await platform.orchestrator.executeTask(created.id);
    assert.equal(done.status, "REVIEW");

    const runs = platform.agentRuns.listForTask(created.id);
    assert.ok(runs.length >= 3, `expected ≥3 AgentRuns (2 implementer + review), got ${runs.length}`);
    // (1) raw engine usage → (2) persisted AgentRun.cost, run by run.
    assert.equal(runs.length, raw.length, "one AgentRun row per engine invocation");
    runs.forEach((run, i) => assert.deepEqual(run.cost, raw[i]!.cost, `AgentRun ${i} persisted exactly what the engine reported`));
    // (3) the task report roll-up equals both.
    const report = buildTaskReport(platform.tasks.findById(created.id)!, runs, platform.taskEvents.listForTask(created.id), "main");
    const sum = (f: keyof CostMetadata) => raw.reduce((t, r) => t + ((r.cost[f] as number | undefined) ?? 0), 0);
    assert.equal(report.usage.runsCounted, raw.length);
    assert.equal(report.usage.totals.inputTokens, sum("inputTokens"));
    assert.equal(report.usage.totals.outputTokens, sum("outputTokens"));
    assert.equal(report.usage.totals.reasoningTokens, 5);
    assert.equal(report.usage.totals.cacheReadTokens, 540);
    assert.equal(report.usage.totals.cacheWriteTokens, null, "nobody reported cache writes ⇒ null, not 0");
    assert.equal(report.usage.providerReportedEstimate!.amount, 0.003);
    assert.equal(report.usage.providerReportedEstimate!.runsWithoutEstimate, 1, "the reviewer run reported no estimate — visible as partial");
    assert.deepEqual(report.usage.byPhase.implementation.totals.inputTokens, 100);
    assert.deepEqual(report.usage.byPhase.fix.totals.inputTokens, 200);
    assert.deepEqual(report.usage.byPhase.review.totals.inputTokens, 50);
    // Also exposed per AgentRun in the history the UI already renders.
    assert.deepEqual(report.agentRuns.map((r) => r.cost), raw.map((r) => r.cost));
    assert.equal(report.usage.codeforgeCalculatedCost, null);
  } finally {
    platform.db.close();
  }
});
