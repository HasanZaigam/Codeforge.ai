import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { TaskService } from "../src/application/task-service.js";
import { ProjectService } from "../src/application/project-service.js";
import { GitHubIntegrationService } from "../src/application/github-integration-service.js";
import { BranchInUseError } from "../src/application/errors.js";
import { Worker } from "../src/worker/worker.js";
import { LocalGitSourceControlProvider } from "../src/source-control/local-git-source-control-provider.js";
import type { Project } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * This milestone's genuine gaps (see /docs/TASK_LIFECYCLE.md "Branch modes"):
 *   §6  DB-level closure of the "existing branch" collision check-then-insert race
 *   §8  branch-deleted-after-creation-before-execution re-validation
 *   §9  stale/behind detection (real git plumbing, local-git)
 *   §17 real concurrent execution (not just sequential API calls)
 *   §18 security — malicious branch names against the new git plumbing this milestone adds
 * All against the same real LocalGitWorkspaceProvider/LocalGitSourceControlProvider components
 * production uses — see /docs/GITHUB_INTEGRATION.md "Testing without GitHub".
 */
async function setup(label: string) {
  const root = await mkdtemp(join(tmpdir(), `branch-milestone-${label}-`));
  const engine = createSelfFixDemoEngine();
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const github = new GitHubIntegrationService(platform.githubCredentials, () => Buffer.alloc(32));
  const projectService = new ProjectService(platform.projects, platform.projectWorkspaces, github);
  const taskService = new TaskService(
    platform.tasks,
    platform.taskEvents,
    platform.agentRuns,
    platform.projects,
    platform.orchestrator,
    platform.sourceControlProviders,
    platform.taskDependencies,
  );
  return { platform, repoPath, projectService, taskService, root };
}

function insertOwner(platform: Platform, ownerId: string): void {
  const now = new Date().toISOString();
  platform.users.insert({ id: ownerId, tenantId: "default", email: `${ownerId}@example.com`, name: ownerId, passwordHash: "", createdAt: now });
}

function makeLocalGitProject(overrides: Partial<Project> = {}, repoPath: string, ownerId: string): Project {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: "default",
    ownerId,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: "fixture",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function teardown(platform: Platform): Promise<void> {
  platform.db.close();
}

// ---------------------------------------------------------------------------
// §6 — DB-level closure of the check-then-insert race (real concurrency, not
// sequential calls: local-git's own listBranches() is a real async I/O call,
// so two concurrent taskService.create() calls both pass the in-app
// pre-check before either has inserted its row — exactly the race the
// unique partial index (migrations/007_branch_race_closure.sql) exists to
// close). See §17(b).
// ---------------------------------------------------------------------------

test("§6/§17(b): two truly concurrent existing-branch creates targeting the same branch — exactly one wins, the other is rejected via BranchInUseError, never both", async () => {
  const { platform, repoPath, taskService } = await setup("race");
  try {
    await execFileAsync("git", ["branch", "shared-branch"], { cwd: repoPath });
    const project = makeLocalGitProject({}, repoPath, "owner-race");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const results = await Promise.allSettled([
      taskService.create({ projectId: project.id, title: "Racer A", description: "D", branchMode: "existing", existingBranch: "shared-branch" }, "owner-race"),
      taskService.create({ projectId: project.id, title: "Racer B", description: "D", branchMode: "existing", existingBranch: "shared-branch" }, "owner-race"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent create must win");
    assert.equal(rejected.length, 1, "exactly one concurrent create must be rejected");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof BranchInUseError);

    // The DB itself has exactly one non-terminal task on this branch — never two, even transiently.
    const active = platform.tasks.listActiveUsingExistingBranch(project.id, "shared-branch");
    assert.equal(active.length, 1);
  } finally {
    await teardown(platform);
  }
});

// ---------------------------------------------------------------------------
// §8 — branch deleted after task creation, before the worker starts it
// ---------------------------------------------------------------------------

test("§8: an existing-branch task whose branch is deleted after creation fails gracefully with a clear error, not a crash or silent wrong-ref checkout", async () => {
  const { platform, repoPath, taskService } = await setup("deleted-branch");
  try {
    await execFileAsync("git", ["branch", "soon-deleted"], { cwd: repoPath });
    const project = makeLocalGitProject({}, repoPath, "owner-deleted");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const task = await taskService.create(
      { projectId: project.id, title: "Fix add()", description: "D", branchMode: "existing", existingBranch: "soon-deleted" },
      "owner-deleted",
    );
    assert.equal(task.status, "BACKLOG");
    platform.orchestrator.startTask(task.id); // release BACKLOG -> TODO, the new human gate

    // Deleted from the remote AFTER task creation, BEFORE the worker ever picks it up — exactly the
    // gap this milestone closes (TaskService.create's own validation only ever ran once, at creation).
    await execFileAsync("git", ["branch", "-D", "soon-deleted"], { cwd: repoPath });

    await platform.orchestrator.executeTask(task.id);
    const finished = platform.tasks.findById(task.id)!;
    assert.equal(finished.status, "FAILED", "must fail cleanly, never crash the worker or silently proceed");

    const events = platform.taskEvents.listForTask(task.id);
    const failed = events.find((e) => e.type === "TASK_FAILED");
    assert.ok(failed, "a clear TASK_FAILED event must be recorded");
    const reason = String((failed!.payload as { error: string }).error);
    assert.ok(reason.includes("soon-deleted"), "the error must name the missing branch");
    assert.ok(reason.includes("no longer exists"), "the error must be clear and human-readable");
    assert.ok(!reason.includes("\n    at "), "must never leak a raw stack trace"); // no "at Object.<anonymous>" frames
  } finally {
    await teardown(platform);
  }
});

test("§8: a new-branch task whose custom base branch is deleted before execution fails gracefully, never silently branching off the wrong ref", async () => {
  const { platform, repoPath, taskService } = await setup("deleted-base");
  try {
    await execFileAsync("git", ["checkout", "-b", "temp-base"], { cwd: repoPath });
    await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "temp base marker"], { cwd: repoPath });
    await execFileAsync("git", ["checkout", "main"], { cwd: repoPath });

    const project = makeLocalGitProject({}, repoPath, "owner-deleted-base");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const task = await taskService.create(
      { projectId: project.id, title: "Fix add()", description: "D", branchMode: "new", baseBranch: "temp-base" },
      "owner-deleted-base",
    );

    await execFileAsync("git", ["branch", "-D", "temp-base"], { cwd: repoPath });

    platform.orchestrator.startTask(task.id); // release BACKLOG -> TODO, the new human gate
    await platform.orchestrator.executeTask(task.id);
    const finished = platform.tasks.findById(task.id)!;
    assert.equal(finished.status, "FAILED");
    const events = platform.taskEvents.listForTask(task.id);
    const reason = String((events.find((e) => e.type === "TASK_FAILED")!.payload as { error: string }).error);
    assert.ok(reason.includes("temp-base"));
  } finally {
    await teardown(platform);
  }
});

// ---------------------------------------------------------------------------
// §9 — stale/behind detection (real git plumbing, local-git) — detection
// only, never remediation.
// ---------------------------------------------------------------------------

test("§9: getBranchStatus reports real ahead/behind counts via git rev-list, and updates as the base branch moves", async () => {
  const { platform, repoPath, taskService } = await setup("behind");
  try {
    const project = makeLocalGitProject({}, repoPath, "owner-behind");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const task = await taskService.create({ projectId: project.id, title: "Fix add()", description: "D" }, "owner-behind");
    platform.orchestrator.startTask(task.id); // release BACKLOG -> TODO, the new human gate
    await platform.orchestrator.executeTask(task.id);
    assert.equal(platform.tasks.findById(task.id)!.status, "REVIEW");

    // Fresh — the task's branch was just created from `main`; nothing behind yet.
    const fresh = await taskService.getBranchState(task.id, "owner-behind");
    assert.equal(fresh.comparable, true);
    assert.equal(fresh.behindBy, 0);

    // Advance `main` by two commits the task's branch never picked up.
    await execFileAsync("git", ["checkout", "main"], { cwd: repoPath });
    await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "m1"], { cwd: repoPath });
    await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "m2"], { cwd: repoPath });

    const behind = await taskService.getBranchState(task.id, "owner-behind");
    assert.equal(behind.comparable, true);
    assert.equal(behind.behindBy, 2, "must report the real, current commit count — not a stale/cached value");
  } finally {
    await teardown(platform);
  }
});

test("§9/§18: getBranchStatus/branchExists never crash or execute arbitrary commands for a malicious branch name — argv-based execFile, no shell interpolation", async () => {
  const provider = new LocalGitSourceControlProvider();
  const project = makeLocalGitProject({}, "/tmp/does-not-matter", "owner-mal");
  const signal = new AbortController().signal;

  const maliciousRefs = [
    "; rm -rf / #",
    "$(rm -rf /)",
    "`rm -rf /`",
    "--upload-pack=/bin/sh",
    "-o ProxyCommand=touch /tmp/pwned",
    "../../../etc/passwd",
    "a && touch /tmp/pwned",
  ];

  for (const ref of maliciousRefs) {
    const exists = await provider.branchExists(project, ref, signal);
    assert.equal(exists, ref.startsWith("-") ? null : exists, `branchExists must never throw for "${ref}"`);
    const status = await provider.getBranchStatus(project, ref, "main", signal);
    assert.equal(status.comparable, false, `a malicious/unsafe ref must never be reported as comparable: "${ref}"`);
  }
});

// ---------------------------------------------------------------------------
// §17 — real concurrent execution (via the worker/orchestrator harness, not
// sequential API calls)
// ---------------------------------------------------------------------------

test("§17(a): two new-branch tasks running concurrently both succeed independently, with distinct branches/workspaces", async () => {
  const { platform, repoPath, taskService } = await setup("concurrent-new");
  try {
    const project = makeLocalGitProject({}, repoPath, "owner-a");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const [taskA, taskB] = await Promise.all([
      taskService.create({ projectId: project.id, title: "Task A", description: "D", branchMode: "new", branchName: "task/alpha" }, "owner-a"),
      taskService.create({ projectId: project.id, title: "Task B", description: "D", branchMode: "new", branchName: "task/beta" }, "owner-a"),
    ]);
    platform.orchestrator.startTask(taskA.id); // release BACKLOG -> TODO, the new human gate
    platform.orchestrator.startTask(taskB.id);

    const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
    await worker.tick();
    await worker.stop();

    const finishedA = platform.tasks.findById(taskA.id)!;
    const finishedB = platform.tasks.findById(taskB.id)!;
    assert.equal(finishedA.status, "REVIEW");
    assert.equal(finishedB.status, "REVIEW");
    assert.equal(finishedA.taskRecord.branchName, "task/alpha");
    assert.equal(finishedB.taskRecord.branchName, "task/beta");

    const wsA = platform.workspaces.findByTaskId(taskA.id)!;
    const wsB = platform.workspaces.findByTaskId(taskB.id)!;
    assert.notEqual(wsA.path, wsB.path, "each concurrent task must get its own isolated workspace directory");
  } finally {
    await teardown(platform);
  }
});

test("§17(b): existing-branch tasks on the same branch — one succeeds, one is rejected safely, driven through a real worker tick", async () => {
  const { platform, repoPath, taskService } = await setup("concurrent-existing-same");
  try {
    await execFileAsync("git", ["branch", "shared"], { cwd: repoPath });
    const project = makeLocalGitProject({}, repoPath, "owner-b");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const first = await taskService.create({ projectId: project.id, title: "First", description: "D", branchMode: "existing", existingBranch: "shared" }, "owner-b");
    await assert.rejects(
      () => taskService.create({ projectId: project.id, title: "Second", description: "D", branchMode: "existing", existingBranch: "shared" }, "owner-b"),
      BranchInUseError,
    );
    platform.orchestrator.startTask(first.id); // release BACKLOG -> TODO, the new human gate

    const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
    await worker.tick();
    await worker.stop();
    assert.equal(platform.tasks.findById(first.id)!.status, "REVIEW");
  } finally {
    await teardown(platform);
  }
});

test("§17(c): two existing-branch tasks on two DIFFERENT branches both succeed concurrently, with no cross-contamination", async () => {
  const { platform, repoPath, taskService } = await setup("concurrent-existing-diff");
  try {
    await execFileAsync("git", ["branch", "branch-one"], { cwd: repoPath });
    await execFileAsync("git", ["branch", "branch-two"], { cwd: repoPath });
    const project = makeLocalGitProject({}, repoPath, "owner-c");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const [taskOne, taskTwo] = await Promise.all([
      taskService.create({ projectId: project.id, title: "One", description: "D", branchMode: "existing", existingBranch: "branch-one" }, "owner-c"),
      taskService.create({ projectId: project.id, title: "Two", description: "D", branchMode: "existing", existingBranch: "branch-two" }, "owner-c"),
    ]);
    platform.orchestrator.startTask(taskOne.id); // release BACKLOG -> TODO, the new human gate
    platform.orchestrator.startTask(taskTwo.id);

    const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
    await worker.tick();
    await worker.stop();

    const finishedOne = platform.tasks.findById(taskOne.id)!;
    const finishedTwo = platform.tasks.findById(taskTwo.id)!;
    assert.equal(finishedOne.status, "REVIEW");
    assert.equal(finishedTwo.status, "REVIEW");

    const wsOne = platform.workspaces.findByTaskId(taskOne.id)!;
    const wsTwo = platform.workspaces.findByTaskId(taskTwo.id)!;
    assert.equal(wsOne.branch, "branch-one");
    assert.equal(wsTwo.branch, "branch-two");
    assert.notEqual(wsOne.path, wsTwo.path);

    // No cross-contamination: each branch in the source repo only has the one task's commit on it.
    const { stdout: logOne } = await execFileAsync("git", ["log", "branch-one", "--oneline"], { cwd: repoPath });
    const { stdout: logTwo } = await execFileAsync("git", ["log", "branch-two", "--oneline"], { cwd: repoPath });
    assert.ok(logOne.includes(`[task ${taskOne.id.slice(0, 8)}]`));
    assert.ok(!logOne.includes(`[task ${taskTwo.id.slice(0, 8)}]`));
    assert.ok(logTwo.includes(`[task ${taskTwo.id.slice(0, 8)}]`));
    assert.ok(!logTwo.includes(`[task ${taskOne.id.slice(0, 8)}]`));
  } finally {
    await teardown(platform);
  }
});
