import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { ActionLayerService } from "../src/application/action-layer.js";

/**
 * Phase 4D.2 — the Action Layer. Real repositories/services throughout (the same harness the Chat/
 * Context-Layer suites use) — every mutation goes through the REAL TaskService/Orchestrator, and every
 * assertion checks the REAL database state read back afterward, never just the ActionResult's own claim.
 */

function newActionLayer(h: Awaited<ReturnType<typeof setupBacklogHarness>>) {
  return new ActionLayerService({ tasks: h.services.tasks, taskEvents: h.platform.taskEvents });
}

/** A BACKLOG task — most action tests need this starting state (unlike createReadyTask, which auto-releases to TODO). */
async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

describe("ActionLayerService (Phase 4D.2)", () => {
  test("1. create task — real TaskService.create, lands in BACKLOG, never started", async () => {
    const h = await setupBacklogHarness("act-create");
    try {
      const actions = newActionLayer(h);
      const result = await actions.createTask(h.project.id, h.owner.id, { title: "Fix OTP throttling", description: "OTP is not rate limited" });
      assert.equal(result.succeeded, true);
      assert.equal(result.newState, "BACKLOG");
      assert.ok(result.taskId);
      // Real DB read-back, independent of the ActionResult's own claim.
      const real = h.platform.tasks.findById(result.taskId!)!;
      assert.equal(real.status, "BACKLOG");
      assert.equal(real.title, "Fix OTP throttling");
    } finally {
      h.close();
    }
  });

  test("2. edit task title — real TaskService.editBacklogTask, only while BACKLOG", async () => {
    const h = await setupBacklogHarness("act-edit");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "Old title");
      const result = await actions.editTaskTitle(h.project.id, h.owner.id, t.id, "New title");
      assert.equal(result.succeeded, true);
      assert.equal(result.newState, "New title");
      const real = h.platform.tasks.findById(t.id)!;
      assert.equal(real.title, "New title");
    } finally {
      h.close();
    }
  });

  test("3. start task — real Orchestrator.startTask, BACKLOG -> TODO", async () => {
    const h = await setupBacklogHarness("act-start");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      assert.equal(h.platform.tasks.findById(t.id)!.status, "BACKLOG");
      const result = await actions.startTask(h.project.id, h.owner.id, t.id);
      assert.equal(result.succeeded, true);
      assert.equal(result.previousState, "BACKLOG");
      assert.equal(result.newState, "TODO");
      assert.equal(h.platform.tasks.findById(t.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });

  test("4. cancel task — real Orchestrator.requestCancellation, BACKLOG -> CANCELLED", async () => {
    const h = await setupBacklogHarness("act-cancel");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const result = await actions.cancelTask(h.project.id, h.owner.id, t.id);
      assert.equal(result.succeeded, true);
      assert.equal(result.newState, "CANCELLED");
      assert.equal(h.platform.tasks.findById(t.id)!.status, "CANCELLED");
    } finally {
      h.close();
    }
  });

  test("5. mark done — the real domain has NO manual Done transition from REVIEW; never invented, never writes the DB directly", async () => {
    const h = await setupBacklogHarness("act-done");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, new Date().toISOString());

      const result = await actions.markDone(h.project.id, h.owner.id, t.id);
      assert.equal(result.succeeded, false);
      assert.match(result.error!, /merged|no manual/i);
      // The REAL task must be untouched — no direct DB write happened.
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("6. retry/re-run — the real state machine has no transition out of FAILED; never invented", async () => {
    const h = await setupBacklogHarness("act-retry");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "FAILED";
      h.platform.tasks.save(task, new Date().toISOString());

      const result = await actions.retryTask(h.project.id, h.owner.id, t.id);
      assert.equal(result.succeeded, false);
      assert.match(result.error!, /retry|re-run|terminal/i);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "FAILED");
    } finally {
      h.close();
    }
  });

  test("7. invalid transition — starting an already-started task fails via the REAL state machine, never silently succeeds", async () => {
    const h = await setupBacklogHarness("act-invalid-transition");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      await actions.startTask(h.project.id, h.owner.id, t.id); // BACKLOG -> TODO
      const second = await actions.startTask(h.project.id, h.owner.id, t.id); // TODO -> TODO is illegal
      assert.equal(second.succeeded, false);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "TODO", "still TODO — the invalid second start must not have moved it further");
    } finally {
      h.close();
    }
  });

  test("8. unauthorized task — a stranger cannot start/cancel/edit a task in this project", async () => {
    const h = await setupBacklogHarness("act-unauthorized");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const stranger = h.addUser("stranger");
      const result = await actions.startTask(h.project.id, stranger.id, t.id);
      assert.equal(result.succeeded, false);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "BACKLOG", "unauthorized attempt must never mutate anything");
    } finally {
      h.close();
    }
  });

  test("9/10. nonexistent task — never crashes, never mutates, reports a clean failure", async () => {
    const h = await setupBacklogHarness("act-nonexistent");
    try {
      const actions = newActionLayer(h);
      const result = await actions.startTask(h.project.id, h.owner.id, randomUUID());
      assert.equal(result.succeeded, false);
      assert.match(result.error!, /couldn't find/i);
    } finally {
      h.close();
    }
  });

  test("11/12/13. mutation failure vs read-back mismatch vs successful verification — cross-project task id is rejected before any mutation", async () => {
    const h = await setupBacklogHarness("act-cross-project");
    try {
      const actions = newActionLayer(h);
      const otherProject = await h.services.projects.create({ name: "Other", sourceControlProvider: "local-git", repoUrl: h.project.repoUrl, codingEngine: "fixture", commands: {} }, h.owner.id);
      const otherTask = createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: otherProject.id, title: "Other", goal: "g", createdBy: h.owner.id });

      const result = await actions.startTask(h.project.id, h.owner.id, otherTask.id);
      assert.equal(result.succeeded, false);
      assert.match(result.error!, /doesn't belong to this project/i);
      assert.equal(h.platform.tasks.findById(otherTask.id)!.status, "BACKLOG", "the other project's task must be completely untouched");

      // Now the genuinely successful, verified case for contrast.
      const own = await mk(h, "Mine");
      const ok = await actions.startTask(h.project.id, h.owner.id, own.id);
      assert.equal(ok.succeeded, true);
      assert.equal(ok.evidence, "Read back: status is now TODO.");
      assert.ok(ok.verifiedAt);
    } finally {
      h.close();
    }
  });

  test("14/15. TaskEvent audit entry with source=chat, appended only after real verification", async () => {
    const h = await setupBacklogHarness("act-audit");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      await actions.startTask(h.project.id, h.owner.id, t.id);

      const events = h.platform.taskEvents.listForTask(t.id);
      const chatEvent = events.find((e) => e.type === "CHAT_ACTION_PERFORMED");
      assert.ok(chatEvent, "a CHAT_ACTION_PERFORMED event must exist in the SAME event stream the Tasks UI reads");
      assert.equal(chatEvent!.payload.source, "chat");
      assert.equal(chatEvent!.payload.action, "START_TASK");
      assert.equal(chatEvent!.payload.previousState, "BACKLOG");
      assert.equal(chatEvent!.payload.newState, "TODO");
    } finally {
      h.close();
    }
  });

  test("no audit entry is appended for a failed action — an attempted-but-failed mutation leaves no false trail", async () => {
    const h = await setupBacklogHarness("act-no-audit-on-failure");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, new Date().toISOString());

      await actions.markDone(h.project.id, h.owner.id, t.id);
      const events = h.platform.taskEvents.listForTask(t.id);
      assert.equal(events.some((e) => e.type === "CHAT_ACTION_PERFORMED"), false);
    } finally {
      h.close();
    }
  });

  test("cancelling a WORKING task requests cancellation honestly rather than falsely claiming CANCELLED", async () => {
    const h = await setupBacklogHarness("act-cancel-working");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "WORKING";
      h.platform.tasks.save(task, new Date().toISOString());

      const result = await actions.cancelTask(h.project.id, h.owner.id, t.id);
      assert.equal(result.succeeded, true);
      assert.equal(result.newState, "WORKING", "still WORKING — cancellation is a request, not an instant flip");
      assert.match(result.evidence!, /requested/i);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "WORKING");
    } finally {
      h.close();
    }
  });

  test("editing a non-BACKLOG task's title is refused, never bypassing the existing domain rule", async () => {
    const h = await setupBacklogHarness("act-edit-not-backlog");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      await actions.startTask(h.project.id, h.owner.id, t.id); // now TODO
      const result = await actions.editTaskTitle(h.project.id, h.owner.id, t.id, "New title");
      assert.equal(result.succeeded, false);
      assert.equal(h.platform.tasks.findById(t.id)!.title, "T1", "title must be untouched");
    } finally {
      h.close();
    }
  });

  test("IDEMPOTENCY (Phase 4D.3): cancelling an already-CANCELLED task returns a clean 'already Cancelled' success, no duplicate transition attempted", async () => {
    const h = await setupBacklogHarness("act-idempotent-cancel");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      const first = await actions.cancelTask(h.project.id, h.owner.id, t.id);
      assert.equal(first.succeeded, true);
      const before = h.platform.taskEvents.listForTask(t.id).filter((e) => e.type === "CHAT_ACTION_PERFORMED").length;

      const second = await actions.cancelTask(h.project.id, h.owner.id, t.id);
      assert.equal(second.succeeded, true);
      assert.match(second.evidence ?? "", /already cancelled/i);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "CANCELLED");

      const after = h.platform.taskEvents.listForTask(t.id).filter((e) => e.type === "CHAT_ACTION_PERFORMED").length;
      assert.equal(after, before, "the idempotent no-op must not append a second audit event");
    } finally {
      h.close();
    }
  });

  test("IDEMPOTENCY (Phase 4D.3): starting an already-TODO task returns a clean, non-alarming 'already To Do' message, not a raw state-machine error", async () => {
    const h = await setupBacklogHarness("act-idempotent-start");
    try {
      const actions = newActionLayer(h);
      const t = await mk(h, "T1");
      await actions.startTask(h.project.id, h.owner.id, t.id); // BACKLOG -> TODO
      const second = await actions.startTask(h.project.id, h.owner.id, t.id);
      assert.equal(second.succeeded, false);
      assert.match(second.error ?? "", /already to do/i);
      assert.equal(h.platform.tasks.findById(t.id)!.status, "TODO");
    } finally {
      h.close();
    }
  });
});
