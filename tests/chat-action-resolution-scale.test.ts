import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { ContextLayerService } from "../src/application/context-layer.js";

/**
 * Phase 4D.3.2 — a real reported discrepancy: the EXACT message that live-verified successfully in
 * Phase 4D.3.1 (a fresh project with 1-2 tasks) failed in the real browser against the real "Jinvani_OTT"
 * project, which had accumulated 32 tasks over several weeks. Root cause, confirmed by directly querying
 * the real production database and replaying the real resolution logic against it: `resolveActionTarget`
 * (chat-intent.ts) fetched its candidate task list via `ContextLayerService.getTasks({ limit: 20 })` — the
 * SAME display-bounded cap (`MAX_LIST_LIMIT`) that exists so a model prompt never gets flooded with every
 * task in a project. That cap is correct for a user-facing LIST, but task-reference resolution is a pure
 * in-memory string-containment check that never reaches a model prompt — bounding its candidate set
 * silently made any task older than the 20 most recently created ones permanently unreferenceable by
 * title or id, no matter how exact the match would have been. Fixed by adding
 * `ContextLayerService.getAllTasksForResolution` (unbounded, resolution-only, never used for display) and
 * routing `resolveActionTarget` through it instead. This is a SEPARATE bug from Phase 4D.3.1's
 * comma/bracket clause-splitting fix — that fix was necessary and correct, but a second, independent bug
 * (silent result-set truncation) was hiding behind it and only manifests once a project has >20 tasks,
 * which no prior test harness ever exercised.
 */

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

function setReview(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.status = "REVIEW";
  h.platform.tasks.save(task, new Date().toISOString());
}

/** Creates `count` filler tasks AFTER the given one, so the target becomes older than the display cap once count >= 20. */
async function createNewerFillerTasks(h: Awaited<ReturnType<typeof setupBacklogHarness>>, count: number) {
  for (let i = 0; i < count; i++) {
    await mk(h, `Filler task ${i}`);
  }
}

describe("Action target resolution at real-world scale (Phase 4D.3.2)", () => {
  test("THE REAL REPORTED DISCREPANCY: a task older than the 20-newest display window still resolves by title", async () => {
    const h = await setupBacklogHarness("scale-real-incident");
    try {
      const target = await mk(h, "Add profile (+) option still shown after reaching the maximum number of profiles (BUG-036, BUG-037)");
      setReview(h, target.id);
      // 25 NEWER tasks created after the target — in a real project this would be weeks of normal usage.
      // The old `getTasks({ limit: 20 })` cap would push the target entirely out of the candidate window.
      await createNewerFillerTasks(h, 25);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "Add profile (+) option still shown after reaching the maximum number of profiles (BUG-036, BUG-037) make this task from review to done",
      });

      assert.equal(h.engine.calls.length, 0, "the task was resolved deterministically — the LLM must never be called");
      assert.doesNotMatch(assistantMessage.content, /i couldn't find which task/i, "this is the exact symptom of the scale bug — must not recur");
      // Phase 4D.4 — resolving the task now leads to a confirmation PROPOSAL, not an automatic decline
      // (REVIEW -> DONE is a legitimate human-confirmed transition now). The key thing THIS test still
      // verifies is unchanged: the task resolved correctly despite being outside the old 20-task window,
      // and nothing mutates on the unconfirmed first message.
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(target.id)!.status, "REVIEW", "the real task must be untouched");
    } finally {
      h.close();
    }
  });

  test("a project with exactly 32 tasks (the real reported project's size) resolves a 7-week-old task by title", async () => {
    const h = await setupBacklogHarness("scale-32-tasks");
    try {
      const target = await mk(h, "Old but still relevant task");
      await createNewerFillerTasks(h, 31); // target + 31 fillers = 32 total, matching the real incident
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Cancel "Old but still relevant task".' });
      assert.match(assistantMessage.content, /✓ "Old but still relevant task" is now Cancelled/);
      assert.equal(h.platform.tasks.findById(target.id)!.status, "CANCELLED");
    } finally {
      h.close();
    }
  });

  test("START by id still resolves an old task beyond the display window", async () => {
    const h = await setupBacklogHarness("scale-start-by-id");
    try {
      const target = await mk(h, "Old backlog task");
      await createNewerFillerTasks(h, 25);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: `Start ${target.id}.` });
      assert.match(assistantMessage.content, /✓ "Old backlog task" is now To do/);
      assert.equal(h.platform.tasks.findById(target.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("ambiguity detection still works correctly across the FULL unbounded candidate set, not just the newest 20", async () => {
    const h = await setupBacklogHarness("scale-ambiguous");
    try {
      // Two OLD tasks share an identical title, both beyond the old 20-task display window.
      const t1 = await mk(h, "Duplicate old title");
      const t2 = await mk(h, "Duplicate old title");
      await createNewerFillerTasks(h, 25);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start Duplicate old title." });
      assert.match(assistantMessage.content, /found \d+ tasks matching/i);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "BACKLOG");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "BACKLOG");
    } finally {
      h.close();
    }
  });

  test("the fuzzy reverse match also works beyond the display window, not just the exact forward match", async () => {
    const h = await setupBacklogHarness("scale-fuzzy");
    try {
      const target = await mk(h, "Add profile (+) option still shown after reaching the maximum number of profiles (BUG-036, BUG-037)");
      setReview(h, target.id);
      await createNewerFillerTasks(h, 25);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Make the Add profile (+) option task done." });
      assert.match(assistantMessage.content, /currently in review.*do you want me to mark it as done/is);
      assert.equal(h.platform.tasks.findById(target.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("a user-facing task LIST remains correctly bounded (no regression to the display cap itself)", async () => {
    const h = await setupBacklogHarness("scale-display-still-bounded");
    try {
      await createNewerFillerTasks(h, 25);
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const result = ctx.getTasks(h.project.id, h.owner.id, { limit: 100 });
      assert.ok(result.length <= 20, "the display-facing getTasks must still be capped at 20 regardless of what's requested");
    } finally {
      h.close();
    }
  });
});
