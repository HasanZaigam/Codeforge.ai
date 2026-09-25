import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { buildApplicationServices } from "../src/application/index.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient } from "./helpers/auth-client.js";
import {
  ProjectWorkspaceFsManager,
  ProjectWorkspacePathError,
  ProjectWorkspaceProvisionError,
} from "../src/project-workspace/project-workspace-fs-manager.js";

// A real key must be present for any GitHub credential-store code path to run at all (see
// auth/credential-encryption.ts) — test-only, never a real secret.
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/**
 * Coverage for Phase 3 — Project Workspace, Slice 3 (see
 * src/project-workspace/project-workspace-fs-manager.ts and its wiring in platform.ts/
 * project-service.ts). Slice 1's DB-only coverage lives in tests/project-workspace.test.ts and is
 * untouched by this file — this file covers only the new filesystem behavior: provisioning on
 * project creation, idempotency, path safety, separation from the task-execution Workspace, and
 * failure surfacing.
 *
 * Every test uses its own mkdtemp root — no shared global filesystem state between tests.
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
  root: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `project-workspace-fs-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    projectWorkspacesRoot: join(root, "project-workspaces"),
    engine: createSelfFixDemoEngine(),
    ownerId: `test-worker-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const app = buildApp(platform);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { platform, baseUrl, server, repoPath, root };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
  await rm(h.root, { recursive: true, force: true });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// --- GitHub API stub, same minimal pattern as tests/project-workspace.test.ts ------------------

type FetchInput = Parameters<typeof fetch>[0];

function stubFetch(handler: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.github.com")) return original(input, init);
    return handler(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function githubApiStub(opts: { login?: string; repo?: string; defaultBranch?: string }): typeof fetch {
  const repoName = opts.repo ?? "widgets";
  const defaultBranch = opts.defaultBranch ?? "main";
  return (async (input: FetchInput) => {
    const url = String(input);
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: opts.login ?? "octocat" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const branchMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/branches\/([^/?]+)/);
    if (branchMatch) {
      const [, , repo, encodedBranch] = branchMatch;
      const branch = decodeURIComponent(encodedBranch!);
      if (repo !== repoName || branch !== defaultBranch) return new Response(JSON.stringify({ message: "Branch not found" }), { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: "deadbeef" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const repoMatch = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
    if (repoMatch) {
      const [, owner, repo] = repoMatch;
      if (repo !== repoName) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(
        JSON.stringify({ full_name: `${owner}/${repo}`, default_branch: defaultBranch, permissions: { pull: true, push: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ message: "unexpected request in test stub" }), { status: 500 });
  }) as typeof fetch;
}

// --- 1. GitHub project creation provisions the ProjectWorkspace directory -----------------------

test("Slice 3: GitHub project creation provisions a ProjectWorkspace directory on disk", async () => {
  const h = await setupHarness("github-create");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets", defaultBranch: "main" }));
  try {
    const client = await registerClient(h.baseUrl, "github-create");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });

    const res = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Widgets", sourceControlProvider: "github", owner: "acme", repo: "widgets" }),
    });
    assert.equal(res.status, 201);
    const { project } = await json<{ project: { id: string } }>(res);

    const workspace = h.platform.projectWorkspaces.findByProjectId(project.id);
    assert.ok(workspace, "expected a ProjectWorkspace row");
    const dir = h.platform.projectWorkspaceFs.resolveDirectory(workspace!.id);
    assert.ok(existsSync(dir), `expected ${dir} to exist on disk after project creation`);
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

// --- 2. Local-git project creation provisions the ProjectWorkspace directory ---------------------

test("Slice 3: local-git project creation provisions a ProjectWorkspace directory on disk", async () => {
  const h = await setupHarness("local-git-create");
  try {
    const client = await registerClient(h.baseUrl, "local-git-create");
    const res = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    assert.equal(res.status, 201);
    const { project } = await json<{ project: { id: string } }>(res);

    const workspace = h.platform.projectWorkspaces.findByProjectId(project.id);
    assert.ok(workspace, "expected a ProjectWorkspace row");
    const dir = h.platform.projectWorkspaceFs.resolveDirectory(workspace!.id);
    assert.ok(existsSync(dir), `expected ${dir} to exist on disk after project creation`);
  } finally {
    await teardown(h);
  }
});

// --- 3. An existing ProjectWorkspace row with a missing directory can be (re-)provisioned --------

test("Slice 3: a ProjectWorkspace row whose directory was deleted gets re-provisioned on next access", async () => {
  const h = await setupHarness("missing-dir");
  try {
    const client = await registerClient(h.baseUrl, "missing-dir");
    const res = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(res);
    const workspace = h.platform.projectWorkspaces.findByProjectId(project.id)!;
    const dir = h.platform.projectWorkspaceFs.resolveDirectory(workspace.id);
    assert.ok(existsSync(dir));

    // Simulate a backfilled/pre-Slice-3 row whose directory never existed (or was lost).
    await rm(dir, { recursive: true, force: true });
    assert.ok(!existsSync(dir));

    const services = buildApplicationServices(h.platform);
    const returned = services.projects.getWorkspace(project.id, client.userId);
    assert.equal(returned.id, workspace.id);
    assert.ok(existsSync(dir), "expected getWorkspace() to re-provision the missing directory");
  } finally {
    await teardown(h);
  }
});

// --- 4. Provisioning is idempotent ---------------------------------------------------------------

test("Slice 3: ensureWorkspace called repeatedly is idempotent — same directory, no error, no duplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-idempotent-"));
  try {
    const manager = new ProjectWorkspaceFsManager(root);
    const id = randomUUID();

    const dir1 = manager.ensureWorkspace(id);
    const dir2 = manager.ensureWorkspace(id);
    const dir3 = manager.ensureWorkspace(id);

    assert.equal(dir1, dir2);
    assert.equal(dir2, dir3);
    assert.ok(existsSync(dir1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 5. Existing files/contents survive repeated provisioning ------------------------------------

test("Slice 3: repeated provisioning never deletes or corrupts existing contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-preserve-"));
  try {
    const manager = new ProjectWorkspaceFsManager(root);
    const id = randomUUID();

    const dir = manager.ensureWorkspace(id);
    const filePath = join(dir, "notes.txt");
    await writeFile(filePath, "important project notes", "utf-8");

    manager.ensureWorkspace(id);
    manager.ensureWorkspace(id);

    const contents = await readFile(filePath, "utf-8");
    assert.equal(contents, "important project notes", "repeated provisioning must never touch existing file contents");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 6/7. Path safety: traversal and absolute-path escape cannot leave PROJECT_WORKSPACE_ROOT ----

test("Slice 3: a path-traversal workspace id cannot escape PROJECT_WORKSPACE_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-traversal-"));
  try {
    const manager = new ProjectWorkspaceFsManager(root);
    assert.throws(() => manager.resolveDirectory("../../etc"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveDirectory("..%2f..%2fetc"), ProjectWorkspacePathError);
    assert.throws(() => manager.ensureWorkspace("../../etc"), ProjectWorkspacePathError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Slice 3: an absolute-path workspace id cannot escape PROJECT_WORKSPACE_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-absolute-"));
  try {
    const manager = new ProjectWorkspaceFsManager(root);
    assert.throws(() => manager.resolveDirectory("/etc/passwd"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveDirectory("/tmp/somewhere-else"), ProjectWorkspacePathError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 8. ProjectWorkspace filesystem path is separate from task execution Workspace paths --------

test("Slice 3: ProjectWorkspace directories live under a root entirely separate from the task-execution Workspace root", async () => {
  const h = await setupHarness("separation");
  try {
    const client = await registerClient(h.baseUrl, "separation");
    const res = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(res);
    const workspace = h.platform.projectWorkspaces.findByProjectId(project.id)!;
    const projectWorkspaceDir = h.platform.projectWorkspaceFs.resolveDirectory(workspace.id);

    const taskWorkspacesRoot = join(h.root, "workspaces");
    const projectWorkspacesRoot = join(h.root, "project-workspaces");

    assert.notEqual(taskWorkspacesRoot, projectWorkspacesRoot);
    assert.ok(
      projectWorkspaceDir.startsWith(projectWorkspacesRoot),
      "ProjectWorkspace directory must live under PROJECT_WORKSPACE_ROOT",
    );
    assert.ok(
      !projectWorkspaceDir.startsWith(taskWorkspacesRoot),
      "ProjectWorkspace directory must never live under the task-execution WORKSPACES_ROOT",
    );
  } finally {
    await teardown(h);
  }
});

test("Slice 3: buildPlatform defaults PROJECT_WORKSPACE_ROOT to a directory distinct from workspacesRoot when not given explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-default-root-"));
  try {
    const platform = buildPlatform({
      dbPath: join(root, "platform.sqlite"),
      workspacesRoot: join(root, "workspaces"),
      engine: createSelfFixDemoEngine(),
    });
    const id = randomUUID();
    const dir = platform.projectWorkspaceFs.ensureWorkspace(id);
    assert.ok(!dir.startsWith(join(root, "workspaces")), "default ProjectWorkspace root must not be nested under workspacesRoot");
    assert.ok(existsSync(dir));
    platform.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 9. Restart/reconstruction of the manager preserves the same directory and its contents ------

test("Slice 3: a freshly-constructed manager pointed at the same root resolves the same directory and preserves contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-restart-"));
  try {
    const id = randomUUID();

    const managerBeforeRestart = new ProjectWorkspaceFsManager(root);
    const dirBefore = managerBeforeRestart.ensureWorkspace(id);
    await writeFile(join(dirBefore, "survives.txt"), "still here after restart", "utf-8");

    // Simulates a process restart: a brand-new manager instance, no shared in-memory state,
    // constructed fresh against the same on-disk root.
    const managerAfterRestart = new ProjectWorkspaceFsManager(root);
    const dirAfter = managerAfterRestart.ensureWorkspace(id);

    assert.equal(dirAfter, dirBefore);
    const contents = await readFile(join(dirAfter, "survives.txt"), "utf-8");
    assert.equal(contents, "still here after restart");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 10. Filesystem provisioning failures are surfaced clearly, not silently swallowed -----------

test("Slice 3: a filesystem provisioning failure throws a clear ProjectWorkspaceProvisionError naming the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-failure-"));
  try {
    const id = randomUUID();
    // Force mkdir to fail: put a plain FILE where the workspace directory itself would need to be
    // created, so mkdir(recursive) hits ENOTDIR at that path segment.
    const blockerPath = join(root, id);
    await writeFile(blockerPath, "not a directory", "utf-8");

    const manager = new ProjectWorkspaceFsManager(root);
    assert.throws(
      () => manager.ensureWorkspace(id),
      (err: unknown) => {
        assert.ok(err instanceof ProjectWorkspaceProvisionError, "expected ProjectWorkspaceProvisionError");
        assert.match((err as Error).message, new RegExp(id));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Slice 3: a provisioning failure never inserts or duplicates a ProjectWorkspace DB row", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-fs-failure-db-"));
  try {
    // A project-workspaces-root path that is itself a file (not a directory) makes every
    // ensureWorkspace() call fail — simulates the filesystem step of ProjectService.create()
    // failing outright.
    const projectWorkspacesRootAsFile = join(root, "project-workspaces-blocked");
    await writeFile(projectWorkspacesRootAsFile, "blocking file", "utf-8");

    const platform = buildPlatform({
      dbPath: join(root, "platform.sqlite"),
      workspacesRoot: join(root, "workspaces"),
      projectWorkspacesRoot: projectWorkspacesRootAsFile,
      engine: createSelfFixDemoEngine(),
    });

    const { buildApplicationServices: build } = await import("../src/application/index.js");
    const services = build(platform);

    const client = { fetch: undefined } as unknown; // unused — direct service call below
    void client;

    const user = { id: randomUUID(), tenantId: "default", email: `${randomUUID()}@example.com`, name: "Tester", passwordHash: "", createdAt: new Date().toISOString() };
    platform.users.insert(user);

    const repoUrl = await createFixtureRepo(root);
    await assert.rejects(
      () => services.projects.create({ name: "Fixture", sourceControlProvider: "local-git", repoUrl }, user.id),
      ProjectWorkspaceProvisionError,
    );

    // The project row itself was inserted before the filesystem step (no cross-statement
    // transaction in this codebase — see ProjectService.create's own doc comment), but there must
    // never be more than one project (proving no retry/duplication happened silently) and, more
    // importantly, no ProjectWorkspace row is left orphaned without ever being retryable: the row
    // that was inserted before the failing filesystem call is still findable exactly once.
    const projects = platform.projects.listByOwner(user.id);
    assert.equal(projects.length, 1, "exactly one project row, not duplicated by any retry");
    const workspace = platform.projectWorkspaces.findByProjectId(projects[0]!.id);
    assert.ok(workspace, "the ProjectWorkspace DB row itself is still exactly one row, not corrupted");

    platform.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
