import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { TaskService } from "../src/application/task-service.js";
import { ProjectService } from "../src/application/project-service.js";
import { GitHubIntegrationService } from "../src/application/github-integration-service.js";
import { BranchInUseError, InvalidBranchSelectionError } from "../src/application/errors.js";
import type { Project } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * Part D/E/I coverage: the branch-mode task-creation feature (see
 * /docs/TASK_LIFECYCLE.md "Branch modes"). Exercises the real
 * LocalGitWorkspaceProvider/LocalGitSourceControlProvider end to end —
 * exactly the same components a "new" or "existing" branch-mode task uses in
 * production, just against a disposable local fixture repo instead of a live
 * GitHub remote (see /docs/GITHUB_INTEGRATION.md "Testing without GitHub").
 */
async function setup(label: string) {
  const root = await mkdtemp(join(tmpdir(), `branch-mode-${label}-`));
  const engine = createSelfFixDemoEngine();
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const github = new GitHubIntegrationService(platform.githubCredentials, () => Buffer.alloc(32));
  const projectService = new ProjectService(platform.projects, platform.projectWorkspaces, platform.projectWorkspaceFs, platform.projectContext, github, platform.tasks, platform.projectRepos);
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
    id: crypto.randomUUID(),
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

test("backward compatibility: creating a task with no branchMode defaults to 'new' with an auto-derived branch name", async () => {
  const { platform, repoPath, taskService, root } = await setup("default");
  try {
    const project = makeLocalGitProject({}, repoPath, "owner-1");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const task = await taskService.create({ projectId: project.id, title: "Fix add()", description: "add() returns the wrong result" }, "owner-1");
    assert.equal(task.branchMode, "new");
    assert.equal(task.workingBranch, null);
    assert.equal(task.baseBranch, null);

    platform.orchestrator.startTask(task.id); // release BACKLOG -> TODO, the new human gate
    await platform.orchestrator.executeTask(task.id);
    const finished = platform.tasks.findById(task.id)!;
    assert.equal(finished.status, "REVIEW");
    assert.ok(finished.taskRecord.branchName?.startsWith("task/"), "auto-derived branch name unchanged from pre-branch-mode behavior");

    const workspace = platform.workspaces.findByTaskId(task.id)!;
    assert.equal(workspace.branch, finished.taskRecord.branchName);
  } finally {
    await teardown(platform);
    void root;
  }
});

test("new-branch mode: a custom branch name and base branch are honored, and the branch is actually created from that base", async () => {
  const { platform, repoPath, taskService } = await setup("custom-new");
  try {
    // Create a second base branch with a distinguishing commit, so we can prove the clone/branch
    // actually came from it rather than from `main`.
    await execFileAsync("git", ["checkout", "-b", "release"], { cwd: repoPath });
    await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "release marker"], { cwd: repoPath });
    await execFileAsync("git", ["checkout", "main"], { cwd: repoPath });

    const project = makeLocalGitProject({}, repoPath, "owner-2");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const task = await taskService.create(
      { projectId: project.id, title: "Fix add()", description: "add() returns the wrong result", branchMode: "new", branchName: "feature/custom-name", baseBranch: "release" },
      "owner-2",
    );
    assert.equal(task.branchMode, "new");
    assert.equal(task.workingBranch, "feature/custom-name");
    assert.equal(task.baseBranch, "release");

    platform.orchestrator.startTask(task.id); // release BACKLOG -> TODO, the new human gate
    await platform.orchestrator.executeTask(task.id);
    const finished = platform.tasks.findById(task.id)!;
    assert.equal(finished.status, "REVIEW");
    assert.equal(finished.taskRecord.branchName, "feature/custom-name");

    const workspace = platform.workspaces.findByTaskId(task.id)!;
    assert.equal(workspace.branch, "feature/custom-name");

    const events = platform.taskEvents.listForTask(task.id);
    const branchCreated = events.find((e) => e.type === "BRANCH_CREATED");
    assert.ok(branchCreated);
    assert.equal((branchCreated!.payload as { baseBranch: string }).baseBranch, "release");
  } finally {
    await teardown(platform);
  }
});

test("new-branch mode rejects a branch name identical to its own base branch", async () => {
  const { platform, repoPath, taskService } = await setup("same-name");
  try {
    const project = makeLocalGitProject({}, repoPath, "owner-3");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    await assert.rejects(
      () => taskService.create({ projectId: project.id, title: "T", description: "D", branchMode: "new", branchName: "main" }, "owner-3"),
      InvalidBranchSelectionError,
    );
  } finally {
    await teardown(platform);
  }
});

test("existing-branch mode checks out the selected branch directly — no new branch is ever created", async () => {
  const { platform, repoPath, taskService } = await setup("existing");
  try {
    await execFileAsync("git", ["branch", "already-here"], { cwd: repoPath });

    const project = makeLocalGitProject({}, repoPath, "owner-4");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const task = await taskService.create(
      { projectId: project.id, title: "Fix add()", description: "add() returns the wrong result", branchMode: "existing", existingBranch: "already-here" },
      "owner-4",
    );
    assert.equal(task.branchMode, "existing");
    assert.equal(task.workingBranch, "already-here");
    assert.equal(task.baseBranch, null);

    platform.orchestrator.startTask(task.id); // release BACKLOG -> TODO, the new human gate
    await platform.orchestrator.executeTask(task.id);
    const finished = platform.tasks.findById(task.id)!;
    assert.equal(finished.status, "REVIEW");
    assert.equal(finished.taskRecord.branchName, "already-here");

    const workspace = platform.workspaces.findByTaskId(task.id)!;
    assert.equal(workspace.branch, "already-here");

    // No BRANCH_CREATED event: existing mode never creates a branch.
    const events = platform.taskEvents.listForTask(task.id);
    assert.ok(!events.some((e) => e.type === "BRANCH_CREATED"), "existing-branch mode must never emit BRANCH_CREATED");

    // The pushed commit landed directly on "already-here" in the source repo — confirms the
    // platform committed onto the existing branch rather than creating a new one under the hood.
    const { stdout } = await execFileAsync("git", ["log", "already-here", "--oneline"], { cwd: repoPath });
    assert.ok(stdout.includes(`[task ${task.id.slice(0, 8)}]`));
  } finally {
    await teardown(platform);
  }
});

test("existing-branch mode rejects a branch that doesn't exist on the remote (best-effort, since GitHub would enumerate it authoritatively)", async () => {
  const { platform, repoPath, taskService } = await setup("missing-branch");
  try {
    const project = makeLocalGitProject({}, repoPath, "owner-5");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    // local-git's listBranches is best-effort via `git ls-remote --heads` — this repo does have at
    // least one real branch ("main"), so the listing is non-empty and authoritative enough to
    // reject a branch that plainly isn't in it.
    await assert.rejects(
      () => taskService.create({ projectId: project.id, title: "T", description: "D", branchMode: "existing", existingBranch: "does-not-exist" }, "owner-5"),
      InvalidBranchSelectionError,
    );
  } finally {
    await teardown(platform);
  }
});

test("existing-branch mode rejects a second concurrent task targeting the exact same branch in the same project", async () => {
  const { platform, repoPath, taskService } = await setup("concurrent");
  try {
    await execFileAsync("git", ["branch", "shared-branch"], { cwd: repoPath });

    const project = makeLocalGitProject({}, repoPath, "owner-6");
    insertOwner(platform, project.ownerId);
    platform.projects.insert(project);

    const first = await taskService.create(
      { projectId: project.id, title: "First task", description: "D", branchMode: "existing", existingBranch: "shared-branch" },
      "owner-6",
    );
    assert.equal(first.status, "BACKLOG"); // still non-terminal — the second create must be rejected

    await assert.rejects(
      () => taskService.create({ projectId: project.id, title: "Second task", description: "D", branchMode: "existing", existingBranch: "shared-branch" }, "owner-6"),
      BranchInUseError,
    );

    // A different branch for the same project is unaffected.
    await execFileAsync("git", ["branch", "other-branch"], { cwd: repoPath });
    const third = await taskService.create(
      { projectId: project.id, title: "Third task", description: "D", branchMode: "existing", existingBranch: "other-branch" },
      "owner-6",
    );
    assert.equal(third.branchMode, "existing");

    // Once the first task reaches a terminal state, its branch is free again.
    await platform.orchestrator.requestCancellation(first.id, "owner-6");
    const fourth = await taskService.create(
      { projectId: project.id, title: "Fourth task", description: "D", branchMode: "existing", existingBranch: "shared-branch" },
      "owner-6",
    );
    assert.equal(fourth.workingBranch, "shared-branch");
  } finally {
    await teardown(platform);
  }
});
