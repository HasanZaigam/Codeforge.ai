import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";

/**
 * Phase 4D.2.1 — regression coverage for a real reported incident: a user asked Chat to mark a Review
 * task Done using natural phrasing ("make the review task add profile to done") that the original,
 * narrow action-pattern regex didn't recognize. Because the message matched NO action pattern at all, it
 * fell through to the general free-text LLM path, which fabricated "I have updated the status of the
 * 'add profile' task to 'completed'..." while the real task stayed in REVIEW. This file verifies: (a) the
 * exact reported phrase and several natural variants are now recognized as action requests and handled
 * deterministically (MARK_DONE still honestly declines — no new lifecycle transition was added), (b)
 * hedged/conversational language about a task still never mutates and is free to fall through to the
 * general LLM path, and (c) a mixed read+action message never lets the read half mask a silently-dropped
 * action half.
 */

const REAL_TITLE = "Add profile (+) option still shown after reaching the maximum number of profiles allowed for this account";

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

function setReview(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.status = "REVIEW";
  h.platform.tasks.save(task, new Date().toISOString());
}

describe("Chat action fallback safety (Phase 4D.2.1)", () => {
  test("THE REPORTED INCIDENT: 'make the review task add profile to done' is detected as an action, never falls through to the LLM, and never falsely claims success", async () => {
    const h = await setupBacklogHarness("fb-incident");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "make the review task add profile to done" });

      assert.equal(h.engine.calls.length, 0, "the action was recognized deterministically — the general LLM path must never have been called");
      assert.doesNotMatch(assistantMessage.content, /i (?:'ve |have )?(?:already )?(?:updated|marked|changed|completed|closed|resolved)/i);
      // Phase 4D.4 — a REVIEW task's completion request now PROPOSES (never mutates on the first
      // message, no matter how explicit the wording). This is the new, correct behavior superseding
      // this test's original "always decline" expectation from before human-confirmed completion existed.
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW", "the real task must be untouched");

      const events = h.platform.taskEvents.listForTask(t.id);
      assert.equal(events.some((e) => e.type === "CHAT_ACTION_PERFORMED"), false, "no audit event — nothing was actually mutated");
    } finally {
      h.close();
    }
  });

  const naturalVariants = [
    "mark the review task add profile done",
    "make the add profile task done",
    "move the add profile task to done",
    "set the add profile task to completed",
    "complete the add profile review task",
  ];
  for (const phrase of naturalVariants) {
    test(`NATURAL VARIANT: '${phrase}' is detected and safely declined, never a false success`, async () => {
      const h = await setupBacklogHarness(`fb-variant-${naturalVariants.indexOf(phrase)}`);
      try {
        const t = await mk(h, REAL_TITLE);
        setReview(h, t.id);

        const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: phrase });

        assert.equal(h.engine.calls.length, 0, `"${phrase}" must be handled deterministically, never via the LLM`);
        assert.doesNotMatch(assistantMessage.content, /✓/);
        assert.doesNotMatch(assistantMessage.content, /i (?:'ve |have )?(?:already )?(?:updated|marked|changed|completed|closed|resolved)/i);
        assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
      } finally {
        h.close();
      }
    });
  }

  test("SUPPORTED ACTIONS still work end-to-end after the broadened detection (no regression)", async () => {
    const h = await setupBacklogHarness("fb-supported-regression");
    try {
      const t1 = await mk(h, "Fix login");
      const r1 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Start "Fix login".' });
      assert.match(r1.assistantMessage.content, /✓ "Fix login" is now To do/);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "TODO");

      const t2 = await mk(h, "Cancel me");
      const r2 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Cancel "Cancel me".' });
      assert.match(r2.assistantMessage.content, /✓ "Cancel me" is now Cancelled/);
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "CANCELLED");

      const t3 = await mk(h, "Old name");
      const r3 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Rename "Old name" title to New name.' });
      assert.match(r3.assistantMessage.content, /✓ Renamed to "New name"/);
      assert.equal(h.platform.tasks.findById(t3.id)!.title, "New name");

      const r4 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Create a task for improving error messages." });
      assert.match(r4.assistantMessage.content, /✓ Created task/);

      // id-based start, exercising resolveActionTarget's id-match branch through the real Chat pipeline.
      const t5 = await mk(h, "Id-addressed task");
      const r5 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: `Start ${t5.id}.` });
      assert.match(r5.assistantMessage.content, /✓ "Id-addressed task" is now To do/);
      assert.equal(h.platform.tasks.findById(t5.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("CONVERSATIONAL statement about a task is never treated as a command: 'I think the add profile task should be done.'", async () => {
    const h = await setupBacklogHarness("fb-conversational");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: `I think the ${REAL_TITLE.toLowerCase()} task should be done.` });

      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW", "hedged language must never mutate state");
    } finally {
      h.close();
    }
  });

  test("MULTI-INTENT: 'How many tasks are in Review, and make the oldest Review task Done.' answers the read part AND safely declines the action part", async () => {
    const h = await setupBacklogHarness("fb-multi-intent");
    try {
      const t = await mk(h, REAL_TITLE);
      setReview(h, t.id);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "How many tasks are in Review, and make the oldest Review task Done.",
      });

      assert.match(assistantMessage.content, /1 task is currently in Review/);
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.doesNotMatch(assistantMessage.content, /i (?:'ve |have )?(?:already )?(?:updated|marked|changed|completed|closed|resolved)/i);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW", "the read half must never mask a silently-dropped or falsely-succeeded action half");
    } finally {
      h.close();
    }
  });

  test("no tasks in the mentioned status: an oldest-status action target that doesn't exist fails gracefully, never falls through to the LLM", async () => {
    const h = await setupBacklogHarness("fb-oldest-empty");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "make the oldest review task done" });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /no tasks in review/i);
    } finally {
      h.close();
    }
  });

  test("DEFENSE IN DEPTH: if the free-text LLM path ever produces a false completion claim anyway, it is scrubbed before reaching the user", async () => {
    const h = await setupBacklogHarness("fb-scrubber", { respond: () => 'I have updated the status of the "add profile" task to "completed" in our internal tracking list.' });
    try {
      // A message the action parser genuinely does not recognize as a mutation request, so it legitimately
      // reaches the free-text path — but that path has no mutation capability, so ANY first-person
      // completion claim it produces must be caught in code, not just prevented by prompting.
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What do you think about the add profile bug overall?" });
      assert.equal(h.engine.calls.length, 1);
      assert.doesNotMatch(assistantMessage.content, /i (?:'ve |have )?(?:already )?updated/i);
      assert.match(assistantMessage.content, /can't make changes to tasks through general conversation/i);
    } finally {
      h.close();
    }
  });
});
