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
async function setup(label: string) {
  const engine = createSelfFixDemoEngine();
  const root = await mkdtemp(join(tmpdir(), `gh-sc-test-${label}-`));
  const scProvider = new FakeSourceControlProvider("github");
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    additionalSourceControlProviders: [scProvider],
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

test("a commit failure fails the task (FAILED, not REVIEW or DONE) and never fabricates a PR", async () => {
  const { platform, project, scProvider } = await setup("commit-fail");
  const task = makeTask(platform, project);
  scProvider.failNextCallTo("commitAll");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");
  assert.equal(result.taskRecord.pullRequest, null);
  assert.equal(scProvider.pullRequestsCreated, 0);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("SOURCE_CONTROL_FAILED"));
  assert.ok(events.includes("TASK_FAILED"));
  assert.ok(!events.includes("TASK_MOVED_TO_REVIEW"));
});

test("a push failure fails the task (FAILED) even though the commit itself succeeded", async () => {
  const { platform, project, scProvider } = await setup("push-fail");
  const task = makeTask(platform, project);
  scProvider.failNextCallTo("push");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");
  assert.ok(result.taskRecord.latestDiffRef, "the commit itself should still be recorded as evidence");
  assert.equal(result.taskRecord.pullRequest, null);

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(events.includes("COMMIT_CREATED"));
  assert.ok(events.includes("SOURCE_CONTROL_FAILED"));
  assert.ok(!events.includes("BRANCH_PUSHED"));
});

test("a PR-creation failure fails the task (FAILED) even though commit and push both succeeded", async () => {
  const { platform, project, scProvider } = await setup("pr-fail");
  const task = makeTask(platform, project);
  scProvider.failNextCallTo("openPullRequest");

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
