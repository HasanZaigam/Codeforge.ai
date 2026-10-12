import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPlatform } from "../src/platform.js";
import { buildApplicationServices } from "../src/application/index.js";
import { MIGRATION_FILES } from "../src/persistence/db.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { ActionLayerService } from "../src/application/action-layer.js";
import { repositoryNamedIn } from "../src/application/repository-resolution.js";
import {
  BranchInUseError,
  DuplicateRepositoryNameError,
  InvalidRepositoryError,
  RepositoryInUseError,
  RepositoryRequiredError,
} from "../src/application/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Multi-repository projects (TD-62): a project is a container of one or more repositories, and every
 * task / backlog item targets exactly one of them. Real SQLite, real services, real local git repos.
 */
async function setup(label: string) {
  const root = await mkdtemp(join(tmpdir(), `multi-repo-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine: createSelfFixDemoEngine(),
    ownerId: `worker-${label}`,
  });
  const services = buildApplicationServices(platform);
  const ownerId = randomUUID();
  platform.users.insert({ id: ownerId, tenantId: "default", email: `${label}@example.com`, name: label, passwordHash: "", createdAt: new Date().toISOString() });
  const frontendPath = await createFixtureRepo(await mkdirp(join(root, "frontend")));
  const backendPath = await createFixtureRepo(await mkdirp(join(root, "backend")));
  return { platform, services, ownerId, frontendPath, backendPath, close: () => platform.db.close() };
}

async function mkdirp(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** An empty project with two local-git repositories, "frontend" and "backend". */
async function twoRepoProject(h: Awaited<ReturnType<typeof setup>>) {
  // Always the fixture engine — never the real OpenCode CLI that may be installed on the machine.
  const project = await h.services.projects.create({ name: "OTT", codingEngine: "fixture" }, h.ownerId);
  const frontend = await h.services.projects.addRepository(project.id, h.ownerId, { sourceControlProvider: "local-git", name: "frontend", repoUrl: h.frontendPath });
  const backend = await h.services.projects.addRepository(project.id, h.ownerId, { sourceControlProvider: "local-git", name: "backend", repoUrl: h.backendPath });
  return { project, frontend, backend };
}

describe("migration 028 — existing single-repository data", () => {
  test("every existing project becomes a project with one repository, and its tasks and backlog items point at it", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(__dirname, "..", "src", "persistence", "migrations");
    const before = MIGRATION_FILES.slice(0, MIGRATION_FILES.indexOf("028_project_repos.sql"));
    for (const file of before) db.exec(readFileSync(join(migrationsDir, file), "utf-8"));

    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, created_at) VALUES ('u1', 'default', 'u@x', 'U', '', ?)").run(now);
    db.prepare(
      `INSERT INTO projects (id, tenant_id, owner_id, name, repo_url, default_branch, coding_engine, source_control_provider, owner, repo, commands_json, created_at, updated_at)
       VALUES ('p1', 'default', 'u1', 'OTT', 'https://github.com/acme/ott.git', 'develop', 'opencode', 'github', 'acme', 'ott', '{"test":"npm test"}', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO tasks (id, tenant_id, project_id, title, goal, status, task_record_json, created_at, updated_at)
       VALUES ('t1', 'default', 'p1', 'Fix', 'goal', 'BACKLOG', '{}', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO backlog_items (id, project_id, title, description, source, status, created_by, created_at, updated_at)
       VALUES ('b1', 'p1', 'Bug', 'desc', 'manual', 'NEW', 'u1', ?, ?)`,
    ).run(now, now);

    db.exec(readFileSync(join(migrationsDir, "028_project_repos.sql"), "utf-8"));

    const repo = db.prepare("SELECT * FROM project_repos WHERE project_id = 'p1'").get() as Record<string, string>;
    assert.equal(repo.name, "ott");
    assert.equal(repo.repo_url, "https://github.com/acme/ott.git");
    assert.equal(repo.default_branch, "develop");
    assert.equal(repo.source_control_provider, "github");
    assert.equal(repo.commands_json, '{"test":"npm test"}');
    assert.equal((db.prepare("SELECT repository_id FROM tasks WHERE id = 't1'").get() as { repository_id: string }).repository_id, repo.id);
    assert.equal((db.prepare("SELECT repository_id FROM backlog_items WHERE id = 'b1'").get() as { repository_id: string }).repository_id, repo.id);
    db.close();
  });
});

describe("projects and their repositories", () => {
  test("a project can be created with no repository, then have several connected", async () => {
    const h = await setup("create");
    try {
      const empty = await h.services.projects.create({ name: "OTT", codingEngine: "fixture" }, h.ownerId);
      assert.equal(empty.repoUrl, "", "no repository yet — nothing is invented");
      assert.deepEqual(h.services.projects.listRepositories(empty.id, h.ownerId), []);

      const { frontend, backend } = await twoRepoProject(h);
      assert.equal(frontend.name, "frontend");
      assert.equal(backend.repoUrl, h.backendPath);
    } finally {
      h.close();
    }
  });

  test("the original 'project + its one repository' create still works, and the project reads as that repository", async () => {
    const h = await setup("legacy-create");
    try {
      const project = await h.services.projects.create({ name: "Mono", codingEngine: "fixture", sourceControlProvider: "local-git", repoUrl: h.frontendPath, commands: { test: "node test.js" } }, h.ownerId);
      const repos = h.services.projects.listRepositories(project.id, h.ownerId);
      assert.equal(repos.length, 1);
      assert.equal(project.repoUrl, h.frontendPath);
      assert.equal(project.repositoryId, repos[0]!.id);
      assert.deepEqual(repos[0]!.commands, { test: "node test.js" });
    } finally {
      h.close();
    }
  });

  test("repository names are unique within a project, and the same repository can't be connected twice", async () => {
    const h = await setup("dupes");
    try {
      const { project } = await twoRepoProject(h);
      await assert.rejects(
        () => h.services.projects.addRepository(project.id, h.ownerId, { sourceControlProvider: "local-git", name: "Backend", repoUrl: "/somewhere/else" }),
        DuplicateRepositoryNameError,
      );
      await assert.rejects(
        () => h.services.projects.addRepository(project.id, h.ownerId, { sourceControlProvider: "local-git", name: "api", repoUrl: h.backendPath }),
        InvalidRepositoryError,
      );
    } finally {
      h.close();
    }
  });

  test("each repository keeps its own validation commands and default branch", async () => {
    const h = await setup("per-repo-settings");
    try {
      const { project, frontend, backend } = await twoRepoProject(h);
      h.services.projects.updateRepositoryCommands(project.id, backend.id, h.ownerId, { test: "npm test", build: "npm run build" });
      await h.services.projects.updateRepository(project.id, frontend.id, h.ownerId, { name: "web", defaultBranch: "develop" });

      const repos = h.services.projects.listRepositories(project.id, h.ownerId);
      assert.deepEqual(repos.find((r) => r.id === backend.id)!.commands, { test: "npm test", build: "npm run build" });
      assert.equal(repos.find((r) => r.id === frontend.id)!.commands, null);
      assert.equal(repos.find((r) => r.id === frontend.id)!.name, "web");
      assert.equal(repos.find((r) => r.id === frontend.id)!.defaultBranch, "develop");
    } finally {
      h.close();
    }
  });

  test("a repository still targeted by a task can't be removed; an unused one can", async () => {
    const h = await setup("remove");
    try {
      const { project, frontend, backend } = await twoRepoProject(h);
      await h.services.tasks.create({ projectId: project.id, repositoryId: backend.id, title: "API fix", description: "fix the API" }, h.ownerId);

      assert.throws(() => h.services.projects.removeRepository(project.id, backend.id, h.ownerId), RepositoryInUseError);
      h.services.projects.removeRepository(project.id, frontend.id, h.ownerId);
      assert.deepEqual(h.services.projects.listRepositories(project.id, h.ownerId).map((r) => r.name), ["backend"]);
    } finally {
      h.close();
    }
  });

  test("deleting a project removes its repositories too", async () => {
    const h = await setup("delete-project");
    try {
      const { project } = await twoRepoProject(h);
      h.services.projects.delete(project.id, h.ownerId);
      assert.deepEqual(h.platform.projectRepos.listByProject(project.id), []);
    } finally {
      h.close();
    }
  });
});

describe("tasks target exactly one repository", () => {
  test("a multi-repository project never guesses: creating a task without choosing a repository is refused with the options", async () => {
    const h = await setup("required");
    try {
      const { project } = await twoRepoProject(h);
      await assert.rejects(
        () => h.services.tasks.create({ projectId: project.id, title: "Fix login", description: "login is broken" }, h.ownerId),
        (err: unknown) => err instanceof RepositoryRequiredError && err.available.join(",") === "frontend,backend",
      );
    } finally {
      h.close();
    }
  });

  test("a project with no repository refuses task creation with an actionable message", async () => {
    const h = await setup("no-repo");
    try {
      const project = await h.services.projects.create({ name: "Empty", codingEngine: "fixture" }, h.ownerId);
      await assert.rejects(
        () => h.services.tasks.create({ projectId: project.id, title: "Anything", description: "anything" }, h.ownerId),
        (err: unknown) => err instanceof RepositoryRequiredError && /no repository connected/.test(err.message),
      );
    } finally {
      h.close();
    }
  });

  test("a task can't name a repository from another project", async () => {
    const h = await setup("foreign");
    try {
      const { project } = await twoRepoProject(h);
      const other = await h.services.projects.create({ name: "Other", codingEngine: "fixture", sourceControlProvider: "local-git", repoUrl: h.frontendPath }, h.ownerId);
      const otherRepo = h.services.projects.listRepositories(other.id, h.ownerId)[0]!;
      await assert.rejects(
        () => h.services.tasks.create({ projectId: project.id, repositoryId: otherRepo.id, title: "x", description: "x" }, h.ownerId),
        InvalidRepositoryError,
      );
    } finally {
      h.close();
    }
  });

  test("execution clones, branches and validates in the task's OWN repository — not the project's primary one", async () => {
    const h = await setup("execute");
    try {
      const { project, backend } = await twoRepoProject(h); // frontend is primary
      h.services.projects.updateRepositoryCommands(project.id, backend.id, h.ownerId, { test: "node test.js" });
      const task = await h.services.tasks.create({ projectId: project.id, repositoryId: backend.id, title: "Fix add()", description: "add() is wrong" }, h.ownerId);
      assert.equal(task.repositoryId, backend.id);

      h.platform.orchestrator.startTask(task.id);
      await h.platform.orchestrator.executeTask(task.id);

      const finished = h.platform.tasks.findById(task.id)!;
      assert.equal(finished.status, "REVIEW");
      assert.ok(h.platform.agentRuns.listForTask(task.id).length > 0);
      assert.equal(h.platform.workspaces.findByTaskId(task.id)!.repoUrl, h.backendPath, "workspace cloned from the backend repository");
      const branches = await h.services.tasks.listBranches(project.id, h.ownerId, backend.id);
      assert.ok(branches.includes(finished.taskRecord.branchName!), "the task branch was pushed to the backend repository");
      const frontendBranches = await h.services.tasks.listBranches(project.id, h.ownerId, h.services.projects.listRepositories(project.id, h.ownerId)[0]!.id);
      assert.ok(!frontendBranches.includes(finished.taskRecord.branchName!), "and never to the frontend repository");
    } finally {
      h.close();
    }
  });

  test("'existing branch' locking is per repository: main in frontend and main in backend are different branches", async () => {
    const h = await setup("existing-branch");
    try {
      const { project, frontend, backend } = await twoRepoProject(h);
      const input = { projectId: project.id, title: "Hotfix", description: "hotfix", branchMode: "existing" as const, existingBranch: "main" };
      await h.services.tasks.create({ ...input, repositoryId: frontend.id }, h.ownerId);
      await h.services.tasks.create({ ...input, repositoryId: backend.id }, h.ownerId); // not a conflict
      await assert.rejects(() => h.services.tasks.create({ ...input, repositoryId: backend.id }, h.ownerId), BranchInUseError);
    } finally {
      h.close();
    }
  });

  test("a BACKLOG task can be moved to another repository of the same project", async () => {
    const h = await setup("move");
    try {
      const { project, frontend, backend } = await twoRepoProject(h);
      const task = await h.services.tasks.create({ projectId: project.id, repositoryId: frontend.id, title: "Fix", description: "fix" }, h.ownerId);
      const edited = await h.services.tasks.editBacklogTask(task.id, { repositoryId: backend.id, title: "Fix", description: "fix" }, h.ownerId);
      assert.equal(edited.repositoryId, backend.id);
    } finally {
      h.close();
    }
  });
});

describe("backlog and Chat", () => {
  test("a backlog item records its repository, and the task its proposal converts into inherits it", async () => {
    const h = await setup("backlog");
    try {
      const { project, backend } = await twoRepoProject(h);
      const item = h.services.backlog.createItem(project.id, { title: "Slow API", description: "the API is slow", repositoryId: backend.id }, h.ownerId);
      assert.equal(item.repositoryId, backend.id);

      const primaryDefault = h.services.backlog.createItem(project.id, { title: "Other", description: "other" }, h.ownerId);
      assert.equal(primaryDefault.repositoryId, h.services.projects.listRepositories(project.id, h.ownerId)[0]!.id, "absent: the primary repository");

      // Convert through the real path's task-creation step: the proposal's task is created with the item's repository.
      const task = await h.services.tasks.create(
        { projectId: project.id, repositoryId: h.platform.backlogItems.findById(item.id)!.repositoryId, title: "Speed up API", description: "x" },
        h.ownerId,
      );
      assert.equal(task.repositoryId, backend.id);
    } finally {
      h.close();
    }
  });

  test("Chat task creation picks the repository named in the message, and asks when none is named", async () => {
    const h = await setup("chat");
    try {
      const { project, backend } = await twoRepoProject(h);
      const actions = new ActionLayerService({ tasks: h.services.tasks, taskEvents: h.platform.taskEvents, projects: h.platform.projects });

      const named = await actions.createTask(project.id, h.ownerId, { title: "Fix login", description: "Fix login", repositoryHint: "create a task in backend to fix login" });
      assert.equal(named.succeeded, true);
      assert.equal(h.platform.tasks.findById(named.taskId!)!.repositoryId, backend.id);

      const unnamed = await actions.createTask(project.id, h.ownerId, { title: "Fix login", description: "Fix login", repositoryHint: "create a task to fix login" });
      assert.equal(unnamed.succeeded, false);
      assert.match(unnamed.error ?? "", /frontend, backend/);
      assert.match(unnamed.error ?? "", /Mention it by name/);
    } finally {
      h.close();
    }
  });
});

describe("repositoryNamedIn — matching a repository named in a Chat message", () => {
  const repo = (id: string, name: string) => ({ id, projectId: "p", name, repoUrl: `/r/${name}`, defaultBranch: "main", sourceControlProvider: "local-git", owner: null, repo: null, commands: null, createdAt: "", updatedAt: "" });
  const repos = [repo("fe", "frontend"), repo("be", "backend"), repo("ad", "admin-panel")];

  test("matches a whole-word, case-insensitive name", () => {
    assert.equal(repositoryNamedIn(repos, "Fix the login bug in Backend please")?.id, "be");
    assert.equal(repositoryNamedIn(repos, "these are the admin-panel bugs")?.id, "ad");
  });

  test("never guesses: no name, several names, a partial word, or a single-repository project all return null", () => {
    assert.equal(repositoryNamedIn(repos, "fix the login bug"), null);
    assert.equal(repositoryNamedIn(repos, "sync frontend and backend"), null);
    assert.equal(repositoryNamedIn(repos, "the backends are slow"), null);
    assert.equal(repositoryNamedIn([repo("fe", "frontend")], "fix frontend"), null);
  });
});
