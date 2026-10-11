import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";

/**
 * Phase 4D.2 — Chat Action Layer integration. Verifies Chat mutations end-to-end through the real
 * `sendMessage` pipeline: every claimed success is checked against the REAL database state, never just
 * the assistant's own words.
 */

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

describe("Chat actions (Phase 4D.2)", () => {
  test("CREATE: 'Create a task for fixing OTP throttling.' — real Task appears in BACKLOG, not started", async () => {
    const h = await setupBacklogHarness("ca-create");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Create a task for fixing OTP throttling." });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /✓ Created task/);
      const tasks = h.platform.tasks.listByProject(h.project.id);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.status, "BACKLOG");
    } finally {
      h.close();
    }
  });

  test("START: 'Start \"Fix login\".' actually moves BACKLOG -> TODO in the real database", async () => {
    const h = await setupBacklogHarness("ca-start");
    try {
      const t = await mk(h, "Fix login");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Start "Fix login".' });
      assert.match(assistantMessage.content, /✓ "Fix login" is now To do/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("CANCEL: 'Cancel \"Fix login\".' actually moves the real task to CANCELLED", async () => {
    const h = await setupBacklogHarness("ca-cancel");
    try {
      const t = await mk(h, "Fix login");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Cancel "Fix login".' });
      assert.match(assistantMessage.content, /✓ "Fix login" is now Cancelled/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "CANCELLED");
    } finally {
      h.close();
    }
  });

  test("MARK DONE: never falsely claims success — this is THE reported incident this phase fixes", async () => {
    const h = await setupBacklogHarness("ca-mark-done-incident");
    try {
      const t = await mk(h, "In review task");
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, new Date().toISOString());

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: '"In review task" is resolved. Mark it done.' });
      // Must NEVER read as a success claim.
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.doesNotMatch(assistantMessage.content, /is now Done/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW", "the real task must be untouched");

      // A follow-up read-only question must report the SAME real state, not something the model made up.
      const follow = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'What is the status of "In review task"?' });
      assert.match(follow.assistantMessage.content, /Review/);
      assert.doesNotMatch(follow.assistantMessage.content, /\bDone\b/);
    } finally {
      h.close();
    }
  });

  test("RENAME: 'Rename \"Old\" title to New name.' actually changes the real title", async () => {
    const h = await setupBacklogHarness("ca-rename");
    try {
      const t = await mk(h, "Old");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Rename "Old" title to New name.' });
      assert.match(assistantMessage.content, /✓ Renamed to "New name"/);
      assert.equal(h.platform.tasks.findById(t.id)!.title, "New name");
    } finally {
      h.close();
    }
  });

  test("NON-COMMAND language never mutates: 'The task should probably be cancelled.' is not executed", async () => {
    const h = await setupBacklogHarness("ca-hedge");
    try {
      const t = await mk(h, "Fix login");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: '"Fix login" should probably be cancelled.' });
      assert.doesNotMatch(assistantMessage.content, /✓/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "BACKLOG", "hedged language must never mutate state");
    } finally {
      h.close();
    }
  });

  test("AMBIGUOUS reference: two tasks share wording — Chat asks which one, mutates neither", async () => {
    const h = await setupBacklogHarness("ca-ambiguous");
    try {
      // Two tasks with the IDENTICAL title — both match, genuinely ambiguous.
      const t1 = await mk(h, "Fix login bug");
      const t2 = await mk(h, "Fix login bug");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start Fix login bug." });
      assert.match(assistantMessage.content, /found \d+ tasks matching/i);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "BACKLOG");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "BACKLOG");
    } finally {
      h.close();
    }
  });

  test("MULTI-INTENT read + action: 'How many tasks are in Review, and start \"Fix login\".' answers the read AND performs the action in one response", async () => {
    const h = await setupBacklogHarness("ca-multi-read-action");
    try {
      const t = await mk(h, "Fix login");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'How many tasks are in Review, and start "Fix login".' });
      assert.match(assistantMessage.content, /0 tasks are currently in Review/);
      assert.match(assistantMessage.content, /✓ "Fix login" is now To do/);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("STALE CACHE: after a Chat mutation, an immediate follow-up read reflects the NEW state, not a cached one", async () => {
    const h = await setupBacklogHarness("ca-fresh-read-after-mutation");
    try {
      await mk(h, "Fix login");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Start "Fix login".' });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Backlog and how many are in To do?" });
      assert.match(assistantMessage.content, /0 task is currently in Backlog|0 tasks are currently in Backlog/);
      assert.match(assistantMessage.content, /1 task is currently in To do/);
    } finally {
      h.close();
    }
  });

  test("SECURITY: a stranger's Chat message cannot start/cancel this project's task", async () => {
    const h = await setupBacklogHarness("ca-security");
    try {
      const t = await mk(h, "Fix login");
      const stranger = h.addUser("stranger");
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, stranger.id, { text: 'Start "Fix login".' }));
      assert.equal(h.platform.tasks.findById(t.id)!.status, "BACKLOG");
    } finally {
      h.close();
    }
  });

  test("NONEXISTENT task action produces a graceful failure message, not a crash", async () => {
    const h = await setupBacklogHarness("ca-nonexistent-action");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Start "Some task that does not exist".' });
      assert.match(assistantMessage.content, /couldn't/i);
    } finally {
      h.close();
    }
  });
});
