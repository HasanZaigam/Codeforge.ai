import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient, type AuthedClient } from "./helpers/auth-client.js";
import { ProjectWorkspaceRepository } from "../src/persistence/repositories/project-workspace-repository.js";
import { ProjectWorkspaceMissingError, NotFoundError } from "../src/application/errors.js";
import { MIGRATION_FILES } from "../src/persistence/db.js";
import type { Project, ProjectWorkspace } from "../src/domain/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "src", "persistence", "migrations");

// A real key must be present for any GitHub credential-store code path to run at all (see
// auth/credential-encryption.ts) — test-only, never a real secret.
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/**
 * Coverage for Phase 3 — Project Workspace, Slice 1 (see domain/types.ts ProjectWorkspace's own
 * doc comment, migrations/011_project_workspace.sql, ProjectWorkspaceRepository,
 * ProjectService.create/getWorkspace). HTTP-layer coverage of
 * `GET /projects/:projectId/workspace` (owner / non-owner / unknown project) lives in
 * tests/api.test.ts alongside the rest of that file's "over real HTTP" project/task coverage —
 * this file covers the repository, the service, GitHub- vs local-git-provider creation, and the
 * migration backfill.
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `project-workspace-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
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
  return { platform, baseUrl, server, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// --- GitHub API stub, same minimal pattern as tests/github-integration.test.ts -----------------

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

// --- 1. GitHub-provider project creation creates exactly one ProjectWorkspace ------------------

test("POST /projects (github): creates exactly one ProjectWorkspace", async () => {
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
    assert.ok(workspace, "expected exactly one ProjectWorkspace for the new github project");
    assert.equal(workspace!.projectId, project.id);
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

// --- 2. Local-git project creation creates exactly one ProjectWorkspace ------------------------

test("POST /projects (local-git): creates exactly one ProjectWorkspace", async () => {
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
    assert.ok(workspace, "expected exactly one ProjectWorkspace for the new local-git project");
    assert.equal(workspace!.projectId, project.id);
  } finally {
    await teardown(h);
  }
});

// --- 3/4/5. Repository-level behavior ------------------------------------------------------------

test("ProjectWorkspaceRepository.findByProjectId: returns the correct workspace, returns null for an unknown project, and two projects each get their own distinct workspace", async () => {
  const h = await setupHarness("repo-level");
  try {
    const repo = h.platform.projectWorkspaces;

    // 4. Unknown projectId -> null, not a throw.
    assert.equal(repo.findByProjectId("no-such-project"), null);

    // Real project rows are required first — project_workspaces.project_id REFERENCES
    // projects(id) and openDatabase (see platform.ts) enables foreign_keys enforcement.
    const now = new Date().toISOString();
    const user = { id: randomUUID(), tenantId: "default", email: `repo-level-${randomUUID()}@example.com`, name: "Tester", passwordHash: "", createdAt: now };
    h.platform.users.insert(user);
    const makeProject = (name: string): Project => ({
      id: randomUUID(),
      tenantId: "default",
      ownerId: user.id,
      name,
      repoUrl: h.repoPath,
      defaultBranch: "main",
      codingEngine: "fixture",
      sourceControlProvider: "local-git",
      owner: null,
      repo: null,
      commands: null,
      createdAt: now,
      updatedAt: now,
    });
    const projectA = makeProject("Project A");
    const projectB = makeProject("Project B");
    h.platform.projects.insert(projectA);
    h.platform.projects.insert(projectB);

    // 5. Two distinct projects each get their own distinct workspace.
    const wsA: ProjectWorkspace = { id: randomUUID(), projectId: projectA.id, createdAt: now, updatedAt: now };
    const wsB: ProjectWorkspace = { id: randomUUID(), projectId: projectB.id, createdAt: now, updatedAt: now };
    repo.insert(wsA);
    repo.insert(wsB);

    // 3. findByProjectId returns the correct workspace.
    const foundA = repo.findByProjectId(projectA.id);
    const foundB = repo.findByProjectId(projectB.id);
    assert.ok(foundA);
    assert.ok(foundB);
    assert.equal(foundA!.id, wsA.id);
    assert.equal(foundB!.id, wsB.id);
    assert.notEqual(foundA!.id, foundB!.id, "each project must get its own distinct workspace, not the same row twice");
  } finally {
    await teardown(h);
  }
});

// --- 6/7. ProjectService.getWorkspace ------------------------------------------------------------

test("ProjectService.getWorkspace: succeeds for the owner, throws NotFoundError for a non-owner", async () => {
  const h = await setupHarness("service-level");
  try {
    const ownerClient = await registerClient(h.baseUrl, "service-level-owner");
    const otherClient = await registerClient(h.baseUrl, "service-level-other");

    const createRes = await ownerClient.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const { buildApplicationServices } = await import("../src/application/index.js");
    const services = buildApplicationServices(h.platform);

    // 6. Succeeds for the owner.
    const workspace = services.projects.getWorkspace(project.id, ownerClient.userId);
    assert.equal(workspace.projectId, project.id);

    // 7. Throws the 404-mapped error for a non-owner.
    assert.throws(() => services.projects.getWorkspace(project.id, otherClient.userId), NotFoundError);

    // Unknown project also throws the same 404-mapped error.
    assert.throws(() => services.projects.getWorkspace("no-such-project", ownerClient.userId), NotFoundError);
  } finally {
    await teardown(h);
  }
});

test("ProjectService.getWorkspace: a project whose ProjectWorkspace row is missing throws ProjectWorkspaceMissingError, not a silent auto-create", async () => {
  const h = await setupHarness("service-missing-workspace");
  try {
    const ownerClient = await registerClient(h.baseUrl, "service-missing-workspace-owner");
    const createRes = await ownerClient.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    // Simulate the "eager creation didn't happen" edge case by deleting the row this codebase's
    // normal creation flow always inserts.
    h.platform.db.prepare("DELETE FROM project_workspaces WHERE project_id = ?").run(project.id);

    const { buildApplicationServices } = await import("../src/application/index.js");
    const services = buildApplicationServices(h.platform);

    assert.throws(() => services.projects.getWorkspace(project.id, ownerClient.userId), ProjectWorkspaceMissingError);
    // Re-reading must still show no row — getWorkspace must never silently auto-create one.
    assert.equal(h.platform.projectWorkspaces.findByProjectId(project.id), null);
  } finally {
    await teardown(h);
  }
});

// --- 11/12. Migration backfill and its idempotency ------------------------------------------------

/** Applies exactly MIGRATION_FILES[0..count) to `db`, mirroring runMigrations but stoppable mid-list. */
async function applyMigrationsUpTo(db: DatabaseSync, count: number): Promise<void> {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  for (const file of MIGRATION_FILES.slice(0, count)) {
    const sql = await readFile(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }
}

test("migration 011 backfill: a project inserted before 011 shipped gets exactly one ProjectWorkspace row once 011 runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-backfill-"));
  const db = new DatabaseSync(join(root, "backfill.sqlite"));
  try {
    // Migrations 001-010 only — simulates a DB that predates migration 011.
    const migration011Index = MIGRATION_FILES.indexOf("011_project_workspace.sql");
    assert.ok(migration011Index > 0, "011_project_workspace.sql must be registered in MIGRATION_FILES");
    await applyMigrationsUpTo(db, migration011Index);

    // A project row inserted directly at the DB level, bypassing ProjectService entirely —
    // simulating a project that already existed before 011 shipped. owner_id references users(id)
    // (see migrations/003_auth.sql) and foreign_keys enforcement is on by default here, so a real
    // user row is needed first.
    const now = new Date().toISOString();
    const ownerId = randomUUID();
    db.prepare("INSERT INTO users (id, tenant_id, email, name, created_at) VALUES (?, 'default', ?, 'Tester', ?)").run(
      ownerId,
      `${ownerId}@example.com`,
      now,
    );
    const projectId = randomUUID();
    db.prepare(
      `INSERT INTO projects (id, tenant_id, owner_id, name, repo_url, default_branch, coding_engine, source_control_provider, created_at, updated_at)
       VALUES (?, 'default', ?, 'Pre-011 project', '/tmp/fixture.git', 'main', 'fixture', 'local-git', ?, ?)`,
    ).run(projectId, ownerId, now, now);

    // Sanity: project_workspaces doesn't exist at all yet — this DB has only migrations 001-010.
    assert.throws(() => db.prepare("SELECT COUNT(*) FROM project_workspaces").get(), /no such table/);

    // Now run migration 011 itself.
    const migration011Sql = await readFile(join(migrationsDir, "011_project_workspace.sql"), "utf-8");
    db.exec(migration011Sql);

    const rows = db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").all(projectId) as unknown as {
      id: string;
      project_id: string;
      created_at: string;
      updated_at: string;
    }[];
    assert.equal(rows.length, 1, "exactly one ProjectWorkspace row must be backfilled for the pre-existing project");
    assert.equal(rows[0]!.project_id, projectId);
    assert.equal(rows[0]!.created_at, now, "backfilled created_at is copied from the owning project's own created_at");

    // 12. Idempotency: re-apply migration 011's own SQL text a second time against the same DB
    // state. The guarded INSERT...SELECT...WHERE NOT EXISTS must insert nothing further.
    db.exec(migration011Sql);
    const rowsAfterRerun = db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").all(projectId) as unknown as unknown[];
    assert.equal(rowsAfterRerun.length, 1, "re-running migration 011's SQL must not create a duplicate ProjectWorkspace row");
  } finally {
    db.close();
  }
});

// Sanity check that ProjectWorkspaceRepository itself works against a plain DatabaseSync, without
// going through buildPlatform — closest-sibling smoke test to project-repository's own style.
test("ProjectWorkspaceRepository: insert + findByProjectId round-trip against a fresh migrated DB", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workspace-roundtrip-"));
  const db = new DatabaseSync(join(root, "roundtrip.sqlite"));
  try {
    await applyMigrationsUpTo(db, MIGRATION_FILES.length);

    // A real project row is required first — see the FK note on the repo-level test above.
    const now = new Date().toISOString();
    const ownerId = randomUUID();
    db.prepare("INSERT INTO users (id, tenant_id, email, name, created_at) VALUES (?, 'default', ?, 'Tester', ?)").run(
      ownerId,
      `${ownerId}@example.com`,
      now,
    );
    const projectId = randomUUID();
    db.prepare(
      `INSERT INTO projects (id, tenant_id, owner_id, name, repo_url, default_branch, coding_engine, source_control_provider, created_at, updated_at)
       VALUES (?, 'default', ?, 'Roundtrip project', '/tmp/fixture.git', 'main', 'fixture', 'local-git', ?, ?)`,
    ).run(projectId, ownerId, now, now);

    const repo = new ProjectWorkspaceRepository(db);
    const ws: ProjectWorkspace = { id: randomUUID(), projectId, createdAt: now, updatedAt: now };
    repo.insert(ws);
    const found = repo.findByProjectId(ws.projectId);
    assert.deepEqual(found, ws);
  } finally {
    db.close();
  }
});
