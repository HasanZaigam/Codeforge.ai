import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitIntoClauses } from "../src/application/chat-intent.js";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";

/**
 * Phase 4D.3.1 — a real reported incident: a task title containing a bug-id reference list in
 * parentheses ("... (BUG-036, BUG-037)") was split right at the internal comma by the naive
 * `,\s*and\s+|\s+and\s+|,\s+` clause splitter, breaking the title in half so neither half could resolve
 * to the real task — the whole message fell through as two garbled "I couldn't answer" fragments instead
 * of being recognized as one task-reference + one mutation request. This file covers both layers: direct
 * unit tests on `splitIntoClauses` itself (fast, precise — exactly the function the incident pointed at),
 * and end-to-end tests through the real `sendMessage` pipeline for the full resolve + classify + decline
 * behavior.
 */

const REAL_TITLE = "Add profile (+) option still shown after reaching the maximum number of profiles (BUG-036, BUG-037)";

describe("splitIntoClauses — comma/bracket/quote-aware splitting (Phase 4D.3.1)", () => {
  test("THE EXACT REPORTED MESSAGE stays ONE clause — the comma inside (BUG-036, BUG-037) must never split it", () => {
    const clauses = splitIntoClauses(`${REAL_TITLE} make this task from review to done`);
    assert.equal(clauses.length, 1);
    assert.equal(clauses[0], `${REAL_TITLE} make this task from review to done`);
  });

  test("a bug-id list with NO surrounding parentheses also stays unsplit", () => {
    const clauses = splitIntoClauses("Add profile issue BUG-036, BUG-037 still broken make this task done");
    assert.equal(clauses.length, 1);
  });

  test("a three-item bug-id list stays unsplit", () => {
    const clauses = splitIntoClauses("Fix the login flow (BUG-036, BUG-037, BUG-040) and start it");
    // The "and start it" IS a legitimate second request outside the parens — only the INTERNAL commas of
    // the bug-id list must stay protected.
    assert.equal(clauses.length, 2);
    assert.equal(clauses[0], "Fix the login flow (BUG-036, BUG-037, BUG-040)");
    assert.equal(clauses[1], "start it");
  });

  test("a comma inside plain parentheses (not a bug-id list) also stays unsplit", () => {
    const clauses = splitIntoClauses("Cancel the task (reported by Alice, confirmed by Bob)");
    assert.equal(clauses.length, 1);
  });

  test("a comma inside square brackets also stays unsplit", () => {
    const clauses = splitIntoClauses("Start the task [priority: high, owner: Alice]");
    assert.equal(clauses.length, 1);
  });

  test("a comma inside a quoted phrase also stays unsplit", () => {
    const clauses = splitIntoClauses('Rename "Fix login, signup" title to "Fix auth flow"');
    assert.equal(clauses.length, 1);
  });

  test("ordinary multi-intent commas and 'and' STILL split correctly (no regression)", () => {
    const clauses = splitIntoClauses("How many tasks are in Review, and which is the oldest?");
    assert.equal(clauses.length, 2);
    assert.equal(clauses[0], "How many tasks are in Review");
    assert.equal(clauses[1], "which is the oldest");
  });

  test("a bug-id list followed by an unrelated action request still splits at the real boundary", () => {
    const clauses = splitIntoClauses("Tell me about BUG-036, BUG-037 and make the Add profile task done");
    assert.equal(clauses.length, 2);
    assert.equal(clauses[0], "Tell me about BUG-036, BUG-037");
    assert.equal(clauses[1], "make the Add profile task done");
  });

  test("a short status enumeration still stays one clause (pre-existing behavior unchanged)", () => {
    const clauses = splitIntoClauses("How many tasks are in Backlog, To Do, Working, and Failed?");
    assert.equal(clauses.length, 1);
  });

  test("a task title with a colon and a hyphen is not affected by this fix (no comma/parens involved)", () => {
    const clauses = splitIntoClauses("Rename TASK-1 title to Fix auth: login-page redirect");
    assert.equal(clauses.length, 1);
  });

  test("a task title with a forward slash is not affected by this fix", () => {
    const clauses = splitIntoClauses("Start the task A/B test rollout");
    assert.equal(clauses.length, 1);
  });
});

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

function setReview(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.status = "REVIEW";
  h.platform.tasks.save(task, new Date().toISOString());
}

describe("Chat end-to-end: task resolution + action classification with bug-id lists (Phase 4D.3.1)", () => {
  test("1. THE EXACT REPORTED MESSAGE: task is found, and a human-completion confirmation is proposed (never an immediate mutation)", async () => {
    const h = await setupBacklogHarness("cs-incident");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: `${REAL_TITLE} make this task from review to done`,
      });

      assert.equal(h.engine.calls.length, 0, "the action was recognized and resolved deterministically — the LLM must never be called");
      assert.doesNotMatch(assistantMessage.content, /i couldn't answer/i, "must not fall back to a garbled 'I couldn't answer' fragment");
      assert.doesNotMatch(assistantMessage.content, /✓/);
      // Phase 4D.4 — REVIEW -> DONE is now a legitimate human-confirmed transition; resolving the task
      // correctly leads to a confirmation PROPOSAL, not an automatic decline. Nothing mutates yet either way.
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW", "the real task must be untouched");

      const events = h.platform.taskEvents.listForTask(t.id);
      assert.equal(events.some((e) => e.type === "CHAT_ACTION_PERFORMED"), false, "no audit event — nothing was mutated");
    } finally {
      h.close();
    }
  });

  test("2. 'Make the Add profile (+) option task done.' resolves via fuzzy title match despite the parenthesis/plus sign", async () => {
    const h = await setupBacklogHarness("cs-variant-make");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Make the Add profile (+) option task done." });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("3. 'Move the Add profile (+) option task to done.' resolves the same way", async () => {
    const h = await setupBacklogHarness("cs-variant-move");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Move the Add profile (+) option task to done." });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("4. 'Complete the Add profile (+) option task.' resolves the same way", async () => {
    const h = await setupBacklogHarness("cs-variant-complete");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Complete the Add profile (+) option task." });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("5. 'Show me the Add profile (+) option task (BUG-036, BUG-037)' — the bug ids must not break parsing into garbled fragments", async () => {
    const h = await setupBacklogHarness("cs-variant-show");
    try {
      await mk(h, REAL_TITLE);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "Show me the Add profile (+) option task (BUG-036, BUG-037)",
      });
      // Whether this specific phrasing resolves to a recognized deterministic intent or falls through to
      // the general model as ONE coherent question, it must never come back as the tell-tale symptom of
      // the original bug: two disconnected fragments quoting half a task title each.
      assert.doesNotMatch(assistantMessage.content, /i couldn't answer.*BUG-036.*i couldn't answer/is);
    } finally {
      h.close();
    }
  });

  test("MULTI-INTENT REGRESSION: 'How many tasks are in Review, which is the oldest, and what is blocking it?' still works", async () => {
    const h = await setupBacklogHarness("cs-multi-intent-regression");
    try {
      const t = await mk(h, "Some review task");
      setReview(h, t.id);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "How many tasks are in Review, which is the oldest, and what is blocking it?",
      });
      assert.match(assistantMessage.content, /1 task is currently in Review/);
      assert.match(assistantMessage.content, /oldest task in Review/);
      assert.match(assistantMessage.content, /waiting on human review/);
    } finally {
      h.close();
    }
  });

  test("MULTI-INTENT + BUG-ID LIST: 'Tell me about BUG-036, BUG-037 and make the Add profile task done.' splits at the real boundary, not inside the list", async () => {
    const h = await setupBacklogHarness("cs-multi-intent-bugids");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "Tell me about BUG-036, BUG-037 and make the Add profile task done.",
      });
      // The first clause ("Tell me about BUG-036, BUG-037") matches no supported read intent and no
      // action pattern, so it's an honest "couldn't answer" — but the SECOND clause (the real action
      // request) must still be recognized, resolved, and proposed for confirmation, never silently dropped.
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });
});
