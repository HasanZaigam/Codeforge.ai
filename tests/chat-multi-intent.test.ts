import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import type { AgentRun, ContextBundle, TaskEventType } from "../src/domain/types.js";

/**
 * Phase 4D.1 — multi-intent Chat messages. A single message can name several supported questions at
 * once; ALL of them must be answered in one combined response, never just the first one matched (the
 * exact regression this phase fixes — see chat-intent.ts's own doc comment).
 */

function contextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    taskGoal: "fix it",
    taskPlan: null,
    priorDecisions: [],
    repoPath: "/tmp/workspace",
    projectConventionPointer: "",
    lastFailure: null,
    reviewEvidence: null,
    reviewerFeedback: null,
    humanReviewFeedback: null,
    projectContext: null,
    approvedVerificationChecks: [],
    verificationEvidence: null,
    bugFixEvidence: null,
    ...overrides,
  };
}

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "g", createdBy: h.owner.id });
}

function setStatus(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string, status: string) {
  const task = h.platform.tasks.findById(taskId)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task.status = status as any;
  h.platform.tasks.save(task, new Date().toISOString());
}

describe("Chat multi-intent (Phase 4D.1)", () => {
  test("1. single intent: 'How many tasks are Done?' still works exactly as before", async () => {
    const h = await setupBacklogHarness("mi-single");
    try {
      const t = await mk(h, "T1");
      setStatus(h, t.id, "DONE");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are Done?" });
      assert.equal(h.engine.calls.length, 0);
      assert.equal(assistantMessage.content, "1 task is currently in Done.");
    } finally {
      h.close();
    }
  });

  test("2. two intents: 'How many tasks are Done and how many are Failed?' answers BOTH, not just the first", async () => {
    const h = await setupBacklogHarness("mi-two");
    try {
      const t1 = await mk(h, "D1");
      setStatus(h, t1.id, "DONE");
      const t2 = await mk(h, "F1");
      setStatus(h, t2.id, "FAILED");

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are Done and how many are Failed?" });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /1 task is currently in Done/);
      assert.match(assistantMessage.content, /1 task is currently in Failed/);
    } finally {
      h.close();
    }
  });

  test("3. two intents with inherited status: 'How many tasks are in Review and which task is oldest?'", async () => {
    const h = await setupBacklogHarness("mi-inherit-status");
    try {
      const older = await mk(h, "Older review");
      await new Promise((r) => setTimeout(r, 5));
      const newer = await mk(h, "Newer review");
      setStatus(h, older.id, "REVIEW");
      setStatus(h, newer.id, "REVIEW");

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Review and which task is oldest?" });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /2 tasks are currently in Review/);
      assert.match(assistantMessage.content, /Older review/);
      assert.doesNotMatch(assistantMessage.content, /Newer review/);
    } finally {
      h.close();
    }
  });

  test("4. many intents in one message, exactly the reported bug: full summary + list + oldest + DONE count + FAILED count — nothing dropped", async () => {
    const h = await setupBacklogHarness("mi-bug-report");
    try {
      const older = await mk(h, "Older review task");
      await new Promise((r) => setTimeout(r, 5));
      const newer = await mk(h, "Newer review task");
      setStatus(h, older.id, "REVIEW");
      setStatus(h, newer.id, "REVIEW");
      const done = await mk(h, "Done task");
      setStatus(h, done.id, "DONE");
      const failed = await mk(h, "Failed task");
      setStatus(h, failed.id, "FAILED");
      h.platform.taskEvents.append(failed.id, "TASK_FAILED" as TaskEventType, { error: "Validation failed twice.", category: "task_failure" }, new Date().toISOString());

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "How many tasks are currently in Backlog, To Do, Working, Needs Input, Review, Done and Failed? Which tasks are currently in Review? Which task has been in Review the longest? How many tasks has CodeForge completed in this project? How many tasks have failed, and what are the failure reasons?",
      });
      assert.equal(h.engine.calls.length, 0, "every clause here is deterministically answerable or gracefully unsupported — no model call");
      // Full breakdown.
      assert.match(assistantMessage.content, /Review 2/);
      assert.match(assistantMessage.content, /Done 1/);
      assert.match(assistantMessage.content, /Failed 1/);
      // Which tasks are in Review (listing).
      assert.match(assistantMessage.content, /Older review task/);
      assert.match(assistantMessage.content, /Newer review task/);
      // Oldest in Review.
      assert.match(assistantMessage.content, /oldest task in Review/i);
      // "How many has CodeForge completed" -> DONE count.
      assert.match(assistantMessage.content, /1 task is currently in Done/);
      // "How many have failed" -> FAILED count answered; "what are the failure reasons" (bulk, unsupported) gracefully noted, not silently dropped.
      assert.match(assistantMessage.content, /1 task is currently in Failed/);
      assert.match(assistantMessage.content, /couldn't answer/i);
    } finally {
      h.close();
    }
  });

  test("5. task-scoped multi-intent: 'Which files changed on X and what validation passed?'", async () => {
    const h = await setupBacklogHarness("mi-files-validation");
    try {
      const t = await mk(h, "Fix OTP throttling");
      const now = new Date().toISOString();
      h.platform.taskEvents.append(t.id, "COMMIT_CREATED" as TaskEventType, { branch: "task/otp", changedFiles: ["src/auth/otp.js"], commitSha: "cafe1234" }, now);
      h.platform.taskEvents.append(t.id, "VALIDATION_COMPLETED" as TaskEventType, { outcome: "checks_passed", checks: [{ name: "test", passed: true, outcome: "passed" }] }, now);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Which files changed on "Fix OTP throttling" and what validation passed?' });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /src\/auth\/otp\.js/);
      assert.match(assistantMessage.content, /checks_passed/);
    } finally {
      h.close();
    }
  });

  test("6. task-scoped multi-intent with pronoun carry-over: 'Which model ran X and what was the last thing it did?'", async () => {
    const h = await setupBacklogHarness("mi-model-execution");
    try {
      const t = await mk(h, "Fix profile validation");
      const now = new Date().toISOString();
      const run: AgentRun = {
        id: randomUUID(),
        taskId: t.id,
        role: "implementer",
        engine: "fixture",
        attemptNumber: 1,
        status: "completed",
        input: contextBundle(),
        result: { status: "completed", summary: "Tightened email validation.", filesChanged: ["profile.js"], diffRef: null, confidence: "high", findings: [], needsInput: null },
        error: null,
        cost: null,
        startedAt: now,
        completedAt: now,
        ownerGeneration: 1,
        modelId: "gemini-flash-lite",
        providerId: "google",
        fallbackIndex: 0,
      };
      h.platform.agentRuns.insert(run);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Which model ran "Fix profile validation" and what was the last thing it did?' });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /gemini-flash-lite/);
      assert.match(assistantMessage.content, /Tightened email validation/);
    } finally {
      h.close();
    }
  });

  test("7. handoff intent still works standalone inside the multi-intent pipeline", async () => {
    const h = await setupBacklogHarness("mi-handoff");
    try {
      const t = await mk(h, "Fix login error handling");
      setStatus(h, t.id, "REVIEW");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'If I switch models, what handoff context is needed for "Fix login error handling"?' });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /Fix login error handling/);
      assert.match(assistantMessage.content, /REVIEW/i);
    } finally {
      h.close();
    }
  });

  test("8. mixed supported + unsupported: the supported half is still answered, the rest is a graceful note, nothing is discarded", async () => {
    const h = await setupBacklogHarness("mi-mixed");
    try {
      const t = await mk(h, "T1");
      setStatus(h, t.id, "DONE");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are Done? What is the weather today?" });
      assert.match(assistantMessage.content, /1 task is currently in Done/);
      assert.match(assistantMessage.content, /couldn't answer/i);
      assert.match(assistantMessage.content, /weather/i);
    } finally {
      h.close();
    }
  });

  test("9. fresh conversation, multi-intent, no prior history or lastTaskId required", async () => {
    const h = await setupBacklogHarness("mi-fresh");
    try {
      const t1 = await mk(h, "D1");
      setStatus(h, t1.id, "DONE");
      const older = await mk(h, "Older review");
      await new Promise((r) => setTimeout(r, 5));
      setStatus(h, older.id, "REVIEW");

      // First-ever message in this conversation.
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are Done, how many are in Review, and which Review task is oldest?" });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /1 task is currently in Done/);
      assert.match(assistantMessage.content, /1 task is currently in Review/);
      assert.match(assistantMessage.content, /Older review/);
    } finally {
      h.close();
    }
  });

  test("10. unauthorized task reference inside a multi-intent message: no data leak, no crash, the resolvable parts still answer", async () => {
    const h = await setupBacklogHarness("mi-unauthorized");
    try {
      const t1 = await mk(h, "D1");
      setStatus(h, t1.id, "DONE");
      // A stranger's own project/task, named by title — must NOT resolve for this project's conversation.
      const stranger = h.addUser("stranger");
      const strangerProject = await h.services.projects.create({ name: "Stranger Project", sourceControlProvider: "local-git", repoUrl: h.project.repoUrl, codingEngine: "fixture", commands: {} }, stranger.id);
      const strangerTask = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: strangerProject.id, title: "Someone else's task", goal: "g", createdBy: stranger.id });
      setStatus(h, strangerTask.id, "REVIEW");

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: 'How many tasks are Done, and which model ran "Someone else\'s task"?',
      });
      assert.match(assistantMessage.content, /1 task is currently in Done/);
      assert.match(assistantMessage.content, /couldn't (find|answer)/i);
      // The user's OWN echoed question naming the title is fine — what must never leak is the OTHER
      // project's actual data (its model/provider, status, or any other record).
      assert.doesNotMatch(assistantMessage.content, /gemini|google|anthropic|openai/i);
      assert.doesNotMatch(assistantMessage.content, /REVIEW/);
    } finally {
      h.close();
    }
  });
});
