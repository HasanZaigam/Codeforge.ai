import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageAccumulator } from "../src/coding-engine/engine-usage.js";
import { OpenCodeAdapter } from "../src/coding-engine/opencode-adapter.js";
import { toUsageDTO } from "../src/api/backlog-dto.js";
import type { ContextBundle } from "../src/domain/types.js";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.2 (GAP-031) — real engine usage is normalized, persisted, and NEVER fabricated: unavailable
 * usage stays absent/null (not 0), and an estimated cost exists only when the engine supplied one.
 */

const opencodeAcc = () => new UsageAccumulator({ currency: "USD", pricingSource: "opencode-reported", pricingVersion: null });

test("UsageAccumulator: normalizes one real step — every reported field, and the engine's own cost as a SEPARATE estimate", () => {
  const acc = opencodeAcc();
  acc.addStep({ tokens: { input: 5324, output: 391, reasoning: 802, cache: { write: 0, read: 8151 } }, cost: 0.003324275 });
  assert.deepEqual(acc.toCostMetadata(), {
    inputTokens: 5324,
    outputTokens: 391,
    reasoningTokens: 802,
    cacheReadTokens: 8151,
    cacheWriteTokens: 0, // the engine REPORTED zero cache writes — that is a real 0, unlike an absent field
    estimatedCost: { amount: 0.003324275, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null },
  });
});

test("UsageAccumulator: sums across steps, only over the steps that reported a field", () => {
  const acc = opencodeAcc();
  acc.addStep({ tokens: { input: 100, output: 10 }, cost: 0.001 });
  acc.addStep({ tokens: { input: 50, reasoning: 7 }, cost: 0.002 });
  const c = acc.toCostMetadata()!;
  assert.equal(c.inputTokens, 150);
  assert.equal(c.outputTokens, 10);
  assert.equal(c.reasoningTokens, 7);
  assert.ok(!("cacheReadTokens" in c) && !("cacheWriteTokens" in c), "never reported ⇒ never present");
  assert.ok(Math.abs(c.estimatedCost!.amount - 0.003) < 1e-12);
});

test("UsageAccumulator: unavailable usage is NULL, never zero — no data at all, or only garbage", () => {
  assert.equal(opencodeAcc().toCostMetadata(), null);
  const acc = opencodeAcc();
  acc.addStep({});
  acc.addStep({ tokens: null, cost: null });
  acc.addStep({ tokens: { input: "12", output: -3, reasoning: NaN, cache: { read: 1.5, write: Infinity } }, cost: "0.5" });
  assert.equal(acc.toCostMetadata(), null, "strings, negatives, NaN, fractions and Infinity are ignored, not coerced");
});

test("UsageAccumulator: a reported cost of 0 next to real tokens means 'no price known' — NOT a fabricated $0", () => {
  const acc = opencodeAcc();
  acc.addStep({ tokens: { input: 1000, output: 50 }, cost: 0 });
  const c = acc.toCostMetadata()!;
  assert.equal(c.inputTokens, 1000);
  assert.ok(!("estimatedCost" in c), "no estimatedCost key at all");
});

test("UsageAccumulator: is provider-agnostic — the pricing source is whatever the ADAPTER declares", () => {
  const acc = new UsageAccumulator({ currency: "EUR", pricingSource: "some-other-engine", pricingVersion: "2026-09" });
  acc.addStep({ tokens: { input: 1 }, cost: 0.5 });
  assert.deepEqual(acc.toCostMetadata()!.estimatedCost, { amount: 0.5, currency: "EUR", pricingSource: "some-other-engine", pricingVersion: "2026-09" });
});

// ---------------------------------------------------------------------------
// The real OpenCode adapter, fed the REAL captured event shape
// ---------------------------------------------------------------------------

function bundle(): ContextBundle {
  return {
    taskGoal: "g", taskPlan: null, priorDecisions: [], repoPath: "/tmp", projectConventionPointer: "", lastFailure: null, reviewEvidence: null,
    reviewerFeedback: null, humanReviewFeedback: null, projectContext: null, approvedVerificationChecks: [], verificationEvidence: null, bugFixEvidence: null,
  };
}

async function runAdapterWith(events: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "usage-mock-"));
  const execPath = join(dir, "mock-opencode.mjs");
  await writeFile(execPath, `#!/usr/bin/env node\nfor (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));\n`);
  await chmod(execPath, 0o755);
  const adapter = new OpenCodeAdapter({ executablePath: execPath, maxRetries: 0 });
  return adapter.run({ role: "reviewer", context: bundle(), workspacePath: dir, timeoutMs: 20_000, signal: new AbortController().signal, promptOverride: "hello" });
}

const stepFinish = (tokens: unknown, cost: unknown) => ({
  type: "step_finish",
  timestamp: 1,
  sessionID: "ses_1",
  part: { id: "prt", reason: "stop", messageID: "msg", sessionID: "ses_1", type: "step-finish", tokens, cost },
});
const textEvent = (text: string) => ({ type: "text", timestamp: 1, sessionID: "ses_1", part: { id: "p", type: "text", text } });

test("OpenCodeAdapter: real captured step_finish usage becomes normalized CostMetadata (was silently dropped before — GAP-031)", async () => {
  // Shape captured live from `opencode run --format json` against a real provider, 2026-09-25.
  const out = await runAdapterWith([
    { type: "step_start", part: { type: "step-start" } },
    textEvent("ok"),
    stepFinish({ total: 10668, input: 10525, output: 1, reasoning: 142, cache: { write: 0, read: 0 } }, 0.00284575),
  ]);
  assert.equal(out.result.summary, "ok");
  assert.deepEqual(out.cost, {
    usageStatus: "complete", // Phase 4A.4: a normally finished invocation is labelled complete
    inputTokens: 10525,
    outputTokens: 1,
    reasoningTokens: 142,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: { amount: 0.00284575, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null },
  });
});

test("OpenCodeAdapter: a multi-step run sums usage across steps", async () => {
  const out = await runAdapterWith([
    stepFinish({ input: 1000, output: 20, reasoning: 5, cache: { read: 300, write: 0 } }, 0.001),
    textEvent("done"),
    stepFinish({ input: 400, output: 60, reasoning: 0, cache: { read: 900, write: 10 } }, 0.0005),
  ]);
  assert.equal(out.cost!.inputTokens, 1400);
  assert.equal(out.cost!.outputTokens, 80);
  assert.equal(out.cost!.cacheReadTokens, 1200);
  assert.equal(out.cost!.cacheWriteTokens, 10);
  assert.ok(Math.abs(out.cost!.estimatedCost!.amount - 0.0015) < 1e-12);
});

test("OpenCodeAdapter: a run that reports no usage yields cost === null (not zeros)", async () => {
  const out = await runAdapterWith([textEvent("hello")]);
  assert.equal(out.cost, null);
});

test("OpenCodeAdapter: tokens without a price (cost 0) keep the counts but record NO estimated cost", async () => {
  const out = await runAdapterWith([textEvent("hello"), stepFinish({ input: 500, output: 40, cache: { read: 0, write: 0 } }, 0)]);
  assert.equal(out.cost!.inputTokens, 500);
  assert.ok(!("estimatedCost" in out.cost!));
});

// ---------------------------------------------------------------------------
// Persisted on the analysis, with provider/model preserved, and exposed honestly
// ---------------------------------------------------------------------------

test("analysis persists the engine's usage with the routing provider/model; the DTO separates usage from estimated cost and shows nulls, not zeros", async () => {
  const h = await setupBacklogHarness("usage-persist", {});
  try {
    h.engine.cost = { inputTokens: 12446, outputTokens: 349, reasoningTokens: 1150, estimatedCost: { amount: 0.00536, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null } };
    const item = h.item("x");
    await h.analyze(item.id);
    const analysis = h.platform.backlogAnalyses.findLatestForItem(item.id)!;
    assert.deepEqual(analysis.cost, h.engine.cost);
    const dto = toUsageDTO(analysis.cost);
    assert.deepEqual(dto.usage, { inputTokens: 12446, outputTokens: 349, reasoningTokens: 1150, cacheReadTokens: null, cacheWriteTokens: null });
    assert.deepEqual(dto.estimatedCost, { amount: 0.00536, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null });
    const completed = h.services.backlog.getItem(item.id, h.owner.id).events.find((e) => e.type === "ANALYSIS_COMPLETED")!;
    assert.equal(completed.payload.hasUsage, true);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
});

test("an engine that reports NO usage leaves analysis.cost null; the DTO has usage null and estimatedCost null", async () => {
  const h = await setupBacklogHarness("usage-none", {});
  try {
    h.engine.cost = null;
    const item = h.item("x");
    await h.analyze(item.id);
    assert.equal(h.platform.backlogAnalyses.findLatestForItem(item.id)!.cost, null);
    assert.deepEqual(toUsageDTO(null), { usage: null, estimatedCost: null });
    const completed = h.services.backlog.getItem(item.id, h.owner.id).events.find((e) => e.type === "ANALYSIS_COMPLETED")!;
    assert.equal(completed.payload.hasUsage, false);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
});

test("toUsageDTO: legacy cost with only a USD figure is NOT presented as an estimated cost or as token usage", () => {
  assert.deepEqual(toUsageDTO({ costUsd: 0.001, durationMs: 5 }), { usage: null, estimatedCost: null });
});

test("a malformed-output analysis still records the usage the call really consumed; a call that failed before returning records none (never a guess)", async () => {
  const returned = await setupBacklogHarness("usage-malformed", { respond: () => "not json" });
  try {
    const item = returned.item("x");
    await returned.analyze(item.id);
    const a = returned.platform.backlogAnalyses.findLatestForItem(item.id)!;
    assert.equal(a.status, "failed");
    assert.deepEqual(a.cost, returned.engine.cost, "the model call returned (badly) and its tokens were spent");
  } finally {
    await returned.platform.backlogRunner.stop();
    returned.close();
  }
  const crashed = await setupBacklogHarness("usage-crashed", { respond: () => { throw new Error("segfault"); } });
  try {
    const item = crashed.item("x");
    await crashed.analyze(item.id);
    assert.equal(crashed.platform.backlogAnalyses.findLatestForItem(item.id)!.cost, null);
  } finally {
    await crashed.platform.backlogRunner.stop();
    crashed.close();
  }
});
