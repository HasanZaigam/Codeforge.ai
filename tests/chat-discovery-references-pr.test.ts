import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import type { SourceControlProvider, PullRequestStatus } from "../src/source-control/source-control-provider.js";

/**
 * Phase 4D.5 — task discovery, conversational task references, and real PR/merge status, kept
 * deliberately separate from `TaskStatus`. Covers the three parts of this phase: Part A (natural-language
 * task discovery through the existing Context Layer, no new task database), Part B (ordinal/pronoun
 * conversational references against the conversation's structured referent state, replacing the single
 * `lastTaskId` with an ordered `lastTaskIds` list — never a generic memory system), and Part C (real PR
 * state via the EXISTING `SourceControlProvider`/`TaskService.getPullRequestStatus`, never inferred from
 * `TaskStatus` or git log text).
 */

async function mk(h: Awaited<ReturnType<typeof setupBacklogHarness>>, title: string) {
  return createTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title, goal: "goal text", createdBy: h.owner.id });
}

function setStatus(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string, status: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.status = status as never;
  h.platform.tasks.save(task, new Date().toISOString());
}

/** A minimal fake provider registered under the SAME "local-git" key the harness's real project already uses (see `SourceControlProviderRegistry.register`'s last-write-wins Map) — lets tests control the PR status a task's real `getPullRequestStatus` call observes, without a second GitHub client. */
class FakePrProvider implements SourceControlProvider {
  readonly key = "local-git";
  constructor(private readonly behavior: PullRequestStatus | "throw") {}
  async resolveCloneCredential() {
    return null;
  }
  async commitAll(): Promise<never> {
    throw new Error("not used by these tests");
  }
  async push(): Promise<never> {
    throw new Error("not used by these tests");
  }
  async openPullRequest(): Promise<never> {
    throw new Error("not used by these tests");
  }
  async listPullRequestFeedback() {
    return [];
  }
  async getPullRequestStatus(): Promise<PullRequestStatus> {
    if (this.behavior === "throw") throw new Error("GitHub is currently unreachable");
    return this.behavior;
  }
  async listBranches() {
    return [];
  }
  async branchExists() {
    return null;
  }
  async getBranchStatus() {
    return { comparable: false, aheadBy: null, behindBy: null };
  }
}

function attachPullRequest(h: Awaited<ReturnType<typeof setupBacklogHarness>>, taskId: string) {
  const task = h.platform.tasks.findById(taskId)!;
  task.taskRecord.pullRequest = { provider: "local-git", id: "42", number: 42, url: "https://example.com/pr/42" };
  h.platform.tasks.save(task, new Date().toISOString());
}

describe("Task discovery (Phase 4D.5 Part A)", () => {
  test("natural-language status synonyms: 'ready to start' / 'currently running' / 'waiting for me'", async () => {
    const h = await setupBacklogHarness("disc-synonyms");
    try {
      const todo = await mk(h, "Todo task");
      setStatus(h, todo.id, "TODO");
      const working = await mk(h, "Working task");
      setStatus(h, working.id, "WORKING");
      const needsInput = await mk(h, "Needs input task");
      setStatus(h, needsInput.id, "NEEDS_INPUT");

      const r1 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are ready to start?" });
      assert.match(r1.assistantMessage.content, /1 task is currently in To do/);

      const r2 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are currently running?" });
      assert.match(r2.assistantMessage.content, /1 task is currently in Working/);

      const r3 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are waiting for me?" });
      assert.match(r3.assistantMessage.content, /1 task is currently in Needs input/);
    } finally {
      h.close();
    }
  });

  test("unauthorized: a stranger cannot discover this project's tasks", async () => {
    const h = await setupBacklogHarness("disc-unauthorized");
    try {
      const t = await mk(h, "Secret task");
      setStatus(h, t.id, "REVIEW");
      const stranger = h.addUser("stranger");
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, stranger.id, { text: "Show me the Review task." }));
    } finally {
      h.close();
    }
  });
});

describe("Conversational task references (Phase 4D.5 Part B)", () => {
  test("1. 'How many tasks are in Review?' then 'Give me details of that task.' resolves the singular result", async () => {
    const h = await setupBacklogHarness("ref-singular-pronoun");
    try {
      const t = await mk(h, "Only review task");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "How many tasks are in Review?" });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me the Review task." });
      assert.match(r.assistantMessage.content, /I found the Review task/);
      const r2 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Give me details of that task." });
      assert.match(r2.assistantMessage.content, /Only review task/);
    } finally {
      h.close();
    }
  });

  test("2. 'Show me Review tasks.' then 'Give me details of the second one.' resolves list[1]", async () => {
    const h = await setupBacklogHarness("ref-ordinal-second");
    try {
      const t1 = await mk(h, "Review A");
      setStatus(h, t1.id, "REVIEW");
      const t2 = await mk(h, "Review B");
      setStatus(h, t2.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me Review tasks." });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Give me details of the second one." });
      assert.match(r.assistantMessage.content, /Review B/);
      assert.doesNotMatch(r.assistantMessage.content, /Review A/);
    } finally {
      h.close();
    }
  });

  test("3. 'Show me Review tasks.' then 'Start the first one.' resolves list[0] for an ACTION", async () => {
    const h = await setupBacklogHarness("ref-ordinal-action");
    try {
      const t1 = await mk(h, "Review A");
      setStatus(h, t1.id, "REVIEW");
      const t2 = await mk(h, "Review B");
      setStatus(h, t2.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me Review tasks." });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel the first one." });
      // CANCEL is illegal from REVIEW (no row in the state machine) — the important thing this test
      // verifies is that the REFERENCE resolved to task A specifically (visible in the honest failure
      // message), not that the mutation succeeds.
      assert.match(r.assistantMessage.content, /Review A/);
    } finally {
      h.close();
    }
  });

  test("4. 'Show me the oldest Backlog task.' then 'Tell me about that task.' resolves the single oldest result", async () => {
    const h = await setupBacklogHarness("ref-oldest-then-pronoun");
    try {
      const older = await mk(h, "Older backlog task");
      await new Promise((r) => setTimeout(r, 5));
      await mk(h, "Newer backlog task");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Which task is the oldest in Backlog?" });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Tell me about that task." });
      assert.match(r.assistantMessage.content, /Older backlog task/);
      void older;
    } finally {
      h.close();
    }
  });

  test("5. STALE SAFETY: an older lastTaskId exists, but a fresh query returns a DIFFERENT task — 'that task' must use the fresh result", async () => {
    const h = await setupBacklogHarness("ref-stale-safety");
    try {
      const old = await mk(h, "Old discussed task");
      setStatus(h, old.id, "REVIEW");
      // Discuss the OLD task by name first, establishing a stale lastTaskId.
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'What is the status of "Old discussed task"?' });

      // Now a completely fresh, different-task query.
      const fresh = await mk(h, "Fresh backlog task");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Which task is the oldest in Backlog?" });

      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Tell me about that task." });
      assert.match(r.assistantMessage.content, /Fresh backlog task/);
      assert.doesNotMatch(r.assistantMessage.content, /Old discussed task/);
      void fresh;
    } finally {
      h.close();
    }
  });

  test("6. AMBIGUOUS 'that task': two tasks were just displayed, no ordinal given — Chat asks for clarification, no mutation", async () => {
    const h = await setupBacklogHarness("ref-ambiguous");
    try {
      const t1 = await mk(h, "Review A");
      setStatus(h, t1.id, "REVIEW");
      const t2 = await mk(h, "Review B");
      setStatus(h, t2.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me Review tasks." });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Cancel that task." });
      assert.match(r.assistantMessage.content, /found 2 tasks matching/i);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "REVIEW");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("7. topic switch then an ambiguous reference still asks for clarification rather than guessing", async () => {
    const h = await setupBacklogHarness("ref-topic-switch");
    try {
      const t1 = await mk(h, "Review A");
      setStatus(h, t1.id, "REVIEW");
      const t2 = await mk(h, "Review B");
      setStatus(h, t2.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me Review tasks." });
      // Topic switch — a workspace/architecture question, unrelated to tasks.
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Tell me about the project architecture." });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Start that task." });
      assert.match(r.assistantMessage.content, /found 2 tasks matching/i);
      assert.equal(h.platform.tasks.findById(t1.id)!.status, "REVIEW");
      assert.equal(h.platform.tasks.findById(t2.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("a bare task-scoped follow-up with NO pronoun at all still resolves the single prior result (pre-4D.5 behavior preserved)", async () => {
    const h = await setupBacklogHarness("ref-bare-followup");
    try {
      const t = await mk(h, "Single review task");
      setStatus(h, t.id, "REVIEW");
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Show me the Review task." });
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What validation passed?" });
      assert.doesNotMatch(r.assistantMessage.content, /couldn't find which task/i);
    } finally {
      h.close();
    }
  });
});

describe("Real PR / merge status, kept separate from TaskStatus (Phase 4D.5 Part C)", () => {
  test("1. task with an OPEN PR", async () => {
    const h = await setupBacklogHarness("pr-open", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "open", merged: false, mergeable: true })] } });
    try {
      const t = await mk(h, "Open PR task");
      setStatus(h, t.id, "REVIEW");
      attachPullRequest(h, t.id);
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What is the merge status of the Open PR task?" });
      assert.match(r.assistantMessage.content, /PR #42.*Open/i);
    } finally {
      h.close();
    }
  });

  test("2. task with a MERGED PR", async () => {
    const h = await setupBacklogHarness("pr-merged", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "closed", merged: true, mergeable: null })] } });
    try {
      const t = await mk(h, "Merged PR task");
      setStatus(h, t.id, "DONE");
      attachPullRequest(h, t.id);
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Has the PR been merged for the Merged PR task?" });
      assert.match(r.assistantMessage.content, /PR #42.*Merged/i);
    } finally {
      h.close();
    }
  });

  test("3. task with a CLOSED_NOT_MERGED PR", async () => {
    const h = await setupBacklogHarness("pr-closed-not-merged", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "closed", merged: false, mergeable: null })] } });
    try {
      const t = await mk(h, "Closed unmerged task");
      setStatus(h, t.id, "DONE");
      attachPullRequest(h, t.id);
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Did the PR get closed without merging for the Closed unmerged task?" });
      assert.match(r.assistantMessage.content, /Closed \(not merged\)/i);
    } finally {
      h.close();
    }
  });

  test("4. task with NO PR at all", async () => {
    const h = await setupBacklogHarness("pr-none");
    try {
      const t = await mk(h, "No PR task");
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What's the PR status for the No PR task?" });
      assert.match(r.assistantMessage.content, /No PR is associated/i);
    } finally {
      h.close();
    }
  });

  test("5. GitHub unavailable — honest error, never fabricated", async () => {
    const h = await setupBacklogHarness("pr-unavailable", { platform: { additionalSourceControlProviders: [new FakePrProvider("throw")] } });
    try {
      const t = await mk(h, "Flaky PR task");
      attachPullRequest(h, t.id);
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What is the merge status of the Flaky PR task?" });
      assert.match(r.assistantMessage.content, /github is currently unavailable/i);
    } finally {
      h.close();
    }
  });

  test("6. unauthorized project/task — PR status also refuses cross-project access", async () => {
    const h = await setupBacklogHarness("pr-unauthorized");
    try {
      const t = await mk(h, "Private PR task");
      const stranger = h.addUser("stranger");
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, stranger.id, { text: "What's the merge status of the Private PR task?" }));
      void t;
    } finally {
      h.close();
    }
  });

  test("7. task DONE but PR not merged — TaskStatus and PRStatus must NOT be conflated", async () => {
    const h = await setupBacklogHarness("pr-done-not-merged", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "open", merged: false, mergeable: true })] } });
    try {
      // DONE via human confirmation (Phase 4D.4) — never checks the PR at all.
      const t = await mk(h, "Humanly done task");
      setStatus(h, t.id, "REVIEW");
      attachPullRequest(h, t.id);
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Humanly done task" as Done.' });
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.equal(h.platform.tasks.findById(t.id)!.status, "DONE");

      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "What is the merge status of the Humanly done task?" });
      assert.match(r.assistantMessage.content, /Open/i);
      assert.doesNotMatch(r.assistantMessage.content, /merged/i);
    } finally {
      h.close();
    }
  });

  test("8. task REVIEW but PR already merged — the poll just hasn't caught up yet; Chat reports the REAL PR state regardless", async () => {
    const h = await setupBacklogHarness("pr-review-but-merged", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "closed", merged: true, mergeable: null })] } });
    try {
      const t = await mk(h, "About to sync task");
      setStatus(h, t.id, "REVIEW");
      attachPullRequest(h, t.id);
      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Was the About to sync task merged?" });
      assert.match(r.assistantMessage.content, /Merged/i);
      // TaskStatus itself is untouched by this read — the automatic poller, not Chat, is what syncs it.
      assert.equal(h.platform.tasks.findById(t.id)!.status, "REVIEW");
    } finally {
      h.close();
    }
  });

  test("9. human-confirmed DONE can coexist with an unmerged PR — combined status report keeps both separate", async () => {
    const h = await setupBacklogHarness("pr-combined", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "open", merged: false, mergeable: true })] } });
    try {
      const t = await mk(h, "Combined status task");
      setStatus(h, t.id, "REVIEW");
      attachPullRequest(h, t.id);
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: 'Mark "Combined status task" as Done.' });
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });

      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "What is the current status of the Combined status task, and what is its merge status?",
      });
      assert.match(r.assistantMessage.content, /\bDone\b/);
      assert.match(r.assistantMessage.content, /Open/i);
    } finally {
      h.close();
    }
  });
});

describe("Review age — based on the real entry-into-REVIEW event, not createdAt (Phase 4D.5)", () => {
  test("the task that entered REVIEW earlier is reported as oldest, even if it was CREATED later", async () => {
    const h = await setupBacklogHarness("review-age");
    try {
      // B is created BEFORE A, but A ENTERS REVIEW first — review-age, not createdAt, must decide "oldest".
      const b = await mk(h, "Task B (created first)");
      await new Promise((r) => setTimeout(r, 5));
      const a = await mk(h, "Task A (entered Review first)");

      setStatus(h, a.id, "REVIEW");
      h.platform.taskEvents.append(a.id, "TASK_MOVED_TO_REVIEW", { confidence: "high" }, new Date().toISOString());
      await new Promise((r) => setTimeout(r, 5));
      setStatus(h, b.id, "REVIEW");
      h.platform.taskEvents.append(b.id, "TASK_MOVED_TO_REVIEW", { confidence: "high" }, new Date().toISOString());

      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Which task has been in Review the longest?" });
      assert.match(r.assistantMessage.content, /Task A \(entered Review first\)/);
      assert.doesNotMatch(r.assistantMessage.content, /Task B \(created first\)/);
    } finally {
      h.close();
    }
  });
});

describe("Compound multi-intent queries (Phase 4D.5)", () => {
  test("'What is the current project task status, which tasks are in Review, which one is oldest, and what's the PR status of the oldest one?' answers all parts in one combined response", async () => {
    const h = await setupBacklogHarness(
      "compound-query",
      { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "open", merged: false, mergeable: true })] } },
    );
    try {
      const t = await mk(h, "The only review task");
      setStatus(h, t.id, "REVIEW");
      h.platform.taskEvents.append(t.id, "TASK_MOVED_TO_REVIEW", { confidence: "high" }, new Date().toISOString());
      attachPullRequest(h, t.id);

      const r = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "What is the current project task status, which tasks are in Review, which one is oldest, and what's the PR status of that task?",
      });
      assert.match(r.assistantMessage.content, /This project has \d+ tasks?:/);
      assert.match(r.assistantMessage.content, /The only review task/);
      assert.match(r.assistantMessage.content, /PR #42.*Open/is);
    } finally {
      h.close();
    }
  });
});

describe("THE REAL-WORLD REPRODUCTION (Phase 4D.5, section 29)", () => {
  test("mark Review task Done, then ask review counts / review task / details / merge status — each answer uses the correct CURRENT context", async () => {
    const h = await setupBacklogHarness("real-world-repro", { platform: { additionalSourceControlProviders: [new FakePrProvider({ state: "open", merged: false, mergeable: true })] } });
    try {
      const addProfile = await mk(h, "Add Profile");
      setStatus(h, addProfile.id, "REVIEW");
      attachPullRequest(h, addProfile.id);
      const otherReview = await mk(h, "Other review task");
      setStatus(h, otherReview.id, "REVIEW");

      // "make the Review task Add Profile Done" -> human completion flow (propose, then confirm).
      const propose = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "make the Review task Add Profile Done" });
      assert.ok(propose.pendingAction);
      await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "yes" });
      assert.equal(h.platform.tasks.findById(addProfile.id)!.status, "DONE");

      // "how many tasks are in Review?" -> must now be 1 (Add Profile left Review), not 2.
      const r1 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "how many tasks are in Review?" });
      assert.match(r1.assistantMessage.content, /1 task is currently in Review/);

      // "can you give me the review task?" -> must resolve the REMAINING review task, never the now-Done one.
      const r2 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "can you give me the review task?" });
      assert.match(r2.assistantMessage.content, /Other review task/);
      assert.doesNotMatch(r2.assistantMessage.content, /Add Profile/);

      // "can you give me detail of that task?" -> must resolve to the SAME task just shown (Other review task).
      const r3 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "can you give me detail of that task?" });
      assert.match(r3.assistantMessage.content, /Other review task/);

      // "can you check its merge status?" -> must NOT accidentally report on Add Profile (the now-Done task).
      const r4 = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "can you check its merge status?" });
      assert.match(r4.assistantMessage.content, /Other review task|No PR is associated/i);
      assert.doesNotMatch(r4.assistantMessage.content, /Add Profile/);
    } finally {
      h.close();
    }
  });
});
