import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { estimateTokensFromChars, monthStartUtc, reportedTokens, tokenCountFor } from "../src/usage/token-usage.js";
import { NotFoundError } from "../src/application/errors.js";

/**
 * Token usage visibility (TD-63): per Chat reply, per project per month, per account, against optional
 * budgets. Reported counts and ~4-chars-per-token estimates are never blended silently.
 */
describe("token counting", () => {
  test("reported = input + output + reasoning; nothing reported is null, never 0", () => {
    assert.equal(reportedTokens({ inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 900 }), 1250);
    assert.equal(reportedTokens({ outputTokens: 7 }), 7);
    assert.equal(reportedTokens({ durationMs: 10 }), null);
    assert.equal(reportedTokens(null), null);
  });

  test("an estimate is used only when nothing was reported, and is labelled as one", () => {
    assert.deepEqual(tokenCountFor({ inputTokens: 10, outputTokens: 5 }, 4000), { tokens: 15, estimated: false });
    assert.deepEqual(tokenCountFor(null, 4000), { tokens: 1000, estimated: true });
    assert.equal(tokenCountFor(null, 0), null);
    assert.equal(estimateTokensFromChars(9), 3);
  });

  test("budgets are per calendar month (UTC)", () => {
    assert.equal(monthStartUtc(new Date("2026-10-31T23:59:59.000Z")), "2026-10-01T00:00:00.000Z");
  });
});

describe("Chat replies record what they used", () => {
  test("a reply answered from CodeForge's own data uses 0 tokens; a model reply is counted (estimated when unreported)", async () => {
    const h = await setupBacklogHarness("tokens-chat", { respond: () => "OTP codes expire after 5 minutes." });
    try {
      const deterministic = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Review?" });
      assert.equal(deterministic.assistantMessage.tokens, 0, "no model call");
      assert.equal(h.engine.calls.length, 0);

      // The scripted engine reports 100 input + 200 output tokens by default.
      const reported = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Explain how OTP works here." });
      assert.equal(h.engine.calls.length, 1);
      assert.equal(reported.assistantMessage.tokens, 300);
      assert.equal(reported.assistantMessage.tokensEstimated, false);

      h.engine.cost = null; // an engine that reports nothing → estimated from the prompt + reply text
      const estimated = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "And how are they delivered?" });
      assert.ok((estimated.assistantMessage.tokens ?? 0) > 0);
      assert.equal(estimated.assistantMessage.tokensEstimated, true);

      const listed = h.services.chat.listMessages(h.project.id, h.owner.id).at(-1)!;
      assert.equal(listed.tokens, estimated.assistantMessage.tokens, "persisted, not just returned");
      assert.equal(listed.tokensEstimated, true);

      const usage = h.services.tokenUsage.projectUsage(h.project.id, h.owner.id);
      assert.equal(usage.breakdown.chat.tokens, 300 + estimated.assistantMessage.tokens!);
      assert.equal(usage.breakdown.chat.operations, 2, "the 0-token reply isn't a model operation");
      assert.equal(usage.breakdown.chat.estimatedTokens, estimated.assistantMessage.tokens);
    } finally {
      h.close();
    }
  });
});

describe("project and account meters", () => {
  async function withUsage(label: string) {
    const h = await setupBacklogHarness(label);
    const task = createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "T", goal: "g", createdBy: h.owner.id });
    let attempt = 0;
    const insertRun = (startedAt: string, cost: Record<string, number> | null) =>
      h.platform.db
        .prepare(
          `INSERT INTO agent_runs (id, task_id, role, engine, attempt_number, status, input_json, cost_json, started_at, completed_at, owner_generation)
           VALUES (?, ?, 'implementer', 'fixture', ?, 'completed', '{}', ?, ?, ?, 0)`,
        )
        .run(randomUUID(), task.id, ++attempt, cost ? JSON.stringify(cost) : null, startedAt, startedAt);
    return { h, insertRun };
  }

  test("counts task runs this month, flags runs that reported nothing, and ignores earlier months", async () => {
    const { h, insertRun } = await withUsage("tokens-project");
    try {
      const now = new Date();
      const thisMonth = new Date(now.getTime() - 1000).toISOString();
      insertRun(thisMonth, { inputTokens: 1000, outputTokens: 500, reasoningTokens: 100 });
      insertRun(thisMonth, null);
      insertRun("2020-01-15T00:00:00.000Z", { inputTokens: 99999 });

      const usage = h.services.tokenUsage.projectUsage(h.project.id, h.owner.id);
      assert.equal(usage.breakdown.tasks.tokens, 1600);
      assert.equal(usage.breakdown.tasks.unreported, 1);
      assert.equal(usage.used, 1600);
      assert.equal(usage.unreportedOperations, 1);
      assert.equal(usage.budget, null);
      assert.equal(usage.remaining, null);
    } finally {
      h.close();
    }
  });

  test("a project budget gives remaining and percent; it never goes negative", async () => {
    const { h, insertRun } = await withUsage("tokens-budget");
    try {
      insertRun(new Date().toISOString(), { inputTokens: 1500, outputTokens: 500 });
      let usage = h.services.tokenUsage.setProjectBudget(h.project.id, h.owner.id, 10_000);
      assert.equal(usage.remaining, 8000);
      assert.equal(usage.percentUsed, 20);

      usage = h.services.tokenUsage.setProjectBudget(h.project.id, h.owner.id, 1000);
      assert.equal(usage.remaining, 0);
      assert.equal(usage.percentUsed, 200);

      usage = h.services.tokenUsage.setProjectBudget(h.project.id, h.owner.id, null);
      assert.equal(usage.budget, null);
    } finally {
      h.close();
    }
  });

  test("the account meter sums every project the user owns, against the account budget", async () => {
    const { h, insertRun } = await withUsage("tokens-account");
    try {
      insertRun(new Date().toISOString(), { inputTokens: 300, outputTokens: 200 });
      const account = h.services.tokenUsage.setAccountBudget(h.owner.id, 2000);
      assert.equal(account.used, 500);
      assert.equal(account.remaining, 1500);
      assert.deepEqual(account.projects.map((p) => [p.projectId, p.used]), [[h.project.id, 500]]);
    } finally {
      h.close();
    }
  });

  test("another user's project usage is not readable", async () => {
    const { h } = await withUsage("tokens-access");
    try {
      const strangerId = randomUUID();
      h.platform.users.insert({ id: strangerId, tenantId: "default", email: "x@example.com", name: "x", passwordHash: "", createdAt: new Date().toISOString() });
      assert.throws(() => h.services.tokenUsage.projectUsage(h.project.id, strangerId), NotFoundError);
    } finally {
      h.close();
    }
  });
});
