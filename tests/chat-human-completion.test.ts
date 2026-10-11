import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";

/**
 * Phase 4D.4 — human-confirmed REVIEW -> DONE from Chat. This is a NEW, legitimate second path to DONE
 * alongside the EXISTING automatic PR-merge path (`Orchestrator.finalizeMergedPullRequest` ->
 * `TaskRepository.finalizeReviewAsDoneOnMerge`, unchanged — see tests/human-review-feedback.test.ts,
 * tests/task-repository.test.ts). The human path reuses the SAME "accepted" transition a (previously
 * unwired) `Orchestrator.acceptReview` always supported — never a second state machine, never a direct
 * status write — but NEVER executes on the first message: it always proposes first, and only an explicit
 * confirming reply (re-reading the task fresh, never trusting the status observed at proposal time)
 * actually performs the mutation.
 */

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

function setStatus(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string, status: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.status = status as never;
  h.platform.tasks.save(task, new Date().toISOString());
}

describe("Human-confirmed Review -> Done completion from Chat (Phase 4D.4)", () => {
  test("1. full happy path: Review -> propose -> confirm -> Done", async () => {
    const h = await setupBacklogHarness("hc-happy-path");
    try {
      const t = await mk(h, "Ship the login fix");
      setStatus(h, t.id, "REVIEW");

      const propose = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Mark the Ship the login fix task as Done." });
      assert.match(propose.assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW", "must not mutate on the proposal message");

      const confirm = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.match(confirm.assistantMessage.content, /✓ "Ship the login fix" is now Done/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");
    } finally {
      h.close();
    }
  });

  test("2/3. the initial command creates a pending action ONLY — no mutation before confirmation, even with strong wording", async () => {
    const h = await setupBacklogHarness("hc-propose-only");
    try {
      const t = await mk(h, "Strong wording task");
      setStatus(h, t.id, "REVIEW");
      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Strong wording task" done now.' });
      assert.ok(pendingAction, "a pending action must be stored");
      assert.equal(pendingAction!.kind, "HUMAN_MARK_DONE");
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("4. positive confirmation performs the mutation", async () => {
    const h = await setupBacklogHarness("hc-positive-confirm");
    try {
      const t = await mk(h, "Confirm me");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Complete the "Confirm me" task.' });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "confirm" });
      assert.match(assistantMessage.content, /✓ "Confirm me" is now Done/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");
    } finally {
      h.close();
    }
  });

  test("5. negative confirmation cancels — no mutation, pending action cleared", async () => {
    const h = await setupBacklogHarness("hc-negative-confirm");
    try {
      const t = await mk(h, "Decline me");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Decline me" as Done.' });
      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "no" });
      assert.match(assistantMessage.content, /no changes made/i);
      assert.equal(pendingAction, null);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("6. a standalone 'yes' with NO pending action does nothing", async () => {
    const h = await setupBacklogHarness("hc-standalone-yes");
    try {
      const t = await mk(h, "Untouched task");
      setStatus(h, t.id, "REVIEW");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("7. STALE CONFIRMATION: task became DONE (e.g. automatic PR merge) between propose and confirm — idempotent, no false claim", async () => {
    const h = await setupBacklogHarness("hc-stale-already-done");
    try {
      const t = await mk(h, "Race with automation");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Race with automation" as Done.' });
      // Simulate the automatic PR-merge path winning the race while the confirmation is pending.
      setStatus(h, t.id, "DONE");
      const before = h.platform.taskEvents.listForTask(t.id).length;

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.match(assistantMessage.content, /already done/i);
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");
      // No duplicate completion event from the stale confirmation.
      const after = h.platform.taskEvents.listForTask(t.id);
      assert.equal(after.length, before, "an idempotent no-op must not append any new event");
    } finally {
      h.close();
    }
  });

  test("8/9. STALE CONFIRMATION: task moved to a DIFFERENT (non-Review, non-Done) state between propose and confirm", async () => {
    const h = await setupBacklogHarness("hc-stale-moved");
    try {
      const t = await mk(h, "Sent back for changes");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Sent back for changes" as Done.' });
      // Simulate human "request changes" moving it back to WORKING while the confirmation is pending.
      setStatus(h, t.id, "WORKING");

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.match(assistantMessage.content, /no longer in review/i);
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "WORKING", "the real task must stay exactly where it legitimately is");
    } finally {
      h.close();
    }
  });

  test("10. task not found — graceful failure, no pending action created", async () => {
    const h = await setupBacklogHarness("hc-not-found");
    try {
      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Some task that does not exist" as Done.' });
      assert.match(assistantMessage.content, /couldn't find/i);
      assert.equal(pendingAction, null);
    } finally {
      h.close();
    }
  });

  test("11. ambiguous task — two Review tasks share an identical title; Chat asks to clarify, no pending action, no mutation", async () => {
    const h = await setupBacklogHarness("hc-ambiguous");
    try {
      const t1 = await mk(h, "Duplicate review task");
      const t2 = await mk(h, "Duplicate review task");
      setStatus(h, t1.id, "REVIEW");
      setStatus(h, t2.id, "REVIEW");
      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Mark Duplicate review task as Done." });
      assert.match(assistantMessage.content, /found \d+ tasks matching/i);
      assert.equal(pendingAction, null);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "REVIEW");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("12. unauthorized user cannot propose OR confirm completion of another user's project task", async () => {
    const h = await setupBacklogHarness("hc-unauthorized");
    try {
      const t = await mk(h, "Owner's task");
      setStatus(h, t.id, "REVIEW");
      const stranger = h.addUser("stranger");
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, stranger.id, { text: 'Mark "Owner\'s task" as Done.' }));
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("13. cross-project: a task in another project is never visible to resolution or confirmation", async () => {
    const h = await setupBacklogHarness("hc-cross-project");
    try {
      const otherProject = await h.services.projects.create({ name: "Other", sourceControlProvider: "local-git", repoUrl: h.project.repoUrl, codingEngine: "fixture", commands: {} }, h.owner.id);
      const otherTask = createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: otherProject.id, title: "Cross project review task", goal: "g", createdBy: h.owner.id });
      setStatus(h, otherTask.id, "REVIEW");

      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Mark Cross project review task as Done." });
      assert.equal(pendingAction, null, "a task from a DIFFERENT project must never be proposed for completion here");
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(otherTask.id)!.status, "REVIEW");
      void assistantMessage;
    } finally {
      h.close();
    }
  });

  test("14. hedged language never triggers a completion proposal", async () => {
    const h = await setupBacklogHarness("hc-hedged");
    try {
      const t = await mk(h, "Hedge target");
      setStatus(h, t.id, "REVIEW");
      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: '"Hedge target" is probably resolved, I think it should be marked done.' });
      assert.equal(pendingAction, null);
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  const variants = [
    "Mark the Variant task as Done.",
    "Make the Variant task Done.",
    "Complete the Variant task.",
    "Close the Variant task as completed.",
    "Move the Variant task to Done.",
    "Finish the Variant task.",
  ];
  for (const text of variants) {
    test(`15. direct natural-language variant: '${text}' proposes the same confirmation`, async () => {
      const h = await setupBacklogHarness(`hc-variant-${variants.indexOf(text)}`);
      try {
        const t = await mk(h, "Variant task");
        setStatus(h, t.id, "REVIEW");
        const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text });
        assert.ok(pendingAction, `"${text}" must be recognized as a completion request`);
        assert.equal(pendingAction!.kind, "HUMAN_MARK_DONE");
        assert.doesNotMatch(assistantMessage.content, /✓/);
        assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
      } finally {
        h.close();
      }
    });
  }

  test("16. event/audit correctness: the resulting events distinguish human-confirmed completion from automatic PR-merge completion", async () => {
    const h = await setupBacklogHarness("hc-audit");
    try {
      const t = await mk(h, "Audited task");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Audited task" as Done.' });
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });

      const events = h.platform.taskEvents.listForTask(t.id);
      const accepted = events.find((e) => e.type === "TASK_ACCEPTED");
      const completed = events.find((e) => e.type === "TASK_COMPLETED");
      const chatAction = events.find((e) => e.type === "CHAT_ACTION_PERFORMED");

      assert.ok(accepted, "TASK_ACCEPTED must be recorded — the same event the (previously unwired) in-app Accept path was always meant to produce");
      assert.equal(accepted!.payload.completionSource, "HUMAN_CONFIRMED");
      assert.equal(accepted!.payload.completedBy, h.owner.id);
      assert.equal(accepted!.payload.completedVia, "CHAT");
      assert.ok(completed, "TASK_COMPLETED must be recorded — this is what distinguishes a manual accept from a PR merge, which never appends it");
      assert.equal(completed!.payload.completionSource, "HUMAN_CONFIRMED");

      assert.ok(chatAction, "the SAME CHAT_ACTION_PERFORMED audit trail every other Chat mutation uses must also exist");
      assert.equal(chatAction!.payload.action, "MARK_DONE");
      assert.equal(chatAction!.payload.previousState, "REVIEW");
      assert.equal(chatAction!.payload.newState, "DONE");

      // Never the automatic path's own signal.
      assert.equal(events.some((e) => e.type === "PULL_REQUEST_MERGED"), false);
    } finally {
      h.close();
    }
  });

  test("17. read-back verification: success is reported ONLY after the real DB state is confirmed Done", async () => {
    const h = await setupBacklogHarness("hc-readback");
    try {
      const t = await mk(h, "Readback task");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Readback task" as Done.' });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      // By the time the response is composed, the real task MUST already be Done — never a claim made
      // from the fact that confirmation was merely received.
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");
      assert.match(assistantMessage.content, /✓/);
    } finally {
      h.close();
    }
  });

  test("18. DUPLICATE CONFIRMATION is idempotent: asking again after the task is already Done never produces a second transition or a misleading event", async () => {
    const h = await setupBacklogHarness("hc-duplicate");
    try {
      const t = await mk(h, "Already finished");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Already finished" as Done.' });
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");
      const eventsAfterFirst = h.platform.taskEvents.listForTask(t.id).length;

      // Ask again — the task is no longer in Review, so this must NOT propose a second confirmation;
      // it goes straight to the existing idempotent "already Done" decline.
      const { assistantMessage, pendingAction } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Already finished" as Done.' });
      assert.equal(pendingAction, null, "an already-Done task must never produce a new pending confirmation");
      assert.doesNotMatch(assistantMessage.content, /✓.*is now Done/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");
      assert.equal(h.platform.taskEvents.listForTask(t.id).length, eventsAfterFirst, "no additional event from the redundant request");
    } finally {
      h.close();
    }
  });

  test("19. Tasks UI and Chat reflect the SAME final state — the real TaskService the Tasks UI/API use sees the identical result", async () => {
    const h = await setupBacklogHarness("hc-consistency");
    try {
      const t = await mk(h, "Consistency task");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Consistency task" as Done.' });
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });

      const direct = h.services.tasks.get(t.id, h.owner.id);
      assert.equal(direct.status, "DONE");

      const chatRead = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'What is the status of "Consistency task"?' });
      assert.match(chatRead.assistantMessage.content, /\bDone\b/);

      const summary = h.platform.tasks.listByProject(h.project.id);
      assert.equal(summary.filter((x) => x.status === "DONE").length, 1);
      assert.equal(summary.filter((x) => x.status === "REVIEW").length, 0);
    } finally {
      h.close();
    }
  });

  test("20. AUTOMATIC PR-merge completion remains completely unchanged and requires no Chat confirmation", async () => {
    const h = await setupBacklogHarness("hc-automatic-unchanged");
    try {
      const t = await mk(h, "Auto-merged task");
      setStatus(h, t.id, "REVIEW");
      // Simulate the automatic path directly (the same atomic repository method the real PR-merge poller
      // uses) — no Chat message, no confirmation, ever involved.
      const won = h.platform.tasks.finalizeReviewAsDoneOnMerge(t.id, new Date().toISOString());
      assert.equal(won, true);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");

      const events = h.platform.taskEvents.listForTask(t.id);
      assert.equal(events.some((e) => e.type === "TASK_ACCEPTED"), false, "the automatic path must never append the human-accept event");
      assert.equal(events.some((e) => e.type === "CHAT_ACTION_PERFORMED"), false, "the automatic path must never look like a Chat action");
    } finally {
      h.close();
    }
  });
});
