import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm, readdir, writeFile as writeFileAsync, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient } from "./helpers/auth-client.js";
import { ProjectWorkspaceFsManager } from "../src/project-workspace/project-workspace-fs-manager.js";
import { ProjectContextService } from "../src/project-workspace/project-context-service.js";
import {
  PROJECT_CONTEXT_MANIFEST_FILENAME,
  MAX_PROJECT_CONTEXT_MANIFEST_BYTES,
  PROJECT_CONTEXT_MANIFEST_VERSION,
  defaultProjectContextManifest,
  validateProjectContextManifest,
  parseProjectContextManifestText,
  ProjectContextManifestInvalidError,
  ProjectContextManifestCorruptError,
  ProjectContextManifestTooLargeError,
} from "../src/project-workspace/project-context-manifest.js";

/**
 * Phase 3, Slice 7 note: every `replaceManifest`/PUT call below now runs through the
 * revision-checked optimistic-concurrency path (see project-context-service.ts) — a `revision`
 * field is required on every submitted body, and a caller must call `ensureManifest` (or otherwise
 * know the current revision) before its first `replaceManifest` call. Dedicated revision/conflict
 * coverage lives in tests/project-context-versioning.test.ts; this file keeps the original Slice 5
 * behavioral guarantees (idempotent creation, validation, atomicity, persistence, isolation) intact
 * under the new contract.
 */

/**
 * Coverage for Phase 3 — Project Workspace, Slice 5 (Project Context Manifest). Two layers:
 *  - HTTP-level tests (GET/PUT /projects/:projectId/context) via the same real-server harness style
 *    as tests/project-workspace.test.ts.
 *  - Direct ProjectContextService/manifest-schema unit tests (validation, atomicity, persistence,
 *    isolation) using isolated ProjectWorkspaceFsManager instances, no HTTP.
 *
 * Every test uses its own mkdtemp root — no shared global filesystem state between tests.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// ================================================================================================
// HTTP harness (same shape as tests/project-workspace.test.ts)
// ================================================================================================

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
  root: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `project-context-${label}-`));
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
    const s = app.listen(0, () => resolve(s));
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

// `updatedAt` is server-computed (see project-context-manifest.ts) and changes on every successful
// PUT, so it can never be part of a fixed "expected" object compared with deepEqual — stripped
// before comparison, and its presence/type asserted separately where it matters.
function withoutUpdatedAt(context: Record<string, unknown>): Record<string, unknown> {
  const { updatedAt: _updatedAt, ...rest } = context;
  return rest;
}

// `revision: 1` matches the default manifest's starting revision — a project fresh from
// setupHarness's project-creation flow always starts there, so this is a valid "first PUT" body.
const VALID_MANIFEST_UPDATE = {
  version: 1,
  revision: 1,
  project: { name: "Custom Name", description: "hand-authored description" },
  instructions: ["use TypeScript strict mode"],
  architecture: ["two-process: API + worker"],
  conventions: ["no default exports"],
  validation: { commands: ["run the fast test suite before the slow one"] },
  constraints: ["never touch src/workspace/*"],
};

// ================================================================================================
// 1-5, 16-19. Default manifest creation + GET, via real project creation
// ================================================================================================

test("Slice 5: a new GitHub project gets a default context manifest", async () => {
  const h = await setupHarness("github-create");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets", defaultBranch: "main" }));
  try {
    const client = await registerClient(h.baseUrl, "github-create");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Widgets", sourceControlProvider: "github", owner: "acme", repo: "widgets" }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const res = await client.fetch(`/projects/${project.id}/context`);
    assert.equal(res.status, 200);
    const { context } = await json<{ context: Record<string, unknown> }>(res);

    assert.equal(context.version, 1);
    assert.equal(context.revision, 1);
    assert.deepEqual(context.project, { name: "Widgets" });
    assert.deepEqual(context.instructions, []);
    assert.deepEqual(context.architecture, []);
    assert.deepEqual(context.conventions, []);
    assert.deepEqual(context.validation, { commands: [] });
    assert.deepEqual(context.constraints, []);
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("Slice 5: a new local-git project gets a default context manifest", async () => {
  const h = await setupHarness("local-git-create");
  try {
    const client = await registerClient(h.baseUrl, "local-git-create");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture Project", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const res = await client.fetch(`/projects/${project.id}/context`);
    assert.equal(res.status, 200);
    const { context } = await json<{ context: Record<string, unknown> }>(res);
    assert.equal(context.version, 1);
    assert.equal(context.revision, 1);
    assert.deepEqual(context.project, { name: "Fixture Project" });
  } finally {
    await teardown(h);
  }
});

test("Slice 5: the default manifest never contains secrets, credentials, or absolute filesystem paths", async () => {
  const h = await setupHarness("no-secrets");
  try {
    const client = await registerClient(h.baseUrl, "no-secrets");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const res = await client.fetch(`/projects/${project.id}/context`);
    const body = await res.text();
    for (const forbidden of ["token", "credential", "secret", "password", "CREDENTIAL_ENCRYPTION_KEY", h.root]) {
      assert.ok(!body.toLowerCase().includes(forbidden.toLowerCase()), `response must never contain "${forbidden}"`);
    }
    assert.ok(!body.includes("/tmp/") && !body.startsWith("/"), "response must never embed an absolute filesystem path");
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 20-25. PUT: valid write, normalization, invalid rejection, oversized rejection, determinism
// ================================================================================================

test("Slice 5: owner can PUT a valid context and the response is the normalized manifest", async () => {
  const h = await setupHarness("put-valid");
  try {
    const client = await registerClient(h.baseUrl, "put-valid");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const putRes = await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(VALID_MANIFEST_UPDATE) });
    assert.equal(putRes.status, 200);
    const { context } = await json<{ context: Record<string, unknown> }>(putRes);
    assert.equal(typeof context.updatedAt, "string", "a successful PUT must stamp a real server-computed updatedAt");
    assert.deepEqual(
      withoutUpdatedAt(context),
      { ...VALID_MANIFEST_UPDATE, revision: 2 },
      "a successful PUT persists the NEXT revision, not the client-submitted one verbatim",
    );

    const getRes = await client.fetch(`/projects/${project.id}/context`);
    const { context: reread } = await json<{ context: Record<string, unknown> }>(getRes);
    assert.equal(reread.updatedAt, context.updatedAt, "a plain GET must return the same persisted updatedAt, not a fresh one");
    assert.deepEqual(withoutUpdatedAt(reread), { ...VALID_MANIFEST_UPDATE, revision: 2 });
  } finally {
    await teardown(h);
  }
});

test("Slice 5: PUT normalizes a manifest that omits optional array fields to their empty defaults", async () => {
  const h = await setupHarness("put-normalize");
  try {
    const client = await registerClient(h.baseUrl, "put-normalize");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const minimal = { version: 1, revision: 1, project: { name: "Minimal" } };
    const putRes = await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(minimal) });
    assert.equal(putRes.status, 200);
    const { context } = await json<{ context: Record<string, unknown> }>(putRes);
    assert.deepEqual(withoutUpdatedAt(context), {
      version: 1,
      revision: 2,
      project: { name: "Minimal" },
      instructions: [],
      architecture: [],
      conventions: [],
      validation: { commands: [] },
      constraints: [],
    });
  } finally {
    await teardown(h);
  }
});

test("Slice 5: PUT with invalid content is rejected with 400 and does not touch the existing manifest", async () => {
  const h = await setupHarness("put-invalid");
  try {
    const client = await registerClient(h.baseUrl, "put-invalid");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);
    await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(VALID_MANIFEST_UPDATE) }); // establishes revision 2

    const badRes = await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify({ version: 2, revision: 2, project: { name: "x" } }) });
    assert.equal(badRes.status, 400);
    const badBody = await json<{ error: { code: string } }>(badRes);
    assert.equal(badBody.error.code, "INVALID_PROJECT_CONTEXT");

    const getRes = await client.fetch(`/projects/${project.id}/context`);
    const { context } = await json<{ context: Record<string, unknown> }>(getRes);
    assert.deepEqual(withoutUpdatedAt(context), { ...VALID_MANIFEST_UPDATE, revision: 2 }, "the previously-valid manifest must survive an invalid PUT untouched");
  } finally {
    await teardown(h);
  }
});

test("Slice 5: an oversized PUT is rejected and the existing manifest survives", async () => {
  const h = await setupHarness("put-oversized");
  try {
    const client = await registerClient(h.baseUrl, "put-oversized");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);
    await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(VALID_MANIFEST_UPDATE) }); // establishes revision 2

    const oversized = {
      version: 1,
      revision: 2, // must match current so the request reaches the size check, not a revision conflict
      project: { name: "Fixture" },
      instructions: ["x".repeat(MAX_PROJECT_CONTEXT_MANIFEST_BYTES)],
    };
    const putRes = await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(oversized) });
    assert.equal(putRes.status, 400);

    const getRes = await client.fetch(`/projects/${project.id}/context`);
    const { context } = await json<{ context: Record<string, unknown> }>(getRes);
    assert.deepEqual(withoutUpdatedAt(context), { ...VALID_MANIFEST_UPDATE, revision: 2 });
  } finally {
    await teardown(h);
  }
});

test("Slice 5: sequential valid PUTs are deterministic — same content, revision advances by exactly one each time", async () => {
  const h = await setupHarness("put-deterministic");
  try {
    const client = await registerClient(h.baseUrl, "put-deterministic");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const res1 = await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(VALID_MANIFEST_UPDATE) });
    const { context: c1 } = await json<{ context: Record<string, unknown> }>(res1);
    assert.equal(c1.revision, 2);

    const res2 = await client.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify({ ...VALID_MANIFEST_UPDATE, revision: 2 }) });
    const { context: c2 } = await json<{ context: Record<string, unknown> }>(res2);
    assert.equal(c2.revision, 3);

    const { revision: r1, updatedAt: u1, ...contentWithoutRevision1 } = c1;
    const { revision: r2, updatedAt: u2, ...contentWithoutRevision2 } = c2;
    void r1;
    void r2;
    void u1;
    void u2;
    assert.deepEqual(contentWithoutRevision1, contentWithoutRevision2, "identical content each time — only the revision counter differs");
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 26-28. Authorization
// ================================================================================================

test("Slice 5: a non-owner cannot GET or PUT another user's project context", async () => {
  const h = await setupHarness("auth-non-owner");
  try {
    const ownerClient = await registerClient(h.baseUrl, "auth-owner");
    const otherClient = await registerClient(h.baseUrl, "auth-other");
    const createRes = await ownerClient.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const getRes = await otherClient.fetch(`/projects/${project.id}/context`);
    assert.equal(getRes.status, 404);
    const putRes = await otherClient.fetch(`/projects/${project.id}/context`, { method: "PUT", body: JSON.stringify(VALID_MANIFEST_UPDATE) });
    assert.equal(putRes.status, 404);
  } finally {
    await teardown(h);
  }
});

test("Slice 5: an unknown project id returns the existing project-not-found behavior for both GET and PUT", async () => {
  const h = await setupHarness("auth-unknown");
  try {
    const client = await registerClient(h.baseUrl, "auth-unknown");
    const getRes = await client.fetch(`/projects/no-such-project/context`);
    assert.equal(getRes.status, 404);
    const putRes = await client.fetch(`/projects/no-such-project/context`, { method: "PUT", body: JSON.stringify(VALID_MANIFEST_UPDATE) });
    assert.equal(putRes.status, 404);
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// Direct ProjectContextService unit tests: manifest creation / idempotency / validation /
// atomicity / persistence / isolation
// ================================================================================================

async function newService(label: string): Promise<{ service: ProjectContextService; fs: ProjectWorkspaceFsManager; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `project-context-svc-${label}-`));
  const fs = new ProjectWorkspaceFsManager(root);
  const service = new ProjectContextService(fs);
  return { service, fs, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// --- 6/7/8. Existing/backfilled workspace, idempotency, user content survives ------------------

test("Slice 5: ensureManifest creates a default manifest for a ProjectWorkspace directory that has none", async () => {
  const { service, fs, cleanup } = await newService("ensure-missing");
  try {
    const id = randomUUID();
    fs.ensureWorkspace(id);
    const manifest = service.ensureManifest(id, "Backfilled Project");
    assert.equal(manifest.version, PROJECT_CONTEXT_MANIFEST_VERSION);
    assert.equal(manifest.revision, 1);
    assert.deepEqual(manifest.project, { name: "Backfilled Project" });
  } finally {
    await cleanup();
  }
});

test("Slice 5: repeated ensureManifest() never overwrites an existing manifest", async () => {
  const { service, cleanup } = await newService("ensure-idempotent");
  try {
    const id = randomUUID();
    const first = service.ensureManifest(id, "Original Name");
    const second = service.ensureManifest(id, "A Different Name Passed By Accident");
    const third = service.ensureManifest(id, "Yet Another Name");
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
    assert.equal(third.project.name, "Original Name", "the name from the FIRST call must stick — later calls never resync it");
    assert.equal(third.revision, 1, "repeated ensureManifest() calls must never bump the revision — only a real replaceManifest does");
  } finally {
    await cleanup();
  }
});

test("Slice 5: user-authored manifest content survives ensureManifest re-initialization", async () => {
  const { service, cleanup } = await newService("ensure-preserves-user-content");
  try {
    const id = randomUUID();
    service.ensureManifest(id, "Fixture"); // establishes revision 1
    const authored = service.replaceManifest(id, {
      version: 1,
      revision: 1,
      project: { name: "Fixture" },
      instructions: ["do not auto-format generated files"],
      constraints: ["never delete the migrations directory"],
    });
    assert.equal(authored.revision, 2);

    const afterEnsure = service.ensureManifest(id, "Fixture");
    assert.deepEqual(afterEnsure, authored);
  } finally {
    await cleanup();
  }
});

// --- 9-14. Validation --------------------------------------------------------------------------

test("Slice 5: a fully valid manifest is accepted", () => {
  const manifest = validateProjectContextManifest(VALID_MANIFEST_UPDATE);
  assert.deepEqual(manifest, VALID_MANIFEST_UPDATE);
});

test("Slice 5: invalid JSON text is rejected with a clear error", () => {
  assert.throws(() => parseProjectContextManifestText("{ not valid json"), ProjectContextManifestInvalidError);
});

test("Slice 5: a missing version field is rejected", () => {
  assert.throws(() => validateProjectContextManifest({ revision: 1, project: { name: "x" } }), ProjectContextManifestInvalidError);
});

test("Slice 5: an unsupported version number is rejected", () => {
  assert.throws(() => validateProjectContextManifest({ version: 2, revision: 1, project: { name: "x" } }), ProjectContextManifestInvalidError);
  assert.throws(() => validateProjectContextManifest({ version: 0, revision: 1, project: { name: "x" } }), ProjectContextManifestInvalidError);
});

test("Slice 5: a wrong field type is rejected", () => {
  assert.throws(() => validateProjectContextManifest({ version: 1, revision: 1, project: { name: "x" }, instructions: "not an array" }), ProjectContextManifestInvalidError);
  assert.throws(() => validateProjectContextManifest({ version: 1, revision: 1, project: { name: 123 } }), ProjectContextManifestInvalidError);
  assert.throws(() => validateProjectContextManifest({ version: 1, revision: 1, project: "not an object" }), ProjectContextManifestInvalidError);
});

test("Slice 5: an invalid validation.commands structure is rejected", () => {
  assert.throws(
    () => validateProjectContextManifest({ version: 1, revision: 1, project: { name: "x" }, validation: { commands: [123, "ok"] } }),
    ProjectContextManifestInvalidError,
  );
  assert.throws(
    () => validateProjectContextManifest({ version: 1, revision: 1, project: { name: "x" }, validation: { commands: "run tests" } }),
    ProjectContextManifestInvalidError,
  );
});

test("Slice 5: an oversized manifest is rejected by replaceManifest before writing", async () => {
  const { service, cleanup } = await newService("oversized-write");
  try {
    const id = randomUUID();
    service.ensureManifest(id, "x"); // establishes revision 1
    const oversized = { version: 1, revision: 1, project: { name: "x" }, instructions: ["y".repeat(MAX_PROJECT_CONTEXT_MANIFEST_BYTES)] };
    assert.throws(() => service.replaceManifest(id, oversized), ProjectContextManifestTooLargeError);
    assert.equal(service.readManifest(id).revision, 1, "nothing must have been written — revision stays at the default");
  } finally {
    await cleanup();
  }
});

// --- 18. Malformed on-disk manifest surfaced safely ---------------------------------------------

test("Slice 5: a corrupted on-disk manifest is surfaced as a clear, path-free error, not a crash", async () => {
  const { service, fs, root, cleanup } = await newService("corrupt-on-disk");
  try {
    const id = randomUUID();
    const dir = fs.ensureWorkspace(id);
    await writeFileAsync(join(dir, PROJECT_CONTEXT_MANIFEST_FILENAME), "{ this is not valid json", "utf-8");

    assert.throws(() => service.readManifest(id), (err: unknown) => {
      assert.ok(err instanceof ProjectContextManifestCorruptError);
      assert.ok(!(err as Error).message.includes(root), "error message must never leak the host filesystem root");
      return true;
    });
  } finally {
    await cleanup();
  }
});

// --- 29/30. Atomicity ----------------------------------------------------------------------------

test("Slice 5: a failed write leaves the previous valid manifest completely intact", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root — filesystem permission enforcement doesn't apply, test would be a false pass");
    return;
  }
  const { service, fs, cleanup } = await newService("atomic-failure");
  try {
    const id = randomUUID();
    const dir = fs.ensureWorkspace(id);
    service.ensureManifest(id, "x"); // establishes revision 1
    const original = service.replaceManifest(id, { version: 1, revision: 1, project: { name: "Before Failure" }, instructions: ["keep me"] });
    assert.equal(original.revision, 2);

    await chmod(dir, 0o555); // read-only: a new temp file (or lock file) can no longer be created inside it
    try {
      assert.throws(() => service.replaceManifest(id, { version: 1, revision: 2, project: { name: "After Failure" } }));
    } finally {
      await chmod(dir, 0o755); // restore before reading/cleanup
    }

    const stillThere = service.readManifest(id);
    assert.deepEqual(stillThere, original, "the original manifest must be completely unchanged after the failed write");
  } finally {
    await cleanup();
  }
});

test("Slice 5: no temporary manifest file remains after a successful replacement", async () => {
  const { service, fs, cleanup } = await newService("atomic-no-leftover-temp");
  try {
    const id = randomUUID();
    const dir = fs.ensureWorkspace(id);
    service.ensureManifest(id, "x"); // establishes revision 1
    service.replaceManifest(id, { version: 1, revision: 1, project: { name: "Fixture" } });
    const entries = await readdir(dir);
    assert.deepEqual(entries, [PROJECT_CONTEXT_MANIFEST_FILENAME], "only the manifest itself must remain — no .tmp- or .lock file");
  } finally {
    await cleanup();
  }
});

// --- 31-34. Persistence ----------------------------------------------------------------------

test("Slice 5: a manifest written by one ProjectContextService is readable by a freshly-constructed one over the same root", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-context-svc-persist-"));
  try {
    const id = randomUUID();
    const fsBefore = new ProjectWorkspaceFsManager(root);
    const serviceBefore = new ProjectContextService(fsBefore);
    serviceBefore.ensureManifest(id, "x"); // establishes revision 1
    const written = serviceBefore.replaceManifest(id, {
      version: 1,
      revision: 1,
      project: { name: "Persisted" },
      instructions: ["survive a restart"],
    });

    // Simulates a process restart: brand-new manager + service, no shared in-memory state.
    const fsAfter = new ProjectWorkspaceFsManager(root);
    const serviceAfter = new ProjectContextService(fsAfter);
    const reread = serviceAfter.readManifest(id);
    assert.deepEqual(reread, written);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 35-37. Isolation ------------------------------------------------------------------------

test("Slice 5: manifest operations for one ProjectWorkspace cannot read or affect another's", async () => {
  const { service, cleanup } = await newService("isolation-workspaces");
  try {
    const idA = randomUUID();
    const idB = randomUUID();
    service.ensureManifest(idA, "x");
    service.ensureManifest(idB, "x");
    service.replaceManifest(idA, { version: 1, revision: 1, project: { name: "Project A" }, instructions: ["A only"] });
    service.replaceManifest(idB, { version: 1, revision: 1, project: { name: "Project B" }, instructions: ["B only"] });

    assert.equal(service.readManifest(idA).project.name, "Project A");
    assert.equal(service.readManifest(idB).project.name, "Project B");
  } finally {
    await cleanup();
  }
});

test("Slice 5: the manifest is stored strictly under PROJECT_WORKSPACE_ROOT and never touches WORKSPACES_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-context-isolation-workspaces-root-"));
  try {
    const projectWorkspacesRoot = join(root, "project-workspaces");
    const workspacesRoot = join(root, "workspaces");
    const fs = new ProjectWorkspaceFsManager(projectWorkspacesRoot);
    const service = new ProjectContextService(fs);
    const id = randomUUID();
    service.ensureManifest(id, "x"); // establishes revision 1
    service.replaceManifest(id, { version: 1, revision: 1, project: { name: "Fixture" } });

    const resolvedManifestPath = fs.resolveFilePath(id, PROJECT_CONTEXT_MANIFEST_FILENAME);
    assert.ok(resolvedManifestPath.startsWith(projectWorkspacesRoot));
    assert.ok(!resolvedManifestPath.startsWith(workspacesRoot));

    // WORKSPACES_ROOT need not even exist — nothing about writing a manifest ever touches it.
    let workspacesRootExists = true;
    try {
      await readdir(workspacesRoot);
    } catch {
      workspacesRootExists = false;
    }
    assert.equal(workspacesRootExists, false, "the task-execution WORKSPACES_ROOT must never be created as a side effect of manifest operations");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
