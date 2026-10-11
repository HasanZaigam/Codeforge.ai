import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { ContextLayerService } from "../src/application/context-layer.js";
import { NotFoundError } from "../src/application/errors.js";
import type { AgentRun, ContextBundle, TaskEventType } from "../src/domain/types.js";
import { createReadyTask } from "./helpers/create-ready-task.js";

/**
 * Phase 4D — Context Layer. Real repositories/services throughout (the same harness the Chat and
 * backlog suites use) — nothing here is mocked. AgentRun/TaskEvent rows are inserted directly to set up
 * specific execution/validation/review states deterministically, rather than running the full
 * orchestrator for every scenario (already covered by tests/review-fix-cycle.test.ts and friends).
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

describe("ContextLayerService (Phase 4D)", () => {
  test("1. task summary: authoritative counts across every status, from the real Task repository", async () => {
    const h = await setupBacklogHarness("ctx-summary");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "A", goal: "a", createdBy: h.owner.id });
      const t2 = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "B", goal: "b", createdBy: h.owner.id });
      const b = h.platform.tasks.findById(t2.id)!;
      b.status = "DONE";
      h.platform.tasks.save(b, new Date().toISOString());

      const summary = ctx.getTaskSummary(h.project.id, h.owner.id);
      assert.equal(summary.total, 2);
      assert.equal(summary.counts.TODO, 1);
      assert.equal(summary.counts.DONE, 1);
      assert.equal(summary.counts.REVIEW, 0);
      assert.equal(summary.counts.FAILED, 0);
    } finally {
      h.close();
    }
  });

  test("2. task filtering: by status, and sorted oldest/newest", async () => {
    const h = await setupBacklogHarness("ctx-filter");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t1 = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "First", goal: "g", createdBy: h.owner.id });
      await new Promise((r) => setTimeout(r, 5));
      const t2 = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Second", goal: "g", createdBy: h.owner.id });
      for (const [t, status] of [
        [t1, "REVIEW"],
        [t2, "REVIEW"],
      ] as const) {
        const task = h.platform.tasks.findById(t.id)!;
        task.status = status;
        h.platform.tasks.save(task, new Date().toISOString());
      }

      const reviewTasks = ctx.getTasks(h.project.id, h.owner.id, { status: "REVIEW", sort: "oldest" });
      assert.equal(reviewTasks.length, 2);
      assert.equal(reviewTasks[0]!.id, t1.id);
      assert.equal(reviewTasks[1]!.id, t2.id);

      const doneTasks = ctx.getTasks(h.project.id, h.owner.id, { status: "DONE" });
      assert.equal(doneTasks.length, 0);
    } finally {
      h.close();
    }
  });

  test("13. bounded result limits: getTasks never exceeds the hard cap even if a huge limit is requested", async () => {
    const h = await setupBacklogHarness("ctx-bounds");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      for (let i = 0; i < 30; i++) {
        createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: `T${i}`, goal: "g", createdBy: h.owner.id });
      }
      const result = ctx.getTasks(h.project.id, h.owner.id, { limit: 10_000 });
      assert.ok(result.length <= 20, "hard cap of 20 must never be exceeded regardless of requested limit");
    } finally {
      h.close();
    }
  });

  test("3+14. task detail: real fields, and 404 for a task that doesn't exist", async () => {
    const h = await setupBacklogHarness("ctx-detail");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Fix OTP throttling", goal: "OTP is not rate limited", createdBy: h.owner.id });
      const detail = ctx.getTaskDetail(h.project.id, t.id, h.owner.id);
      assert.equal(detail.title, "Fix OTP throttling");
      assert.equal(detail.description, "OTP is not rate limited");
      assert.equal(detail.status, "TODO");
      assert.equal(detail.pullRequest, null);

      assert.throws(() => ctx.getTaskDetail(h.project.id, randomUUID(), h.owner.id), NotFoundError);
    } finally {
      h.close();
    }
  });

  test("15. task with no execution: latest execution is null, changes/validation are empty, never fabricated", async () => {
    const h = await setupBacklogHarness("ctx-noexec");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Untouched", goal: "g", createdBy: h.owner.id });

      assert.equal(ctx.getLatestExecution(h.project.id, t.id, h.owner.id), null);
      const changes = ctx.getTaskChanges(h.project.id, t.id, h.owner.id);
      assert.deepEqual(changes.files, []);
      const validation = ctx.getTaskValidation(h.project.id, t.id, h.owner.id);
      assert.equal(validation.outcome, null);
      const usage = ctx.getTaskModelUsage(h.project.id, t.id, h.owner.id);
      assert.equal(usage.latestModelId, null);
      assert.equal(usage.runCount, 0);
    } finally {
      h.close();
    }
  });

  test("4+6+7+8. latest execution + changed files + validation + model/provider — a task with a real completed run and real evidence events", async () => {
    const h = await setupBacklogHarness("ctx-exec");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
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
        result: { status: "completed", summary: "Added a rate limiter to the OTP endpoint.", filesChanged: ["src/auth/otp.js"], diffRef: null, confidence: "high", findings: [], needsInput: null },
        error: null,
        cost: { usageStatus: "complete", inputTokens: 500, outputTokens: 300, durationMs: 4200 },
        startedAt: now,
        completedAt: now,
        ownerGeneration: 1,
        modelId: "google/gemini-3.1-flash-lite",
        providerId: "google",
        fallbackIndex: 0,
      };
      h.platform.agentRuns.insert(run);
      h.platform.taskEvents.append(t.id, "COMMIT_CREATED" as TaskEventType, { branch: "task/abc", changedFiles: ["src/auth/otp.js"], commitSha: "deadbeef" }, now);
      h.platform.taskEvents.append(t.id, "VALIDATION_COMPLETED" as TaskEventType, { outcome: "checks_passed", checks: [{ name: "test", passed: true, outcome: "passed" }] }, now);

      const exec = ctx.getLatestExecution(h.project.id, t.id, h.owner.id);
      assert.equal(exec?.modelId, "google/gemini-3.1-flash-lite");
      assert.equal(exec?.providerId, "google");
      assert.equal(exec?.filesChangedCount, 1);
      assert.equal(exec?.validationOutcome, "checks_passed");

      const changes = ctx.getTaskChanges(h.project.id, t.id, h.owner.id);
      assert.deepEqual(changes.files, ["src/auth/otp.js"]);
      assert.equal(changes.commitSha, "deadbeef");

      const validation = ctx.getTaskValidation(h.project.id, t.id, h.owner.id);
      assert.equal(validation.outcome, "checks_passed");
      assert.equal(validation.checks[0]!.passed, true);

      const usage = ctx.getTaskModelUsage(h.project.id, t.id, h.owner.id);
      assert.equal(usage.latestModelId, "google/gemini-3.1-flash-lite");
      assert.equal(usage.runCount, 1);
      assert.equal(usage.inputTokens, 500);
    } finally {
      h.close();
    }
  });

  test("5. task history: bounded, structured events, not raw logs", async () => {
    const h = await setupBacklogHarness("ctx-history");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "T", goal: "g", createdBy: h.owner.id });
      const now = new Date().toISOString();
      for (let i = 0; i < 30; i++) h.platform.taskEvents.append(t.id, "AGENT_STARTED" as TaskEventType, { i }, now);

      const history = ctx.getTaskHistory(h.project.id, t.id, h.owner.id);
      assert.ok(history.length <= 20, "history is bounded even with many events");
      for (const e of history) {
        assert.equal(typeof e.type, "string");
        assert.equal(typeof e.at, "string");
      }
    } finally {
      h.close();
    }
  });

  test("9. task origin: a manually created task vs one converted from a backlog proposal", async () => {
    const h = await setupBacklogHarness("ctx-origin");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const manual = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Manual", goal: "g", createdBy: h.owner.id });
      assert.deepEqual(ctx.getTaskOrigin(h.project.id, manual.id, h.owner.id), { kind: "manual" });

      const item = h.services.backlog.createItem(h.project.id, { title: "Bug", description: "bug details here" }, h.owner.id);
      const proposalId = await h.approvedProposal(item.id);
      const { task } = await h.services.backlog.convertProposal(proposalId, h.owner.id);
      const origin = ctx.getTaskOrigin(h.project.id, task.id, h.owner.id);
      assert.equal(origin.kind, "backlog_proposal");
      if (origin.kind === "backlog_proposal") assert.equal(origin.backlogItemId, item.id);
    } finally {
      h.close();
    }
  });

  test("10. workspace context: bounded, structured project-context sections", async () => {
    const h = await setupBacklogHarness("ctx-workspace");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      h.services.projects.updateContext(h.project.id, h.owner.id, {
        version: 1,
        project: { name: h.project.name, description: "An OTT streaming app" },
        instructions: [],
        architecture: ["Node.js backend", "React frontend"],
        conventions: ["Use TypeScript strict mode"],
        validation: { commands: ["npm test before merging"] },
        constraints: ["Never log secrets"],
        revision: 1,
      });
      const wc = ctx.getWorkspaceContext(h.project.id, h.owner.id);
      assert.equal(wc?.purpose, "An OTT streaming app");
      assert.deepEqual(wc?.architecture, ["Node.js backend", "React frontend"]);
      assert.deepEqual(wc?.constraints, ["Never log secrets"]);
    } finally {
      h.close();
    }
  });

  test("11+12. project isolation and unauthorized access: another user gets 404, never another project's data", async () => {
    const h = await setupBacklogHarness("ctx-isolation");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Secret", goal: "g", createdBy: h.owner.id });
      const stranger = h.addUser("stranger");

      assert.throws(() => ctx.getTaskSummary(h.project.id, stranger.id), NotFoundError);
      assert.throws(() => ctx.getTaskDetail(h.project.id, t.id, stranger.id), NotFoundError);

      // A second project owned by the SAME user must not leak its tasks under the first project's id.
      const project2 = await h.services.projects.create({ name: "P2", sourceControlProvider: "local-git", repoUrl: h.project.repoUrl, codingEngine: "fixture", commands: {} }, h.owner.id);
      const t2 = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: project2.id, title: "Other project's task", goal: "g", createdBy: h.owner.id });
      assert.throws(() => ctx.getTaskDetail(h.project.id, t2.id, h.owner.id), NotFoundError);
    } finally {
      h.close();
    }
  });

  test("16. task with a failed execution: failure reason surfaces in validation and handoff", async () => {
    const h = await setupBacklogHarness("ctx-failed");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Broken", goal: "g", createdBy: h.owner.id });
      const now = new Date().toISOString();
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "FAILED";
      h.platform.tasks.save(task, now);
      h.platform.taskEvents.append(t.id, "TASK_FAILED" as TaskEventType, { error: "The workspace could not be provisioned.", category: "workspace_provision_failure" }, now);

      const validation = ctx.getTaskValidation(h.project.id, t.id, h.owner.id);
      assert.equal(validation.failureReason, "The workspace could not be provisioned.");

      const handoff = ctx.getTaskHandoff(h.project.id, t.id, h.owner.id);
      assert.equal(handoff.currentState, "FAILED");
      assert.equal(handoff.openIssue, "The workspace could not be provisioned.");
    } finally {
      h.close();
    }
  });

  test("17. task in NEEDS_INPUT: handoff surfaces the open issue honestly", async () => {
    const h = await setupBacklogHarness("ctx-needsinput");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Waiting", goal: "g", createdBy: h.owner.id });
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "NEEDS_INPUT";
      h.platform.tasks.save(task, new Date().toISOString());

      const handoff = ctx.getTaskHandoff(h.project.id, t.id, h.owner.id);
      assert.equal(handoff.currentState, "NEEDS_INPUT");
      assert.equal(handoff.openIssue, "Waiting on a human answer.");
      assert.match(handoff.nextAction, /human answer/i);
    } finally {
      h.close();
    }
  });

  test("18. task in REVIEW with a PR: project summary + task detail reflect it", async () => {
    const h = await setupBacklogHarness("ctx-review");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const t = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Ready", goal: "g", createdBy: h.owner.id });
      const task = h.platform.tasks.findById(t.id)!;
      task.status = "REVIEW";
      task.taskRecord.pullRequest = { provider: "github", id: "1", number: 42, url: "https://github.com/x/y/pull/42" };
      h.platform.tasks.save(task, new Date().toISOString());

      const detail = ctx.getTaskDetail(h.project.id, t.id, h.owner.id);
      assert.equal(detail.status, "REVIEW");
      assert.equal(detail.pullRequest?.number, 42);

      const summary = ctx.getProjectSummary(h.project.id, h.owner.id);
      assert.equal(summary.taskCounts.REVIEW, 1);
      assert.equal(summary.name, h.project.name);
    } finally {
      h.close();
    }
  });

  test("19. compound composition: oldest REVIEW task + its validation + its handoff, combined without dumping every task", async () => {
    const h = await setupBacklogHarness("ctx-compound");
    try {
      const ctx = new ContextLayerService({ projects: h.platform.projects, tasks: h.services.tasks, projectService: h.services.projects });
      const older = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Older review", goal: "g", createdBy: h.owner.id });
      await new Promise((r) => setTimeout(r, 5));
      const newer = createReadyTask(h.platform.tasks, h.platform.taskEvents, { tenantId: "default", projectId: h.project.id, title: "Newer review", goal: "g", createdBy: h.owner.id });
      for (const t of [older, newer]) {
        const task = h.platform.tasks.findById(t.id)!;
        task.status = "REVIEW";
        h.platform.tasks.save(task, new Date().toISOString());
      }

      const [oldestReview] = ctx.getTasks(h.project.id, h.owner.id, { status: "REVIEW", sort: "oldest", limit: 1 });
      assert.equal(oldestReview!.id, older.id);
      const detail = ctx.getTaskDetail(h.project.id, oldestReview!.id, h.owner.id);
      const validation = ctx.getTaskValidation(h.project.id, oldestReview!.id, h.owner.id);
      assert.equal(detail.title, "Older review");
      assert.equal(validation.outcome, null); // no validation run yet — honestly reported, not fabricated
    } finally {
      h.close();
    }
  });
});
