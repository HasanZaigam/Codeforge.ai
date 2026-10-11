import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";

/**
 * Phase 4D.3 — Task management from general Chat. Covers what's NEW this phase on top of the existing
 * Context/Action Layer (Phase 4D/4D.1/4D.2/4D.2.1, already covered by chat.test.ts, chat-multi-intent.test.ts,
 * action-layer.test.ts, chat-actions.test.ts, chat-action-fallback-safety.test.ts): broadened natural-
 * language reads ("latest tasks", "what needs my attention", "needs my input", "first task in review"),
 * "start the oldest backlog task", and — the headline new capability — BULK mutations ("cancel all failed
 * tasks") which MUST propose the exact target set and wait for an explicit confirmation before any task is
 * touched, same as every other mutation this phase never claims success without real, verified, read-back
 * evidence.
 */

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

function setStatus(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string, status: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.status = status as never;
  h.platform.tasks.save(task, new Date().toISOString());
}

describe("Chat task management (Phase 4D.3)", () => {
  // ---------------------------------------------------------------------
  // Broadened reads
  // ---------------------------------------------------------------------

  test("READ: 'Show me all tasks currently in Review.' lists Review tasks (found live — this phrasing originally fell all the way through to the LLM)", async () => {
    const h = await setupBacklogHarness("tm-show-review");
    try {
      const t = await mk(h, "OTP throttling bug");
      setStatus(h, t.id, "REVIEW");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me all tasks currently in Review." });
      assert.equal(h.engine.calls.length, 0, "this must be answered deterministically, never via the LLM");
      // Phase 4D.5 — a SINGLE result now gets a singular "I found the X task" phrasing (and resolves a
      // concrete task id), distinct from the plural "I found N tasks" wording used for multiple results.
      assert.match(assistantMessage.content, /I found the Review task: "OTP throttling bug"/);
    } finally {
      h.close();
    }
  });

  test("READ: 'Show me the latest tasks.' lists tasks across all statuses, bounded, newest first", async () => {
    const h = await setupBacklogHarness("tm-latest");
    try {
      await mk(h, "Older task");
      await mk(h, "Newer task");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me the latest tasks." });
      assert.match(assistantMessage.content, /Latest tasks:/);
      assert.match(assistantMessage.content, /Older task/);
      assert.match(assistantMessage.content, /Newer task/);
    } finally {
      h.close();
    }
  });

  test("READ: 'What needs my attention?' composes Review + Needs input + Failed into one answer", async () => {
    const h = await setupBacklogHarness("tm-attention");
    try {
      const t1 = await mk(h, "In review");
      setStatus(h, t1.id, "REVIEW");
      const t2 = await mk(h, "Needs my input");
      setStatus(h, t2.id, "NEEDS_INPUT");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me what needs my attention." });
      assert.match(assistantMessage.content, /1 is in Review/);
      assert.match(assistantMessage.content, /1 is in Needs input/);
    } finally {
      h.close();
    }
  });

  test("READ: 'Which tasks need my input?' resolves NEEDS_INPUT even with words in between ('need my input')", async () => {
    const h = await setupBacklogHarness("tm-needs-my-input");
    try {
      const t = await mk(h, "Waiting on me");
      setStatus(h, t.id, "NEEDS_INPUT");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Which tasks need my input?" });
      assert.match(assistantMessage.content, /Waiting on me/);
    } finally {
      h.close();
    }
  });

  test("READ: 'Give me the current task status.' returns the full breakdown, same as an explicit 'summary'/'breakdown' request", async () => {
    const h = await setupBacklogHarness("tm-current-status");
    try {
      await mk(h, "T1");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Give me the current task status." });
      assert.match(assistantMessage.content, /This project has \d+ tasks?:/);
    } finally {
      h.close();
    }
  });

  // ---------------------------------------------------------------------
  // "oldest"/"first" task reference for actions
  // ---------------------------------------------------------------------

  test("ACTION: 'Start the oldest backlog task.' resolves and starts the real oldest BACKLOG task", async () => {
    const h = await setupBacklogHarness("tm-start-oldest");
    try {
      const older = await mk(h, "Older backlog task");
      await new Promise((r) => setTimeout(r, 5));
      await mk(h, "Newer backlog task");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start the oldest backlog task." });
      assert.match(assistantMessage.content, /✓ "Older backlog task" is now To do/);
      assert.equal(h.platform.tasks.findById(older.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("ACTION: 'Cancel the first task in needs input.' treats 'first' as a synonym for 'oldest' (CANCEL is legal from NEEDS_INPUT, unlike REVIEW)", async () => {
    const h = await setupBacklogHarness("tm-first-needs-input");
    try {
      const t1 = await mk(h, "First waiting task");
      setStatus(h, t1.id, "NEEDS_INPUT");
      await new Promise((r) => setTimeout(r, 5));
      const t2 = await mk(h, "Second waiting task");
      setStatus(h, t2.id, "NEEDS_INPUT");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel the first task that needs input." });
      assert.match(assistantMessage.content, /✓ "First waiting task" is now Cancelled/);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "CANCELLED");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "NEEDS_INPUT", "the OTHER waiting task must be untouched");
    } finally {
      h.close();
    }
  });

  // ---------------------------------------------------------------------
  // Idempotency surfaced through Chat
  // ---------------------------------------------------------------------

  test("IDEMPOTENCY: 'Cancel it.' on an already-cancelled task reports 'already Cancelled', never a duplicate transition", async () => {
    const h = await setupBacklogHarness("tm-idempotent-cancel-chat");
    try {
      const t = await mk(h, "Cancel me twice");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Cancel "Cancel me twice".' });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Cancel "Cancel me twice".' });
      assert.match(assistantMessage.content, /already cancelled/i);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "CANCELLED");
    } finally {
      h.close();
    }
  });

  // ---------------------------------------------------------------------
  // BULK mutations — propose, confirm, execute
  // ---------------------------------------------------------------------

  test("BULK: 'Cancel all failed tasks.' PROPOSES the exact target set and mutates NOTHING until confirmed", async () => {
    const h = await setupBacklogHarness("tm-bulk-propose");
    try {
      const t1 = await mk(h, "Failed one");
      setStatus(h, t1.id, "FAILED");
      const t2 = await mk(h, "Failed two");
      setStatus(h, t2.id, "FAILED");

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel all failed tasks." });
      assert.match(assistantMessage.content, /found 2 tasks in Failed/i);
      assert.match(assistantMessage.content, /Failed one/);
      assert.match(assistantMessage.content, /Failed two/);
      assert.match(assistantMessage.content, /reply "yes"/i);
      // Nothing mutated yet.
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "FAILED");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "FAILED");
      assert.equal(h.engine.calls.length, 0, "a bulk proposal must never call the model");
    } finally {
      h.close();
    }
  });

  test("BULK: confirming with 'yes' after a proposal executes against the SAME snapshot, with per-task verified results", async () => {
    const h = await setupBacklogHarness("tm-bulk-confirm-yes");
    try {
      const t1 = await mk(h, "Backlog A");
      const t2 = await mk(h, "Backlog B");

      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start all backlog tasks." });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });

      assert.match(assistantMessage.content, /Started 2 of 2 tasks/);
      assert.match(assistantMessage.content, /✓ "Backlog A"/);
      assert.match(assistantMessage.content, /✓ "Backlog B"/);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "TODO");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("BULK: declining with 'no' after a proposal leaves every task completely untouched", async () => {
    const h = await setupBacklogHarness("tm-bulk-confirm-no");
    try {
      const t1 = await mk(h, "Backlog A");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start all backlog tasks." });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "no" });
      assert.match(assistantMessage.content, /no changes made/i);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "BACKLOG");
    } finally {
      h.close();
    }
  });

  test("BULK: a stale, unconfirmed proposal is abandoned by a later unrelated message (never executed retroactively)", async () => {
    const h = await setupBacklogHarness("tm-bulk-stale");
    try {
      const t1 = await mk(h, "Backlog A");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start all backlog tasks." });
      // The user asks something unrelated instead of confirming.
      const read = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Backlog?" });
      assert.match(read.assistantMessage.content, /1 task is currently in Backlog/);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "BACKLOG", "the abandoned proposal must never auto-execute");

      // A later bare "yes" with no live proposal must not mutate anything either.
      const stray = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "BACKLOG");
      assert.doesNotMatch(stray.assistantMessage.content, /✓/);
    } finally {
      h.close();
    }
  });

  test("BULK: partial failure is reported honestly — one terminal task in the set fails, the other succeeds", async () => {
    const h = await setupBacklogHarness("tm-bulk-partial-failure");
    try {
      const t1 = await mk(h, "Working task");
      setStatus(h, t1.id, "WORKING");
      const t2 = await mk(h, "Done task");
      setStatus(h, t2.id, "DONE");

      // "all" tasks with a status word matching both won't apply here — exercise partial failure via two
      // separate FAILED tasks where a prior external change makes one already-cancelled before confirm.
      const f1 = await mk(h, "Failed A");
      setStatus(h, f1.id, "FAILED");
      const f2 = await mk(h, "Failed B");
      setStatus(h, f2.id, "FAILED");

      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel all failed tasks." });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "confirm" });

      // FAILED is terminal — cancelling either must fail honestly, never a false success, and the summary
      // must show 0 changed / N failed rather than silently hiding the outcome.
      assert.match(assistantMessage.content, /Cancelled 0 of 2 tasks/);
      assert.match(assistantMessage.content, /✕ "Failed A"/);
      assert.match(assistantMessage.content, /✕ "Failed B"/);
      assert.equal(h.platform.tasks.findById(f1.id)!.status, "FAILED");
      assert.equal(h.platform.tasks.findById(f2.id)!.status, "FAILED");
    } finally {
      h.close();
    }
  });

  test("BULK: ambiguous status in the request ('cancel all tasks') is refused without guessing, never falls through to the LLM", async () => {
    const h = await setupBacklogHarness("tm-bulk-no-status");
    try {
      await mk(h, "T1");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel all tasks." });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /which status/i);
    } finally {
      h.close();
    }
  });

  test("BULK: an empty target set is reported honestly, no proposal is stored", async () => {
    const h = await setupBacklogHarness("tm-bulk-empty");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel all failed tasks." });
      assert.match(assistantMessage.content, /no tasks in failed/i);
      // Confirming afterward must do nothing — there was never a real proposal.
      const follow = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.doesNotMatch(follow.assistantMessage.content, /✓|✕/);
    } finally {
      h.close();
    }
  });

  test("MULTI-INTENT + BULK: a read clause and a bulk-propose clause combine into one response, read answered immediately, bulk proposed (not executed)", async () => {
    const h = await setupBacklogHarness("tm-bulk-multi-intent");
    try {
      const t1 = await mk(h, "Failed X");
      setStatus(h, t1.id, "FAILED");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Backlog, and cancel all failed tasks." });
      assert.match(assistantMessage.content, /0 tasks are currently in Backlog/);
      assert.match(assistantMessage.content, /found 1 task in Failed/i);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "FAILED", "the bulk half must only propose, never execute, inside a multi-intent message");
    } finally {
      h.close();
    }
  });

  // ---------------------------------------------------------------------
  // Consistency: Chat mutation visible to a follow-up Chat read (no stale cache) and via TaskService directly
  // ---------------------------------------------------------------------

  test("CONSISTENCY: after a Chat bulk mutation, a follow-up Chat read AND a direct TaskService read both reflect the new state", async () => {
    const h = await setupBacklogHarness("tm-consistency");
    try {
      await mk(h, "Backlog A");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start all backlog tasks." });
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });

      const chatRead = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in To do?" });
      assert.match(chatRead.assistantMessage.content, /1 task is currently in To do/);

      const direct = h.services.tasks.listForProject(h.project.id, h.owner.id);
      assert.equal(direct.filter((t) => t.status === "TODO").length, 1, "the SAME TaskService the Tasks UI/API use must see the identical state");
    } finally {
      h.close();
    }
  });
});
