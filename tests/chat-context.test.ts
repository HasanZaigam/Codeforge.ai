import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import type { AgentRun, ContextBundle, TaskEventType } from "../src/domain/types.js";

/**
 * Phase 4D — Chat integration with the Context Layer (see /docs/CHAT.md "Context Layer"). These prove
 * Chat answers CodeForge-operational-state questions from ContextLayerService directly — with NO model
 * call for the deterministic ones (chat-intent.ts) — rather than falling back to GitHub/TODO.md/git-log
 * guesses (the exact failure mode Objective 6/17 describe).
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

const FORBIDDEN_PHRASES = [/configure gh auth/i, /github projects/i, /todo\.md/i, /git log/i, /no operational memory/i, /i do not have access to an external issue tracker/i];

function assertNoFallbackHallucination(content: string) {
  for (const p of FORBIDDEN_PHRASES) {
    assert.equal(p.test(content), false, `response must never fall back to "${p}" when CodeForge's own DB answers this: "${content}"`);
  }
}

describe("Chat + Context Layer integration (Phase 4D)", () => {
  test("A. 'How many tasks are in Review?' — deterministic, zero model calls, authoritative count", async () => {
    const h = await setupBacklogHarness("cc-review-count");
    try {
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "X", goal: "g", createdBy: h.owner.id });
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, new Date().toISOString());

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Review?" });
      assert.equal(h.engine.calls.length, 0, "a pure factual count must never call the model");
      assert.match(assistantMessage.content, /1 task is currently in Review/i);
      assertNoFallbackHallucination(assistantMessage.content);
    } finally {
      h.close();
    }
  });

  test("B. 'How many tasks has CodeForge completed?' — uses the DONE count, not git log", async () => {
    const h = await setupBacklogHarness("cc-done-count");
    try {
      for (let i = 0; i < 3; i++) {
        const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: `D${i}`, goal: "g", createdBy: h.owner.id });
        const task = h.platform.tasks.findById(t.id)!;
        task.status = "DONE";
        h.platform.tasks.save(task, new Date().toISOString());
      }
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks has CodeForge completed?" });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /3 tasks are currently in Done/i);
    } finally {
      h.close();
    }
  });

  test("full status breakdown: 'How many tasks are currently in Backlog, To Do, Working, Needs Input, Review, Done and Failed?'", async () => {
    const h = await setupBacklogHarness("cc-full-summary");
    try {
      createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "T", goal: "g", createdBy: h.owner.id });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "How many tasks are currently in Backlog, To Do, Working, Needs Input, Review, Done and Failed?",
      });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /Backlog 0/);
      assert.match(assistantMessage.content, /To do 1/);
      assert.match(assistantMessage.content, /Failed 0/);
    } finally {
      h.close();
    }
  });

  test("C+D+E+F+G. task-scoped questions after switching a specific task via title, then via pronoun follow-up", async () => {
    const h = await setupBacklogHarness("cc-task-scoped");
    try {
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Fix OTP throttling", goal: "g", createdBy: h.owner.id });
      const now = new Date().toISOString();
      const run: AgentRun = {
        id: randomUUID(),
        taskId: t.id,
        role: "implementer",
        engine: "fixture",
        attemptNumber: 1,
        status: "completed",
        input: contextBundle(),
        result: { status: "completed", summary: "Added a token-bucket rate limiter.", filesChanged: ["src/auth/otp.js"], diffRef: null, confidence: "high", findings: [], needsInput: null },
        error: null,
        cost: { usageStatus: "complete", inputTokens: 100, outputTokens: 50 },
        startedAt: now,
        completedAt: now,
        ownerGeneration: 1,
        modelId: "google/gemini-3.1-flash-lite",
        providerId: "google",
        fallbackIndex: 0,
      };
      h.platform.agentRuns.insert(run);
      h.platform.taskEvents.append(t.id, "COMMIT_CREATED" as TaskEventType, { branch: "task/otp", changedFiles: ["src/auth/otp.js", "test/otp.test.js"], commitSha: "cafef00d" }, now);
      h.platform.taskEvents.append(t.id, "VALIDATION_COMPLETED" as TaskEventType, { outcome: "checks_passed", checks: [{ name: "test", passed: true, outcome: "passed" }] }, now);
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, now);

      // C. "What was the last thing CodeForge did on TASK-X?" (referred to by title)
      const r1 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'What was the last thing CodeForge did on "Fix OTP throttling"?' });
      assert.equal(h.engine.calls.length, 0);
      assert.match(r1.assistantMessage.content, /token-bucket rate limiter/i);
      assertNoFallbackHallucination(r1.assistantMessage.content);

      // D. "Which files changed in the last execution?" — via pronoun follow-up (no task named this time)
      const r2 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Which files changed in the last execution?" });
      assert.match(r2.assistantMessage.content, /src\/auth\/otp\.js/);
      assert.match(r2.assistantMessage.content, /test\/otp\.test\.js/);
      assert.match(r2.assistantMessage.content, /cafef00d/);

      // F. "What validation passed?"
      const r3 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What validation passed on that task?" });
      assert.match(r3.assistantMessage.content, /checks_passed/);

      // G. "Which model and provider ran it?"
      const r4 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Which model and provider ran it?" });
      assert.match(r4.assistantMessage.content, /google\/gemini-3\.1-flash-lite/);
      assert.match(r4.assistantMessage.content, /google/);

      assert.equal(h.engine.calls.length, 0, "none of these factual follow-ups should ever call the model");
    } finally {
      h.close();
    }
  });

  test("G'. 'Why is TASK-X still in Review?' uses task state + review/validation evidence", async () => {
    const h = await setupBacklogHarness("cc-why-review");
    try {
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Ready to merge", goal: "g", createdBy: h.owner.id });
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, new Date().toISOString());

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Why is "Ready to merge" still in Review?' });
      assert.match(assistantMessage.content, /human review/i);
      assertNoFallbackHallucination(assistantMessage.content);
    } finally {
      h.close();
    }
  });

  test("H. 'Continue TASK-X after switching models' produces a compact handoff from CodeForge state, not a conversation replay", async () => {
    const h = await setupBacklogHarness("cc-handoff");
    try {
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Fix profile validation", goal: "g", createdBy: h.owner.id });
      const now = new Date().toISOString();
      h.platform.agentRuns.insert({
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
      });
      h.platform.taskEvents.append(t.id, "COMMIT_CREATED" as TaskEventType, { branch: "task/profile", changedFiles: ["profile.js"], commitSha: "abc123" }, now);
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      h.platform.tasks.save(task, now);

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'If I switch to another model now, continue "Fix profile validation" — what minimum context does the new model need?' });
      assert.equal(h.engine.calls.length, 0, "the handoff itself is composed deterministically from CodeForge records");
      assert.match(assistantMessage.content, /Fix profile validation/);
      assert.match(assistantMessage.content, /REVIEW/i);
      assert.match(assistantMessage.content, /gemini-flash-lite/);
      assert.match(assistantMessage.content, /profile\.js/);
      assert.match(assistantMessage.content, /Human review required/);
    } finally {
      h.close();
    }
  });

  test("I. compound: 'How many Review tasks are there, which is oldest, and what is blocking it?'", async () => {
    const h = await setupBacklogHarness("cc-compound");
    try {
      const older = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Older one", goal: "g", createdBy: h.owner.id });
      await new Promise((r) => setTimeout(r, 5));
      const newer = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Newer one", goal: "g", createdBy: h.owner.id });
      for (const t of [older, newer]) {
        const task = h.platform.tasks.findById(t.id)!;
        task.status = "REVIEW";
        h.platform.tasks.save(task, new Date().toISOString());
      }

      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many Review tasks are there, which is the oldest, and what is blocking it?" });
      assert.equal(h.engine.calls.length, 0);
      assert.match(assistantMessage.content, /2 tasks in Review/i);
      assert.match(assistantMessage.content, /Older one/);
      assert.match(assistantMessage.content, /human review/i);
      assert.doesNotMatch(assistantMessage.content, /Newer one/);
    } finally {
      h.close();
    }
  });

  test("NEGATIVE: an unrecognized free-form question still gets a grounded prompt naming real task counts, never a claim of zero operational memory", async () => {
    const h = await setupBacklogHarness("cc-negative-fallback", { respond: (req) => (req.promptOverride?.includes("CodeForge task state") ? "This project has some tasks in progress." : "NO GROUNDING FOUND") });
    try {
      createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "T", goal: "g", createdBy: h.owner.id });
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Tell me about this project's progress in your own words." });
      assert.equal(h.engine.calls.length, 1, "a genuinely open-ended question still goes to the model, but WITH grounding");
      assert.match(h.engine.calls[0]!.promptOverride ?? "", /CodeForge task state for this project \(authoritative — never use GitHub Issues, TODO\.md, or git log/);
      assert.equal(assistantMessage.content, "This project has some tasks in progress.");
    } finally {
      h.close();
    }
  });

  test("NEGATIVE: a task-scoped question about a task that doesn't exist never falls through to a task-count hallucination", async () => {
    const h = await setupBacklogHarness("cc-no-task-match");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What was the last thing CodeForge did on Nonexistent Task?" });
      // No task matched "Nonexistent Task" and there is no lastTaskId yet, so this intent doesn't fire —
      // it falls through to the general grounded path (still never git log / TODO.md / gh auth).
      assertNoFallbackHallucination(assistantMessage.content);
    } finally {
      h.close();
    }
  });

  test("SECURITY: a stranger cannot use Chat to learn another project's task counts or task detail", async () => {
    const h = await setupBacklogHarness("cc-security");
    try {
      createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Secret task", goal: "g", createdBy: h.owner.id });
      const stranger = h.addUser("stranger");
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, stranger.id, { text: "How many tasks are in Backlog?" }));
    } finally {
      h.close();
    }
  });
});
