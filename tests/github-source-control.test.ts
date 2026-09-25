import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { FakeSourceControlProvider } from "./helpers/fake-source-control-provider.js";
import type { Project } from "../src/domain/types.js";

/**
 * Exercises the source-control gate (commit/push/PR) the Orchestrator added
 * in Step 7, using FakeSourceControlProvider registered under the "github"
 * key — no live GitHub credential or network access required, per Step 7
 * brief §29. See /docs/GITHUB_INTEGRATION.md "Testing strategy".
 */
async function setup(label: string, orchestratorConfig?: Partial<import("../src/orchestrator/config.js").OrchestratorConfig>) {
  const engine = createSelfFixDemoEngine();
  const root = await mkdtemp(join(tmpdir(), `gh-sc-test-${label}-`));
  const scProvider = new FakeSourceControlProvider("github");
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    additionalSourceControlProviders: [scProvider],
    orchestratorConfig,
  });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    tenantId: "default",
    email: `${label}@example.com`,
    name: "Tester",
    passwordHash: "",
    createdAt: now,
  };
  platform.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  return { platform, project, user, scProvider };
}

function makeTask(platform: Platform, project: Project) {
  return createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

test("a task that reaches REVIEW has committed, pushed, and opened a real PR (evidence, no auto-merge)", async () => {
  const { platform, project, scProvider } = await setup("happy");
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.pullRequest, "expected a PullRequestRef to be recorded");
  assert.equal(result.taskRecord.pullRequest!.provider, "github");
  assert.ok(result.taskRecord.latestDiffRef, "expected a commit sha to be recorded");
  assert.equal(scProvider.pullRequestsCreated, 1);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("BRANCH_CREATED"));
  assert.ok(events.includes("COMMIT_CREATED"));
  assert.ok(events.includes("BRANCH_PUSHED"));
  assert.ok(events.includes("PULL_REQUEST_CREATED"));
});

test("PR idempotency: re-running executeTask() on a task that already has a recorded PR does not open a second one", async () => {
  const { platform, project, scProvider } = await setup("idempotent-orchestrator");
  const task = makeTask(platform, project);

  const first = await platform.orchestrator.executeTask(task.id);
  assert.equal(first.status, "REVIEW");
  assert.equal(scProvider.pullRequestsCreated, 1);
  const openPrCallsAfterFirst = scProvider.calls.filter((c) => c.op === "openPullRequest").length;

  // Simulate a crash-recovery retry: executeTask() called again for an already-REVIEW task is a
  // no-op at the Orchestrator's top-level dispatch (see executeTask()'s status switch), so this
  // asserts the guard is real, not just untested.
  const second = await platform.orchestrator.executeTask(task.id);
  assert.equal(second.status, "REVIEW");
  assert.equal(scProvider.calls.filter((c) => c.op === "openPullRequest").length, openPrCallsAfterFirst);
  assert.equal(scProvider.pullRequestsCreated, 1, "still exactly one PR after the retry");
});

test("PR idempotency at the provider layer: two openPullRequest calls for the same branch return the same PR, not a duplicate", async () => {
  const { scProvider, project } = await setup("idempotent-provider");
  const signal = new AbortController().signal;
  const request = { workspacePath: "/tmp/x", branch: "task/abc123", baseBranch: "main", title: "t", description: "d" };

  const first = await scProvider.openPullRequest(project, request, signal);
  const second = await scProvider.openPullRequest(project, request, signal);

  assert.equal(first.id, second.id);
  assert.equal(scProvider.pullRequestsCreated, 1);
});

// V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028): a plain, untyped Error thrown from a
// SourceControlProvider call — exactly the shape a real transient git/GitHub network blip takes —
// is now classified "retryable_transient" (see orchestrator/failure-classifier.ts) and retried at
// the episode level, instead of immediately, permanently failing the task on the very first hiccup.
// These three tests now cover the (much more common) recovery case; the paired "...persistently..."
// test right after each one covers the case where the failure never clears and the retry budget is
// genuinely exhausted — that is still a real, terminal FAILED, exactly as all three originally
// asserted.

test("a ONE-SHOT commit failure recovers via infrastructure retry and still reaches REVIEW — no duplicate branch/commit/PR from the retry", async () => {
  const { platform, project, scProvider } = await setup("commit-fail", { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 20, infrastructureRetryMaxDelayMs: 200 });
  const task = makeTask(platform, project);
  scProvider.failNextCallTo("commitAll");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.equal(scProvider.pullRequestsCreated, 1, "exactly one PR, never duplicated by the retry");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("SOURCE_CONTROL_FAILED"));
  assert.ok(events.includes("INFRASTRUCTURE_FAILURE_DETECTED"));
  assert.ok(events.includes("INFRASTRUCTURE_RETRY_SCHEDULED"));
  assert.equal(events.filter((t) => t === "COMMIT_CREATED").length, 1, "the failed first attempt never actually committed, so the successful retry is the only commit");
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1, "no duplicate workspace/branch provisioning from the retry");
});

test("a PERSISTENT commit failure exhausts the infrastructure retry budget and fails the task (FAILED), never fabricating a PR", async () => {
  const { platform, project, scProvider } = await setup("commit-fail-persistent", { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 20, infrastructureRetryMaxDelayMs: 200 });
  const task = makeTask(platform, project);
  scProvider.failEveryCallTo("commitAll");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");
  assert.equal(result.taskRecord.pullRequest, null);
  assert.equal(scProvider.pullRequestsCreated, 0);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "SOURCE_CONTROL_FAILED").length, 2, "one failure per attempt (1 initial + 1 retry)");
  assert.ok(events.includes("TASK_FAILED"));
  assert.ok(!events.includes("TASK_MOVED_TO_REVIEW"));
});

test("a ONE-SHOT push failure recovers via infrastructure retry — still exactly one PR, never a duplicate branch", async () => {
  const { platform, project, scProvider } = await setup("push-fail", { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 20, infrastructureRetryMaxDelayMs: 200 });
  const task = makeTask(platform, project);
  scProvider.failNextCallTo("push");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.taskRecord.latestDiffRef);
  // Retry re-enters the whole episode from the top, same documented, pre-existing tradeoff crash
  // recovery already has (see tests/recovery.test.ts: "Recovery restarts the whole episode from the
  // top... the self-fix loop runs the Implementer again too") — a second COMMIT_CREATED/BRANCH_PUSHED
  // is therefore expected and harmless (idempotent no-op or a real but non-duplicating push); what
  // must never happen is a second workspace/branch or a second PR.
  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1, "no duplicate workspace provisioning from the retry");
  assert.equal(events.filter((t) => t === "BRANCH_CREATED").length, 1, "no duplicate branch from the retry");
  assert.equal(scProvider.pullRequestsCreated, 1, "still exactly one PR despite the redundant re-run");
});

test("a PERSISTENT push failure exhausts the infrastructure retry budget and fails the task (FAILED) even though the commit itself succeeded", async () => {
  const { platform, project, scProvider } = await setup("push-fail-persistent", { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 20, infrastructureRetryMaxDelayMs: 200 });
  const task = makeTask(platform, project);
  scProvider.failEveryCallTo("push");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");
  assert.ok(result.taskRecord.latestDiffRef, "the commit itself should still be recorded as evidence");
  assert.equal(result.taskRecord.pullRequest, null);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("COMMIT_CREATED"));
  assert.ok(!events.includes("BRANCH_PUSHED"));
});

test("a ONE-SHOT PR-creation failure recovers via infrastructure retry, never creating a duplicate PR", async () => {
  const { platform, project, scProvider } = await setup("pr-fail", { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 20, infrastructureRetryMaxDelayMs: 200 });
  const task = makeTask(platform, project);
  scProvider.failNextCallTo("openPullRequest");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  assert.equal(scProvider.pullRequestsCreated, 1, "search-before-create idempotency means the retry never opens a second PR");
});

test("a PERSISTENT PR-creation failure exhausts the infrastructure retry budget and fails the task (FAILED) even though commit and push both succeeded", async () => {
  const { platform, project, scProvider } = await setup("pr-fail-persistent", { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 20, infrastructureRetryMaxDelayMs: 200 });
  const task = makeTask(platform, project);
  scProvider.failEveryCallTo("openPullRequest");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");
  assert.ok(result.taskRecord.latestDiffRef, "commit evidence should still be present");
  assert.equal(result.taskRecord.pullRequest, null, "no PR should be recorded on failure");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("BRANCH_PUSHED"));
  assert.ok(events.includes("SOURCE_CONTROL_FAILED"));
  assert.ok(!events.includes("TASK_MOVED_TO_REVIEW"));
});

test("a cancellation racing the push step reaches CANCELLED, not REVIEW, and opens no PR", async () => {
  const { platform, project, scProvider } = await setup("cancel-race");
  const task = makeTask(platform, project);
  scProvider.cancelNextCallTo("push");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.taskRecord.pullRequest, null);
  assert.equal(scProvider.pullRequestsCreated, 0);
});
