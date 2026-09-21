import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile as writeFileAsync, chmod } from "node:fs/promises";
import { openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient } from "./helpers/auth-client.js";
import { ProjectWorkspaceFsManager, ProjectWorkspaceLockTimeoutError } from "../src/project-workspace/project-workspace-fs-manager.js";
import { ProjectContextService } from "../src/project-workspace/project-context-service.js";
import {
  PROJECT_CONTEXT_MANIFEST_FILENAME,
  PROJECT_CONTEXT_MANIFEST_INITIAL_REVISION,
  defaultProjectContextManifest,
  ProjectContextConflictError,
} from "../src/project-workspace/project-context-manifest.js";
import { renderProjectContextSection } from "../src/orchestrator/project-context-section.js";
import type { ProjectContextManifest } from "../src/project-workspace/project-context-manifest.js";

/**
 * Coverage for Phase 3, Slice 7 — Project Context Manifest revision/versioning and optimistic
 * concurrency control (see project-context-manifest.ts's "VERSION vs. REVISION" doc comment and
 * ProjectContextService.replaceManifest's own doc comment for the compare-and-swap design).
 *
 * Every test uses its own mkdtemp root — no shared global filesystem state between tests.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// ================================================================================================
// HTTP harness (same shape as tests/project-context.test.ts)
// ================================================================================================

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
  root: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `project-context-versioning-${label}-`));
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

async function createProject(h: Harness, label: string): Promise<{ projectId: string; client: Awaited<ReturnType<typeof registerClient>> }> {
  const client = await registerClient(h.baseUrl, label);
  const res = await client.fetch("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
  });
  const { project } = await json<{ project: { id: string } }>(res);
  return { projectId: project.id, client };
}

async function newService(label: string): Promise<{ service: ProjectContextService; fs: ProjectWorkspaceFsManager; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `project-context-versioning-svc-${label}-`));
  const fs = new ProjectWorkspaceFsManager(root);
  const service = new ProjectContextService(fs);
  return { service, fs, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ================================================================================================
// 1-4. Revision basics: initial value, GET exposure, legacy-manifest compatibility, GET is read-only
// ================================================================================================

test("Slice 7: a newly created manifest starts at revision 1", async () => {
  const h = await setupHarness("initial-revision");
  try {
    const { projectId, client } = await createProject(h, "initial-revision");
    const res = await client.fetch(`/projects/${projectId}/context`);
    const { context } = await json<{ context: { revision: number } }>(res);
    assert.equal(context.revision, PROJECT_CONTEXT_MANIFEST_INITIAL_REVISION);
    assert.equal(context.revision, 1);
  } finally {
    await teardown(h);
  }
});

test("Slice 7: GET exposes the current revision alongside the content", async () => {
  const h = await setupHarness("get-exposes-revision");
  try {
    const { projectId, client } = await createProject(h, "get-exposes-revision");
    const res = await client.fetch(`/projects/${projectId}/context`);
    const { context } = await json<{ context: Record<string, unknown> }>(res);
    assert.ok(typeof context.revision === "number");
  } finally {
    await teardown(h);
  }
});

test("Slice 7: a manifest predating Slice 7 (no revision field on disk) is read as revision 1, without being rewritten just by being read", async () => {
  const { service, fs, cleanup } = await newService("legacy-no-revision");
  try {
    const id = randomUUID();
    const dir = fs.ensureWorkspace(id);
    // Simulates a manifest written by Slice 5/6 code, before `revision` existed at all.
    const legacy = { version: 1, project: { name: "Legacy Project" }, instructions: [], architecture: [], conventions: [], validation: { commands: [] }, constraints: [] };
    await writeFileAsync(join(dir, PROJECT_CONTEXT_MANIFEST_FILENAME), JSON.stringify(legacy), "utf-8");

    const read = service.readManifest(id);
    assert.equal(read.revision, 1);

    // Reading must never rewrite the file — still exactly the legacy bytes, no `revision` key added.
    const rawAfterRead = await import("node:fs/promises").then((m) => m.readFile(join(dir, PROJECT_CONTEXT_MANIFEST_FILENAME), "utf-8"));
    assert.ok(!JSON.parse(rawAfterRead).revision, "GET/read must never silently rewrite an old manifest just because it was read");
  } finally {
    await cleanup();
  }
});

test("Slice 7: GET never changes the revision", async () => {
  const h = await setupHarness("get-is-read-only");
  try {
    const { projectId, client } = await createProject(h, "get-is-read-only");
    await client.fetch(`/projects/${projectId}/context`);
    await client.fetch(`/projects/${projectId}/context`);
    const res = await client.fetch(`/projects/${projectId}/context`);
    const { context } = await json<{ context: { revision: number } }>(res);
    assert.equal(context.revision, 1, "three GETs in a row must never have bumped the revision");
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 5-7. Successful/failed updates and revision progression
// ================================================================================================

test("Slice 7: a successful update increments the revision by exactly one", async () => {
  const h = await setupHarness("increment-once");
  try {
    const { projectId, client } = await createProject(h, "increment-once");
    const res = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["first edit"] }),
    });
    assert.equal(res.status, 200);
    const { context } = await json<{ context: { revision: number } }>(res);
    assert.equal(context.revision, 2);
  } finally {
    await teardown(h);
  }
});

test("Slice 7: two sequential successful updates produce revisions 1 -> 2 -> 3, never 1 -> 3", async () => {
  const h = await setupHarness("sequential-1-2-3");
  try {
    const { projectId, client } = await createProject(h, "sequential-1-2-3");

    const first = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["edit one"] }),
    });
    const { context: c1 } = await json<{ context: { revision: number } }>(first);
    assert.equal(c1.revision, 2);

    const second = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 2, instructions: ["edit two"] }),
    });
    const { context: c2 } = await json<{ context: { revision: number } }>(second);
    assert.equal(c2.revision, 3);
  } finally {
    await teardown(h);
  }
});

test("Slice 7: an invalid PUT body never changes the revision", async () => {
  const h = await setupHarness("invalid-no-revision-bump");
  try {
    const { projectId, client } = await createProject(h, "invalid-no-revision-bump");
    const badRes = await client.fetch(`/projects/${projectId}/context`, { method: "PUT", body: JSON.stringify({ version: 1, revision: 1 }) }); // missing required project.name
    assert.equal(badRes.status, 400);

    const getRes = await client.fetch(`/projects/${projectId}/context`);
    const { context } = await json<{ context: { revision: number } }>(getRes);
    assert.equal(context.revision, 1, "an invalid submission must never advance the revision");
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 8-10. Conflict (409) behavior
// ================================================================================================

test("Slice 7: a stale revision is rejected with 409, and the conflict response exposes the current revision", async () => {
  const h = await setupHarness("stale-409");
  try {
    const { projectId, client } = await createProject(h, "stale-409");
    // Advance to revision 2 first.
    await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["real update"] }),
    });

    // A second client still believes revision 1 is current.
    const staleRes = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["stale, conflicting update"] }),
    });
    assert.equal(staleRes.status, 409);
    const body = await json<{ error: { code: string; message: string; details?: { currentRevision?: number } } }>(staleRes);
    assert.equal(body.error.code, "PROJECT_CONTEXT_CONFLICT");
    assert.equal(body.error.details?.currentRevision, 2, "the conflict response must expose the actual current revision so the client can recover");
  } finally {
    await teardown(h);
  }
});

test("Slice 7: a stale update never overwrites the current content, even partially", async () => {
  const h = await setupHarness("stale-no-overwrite");
  try {
    const { projectId, client } = await createProject(h, "stale-no-overwrite");
    const winning = { ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["the real, winning update"] };
    await client.fetch(`/projects/${projectId}/context`, { method: "PUT", body: JSON.stringify(winning) });

    const staleRes = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["a stale update that must never land"] }),
    });
    assert.equal(staleRes.status, 409);

    const getRes = await client.fetch(`/projects/${projectId}/context`);
    const { context } = await json<{ context: Record<string, unknown> }>(getRes);
    const { updatedAt: _updatedAt, ...contextWithoutUpdatedAt } = context;
    assert.deepEqual(contextWithoutUpdatedAt, { ...winning, revision: 2 });
  } finally {
    await teardown(h);
  }
});

test("Slice 7 follow-up: a successful Project Context save bumps the owning ProjectWorkspace's own updatedAt, to the exact same timestamp", async () => {
  const h = await setupHarness("touches-workspace");
  try {
    const { projectId, client } = await createProject(h, "touches-workspace");
    const workspaceBefore = h.platform.projectWorkspaces.findByProjectId(projectId);
    assert.ok(workspaceBefore);
    const createdAt = workspaceBefore!.updatedAt;

    const putRes = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["a real edit"] }),
    });
    assert.equal(putRes.status, 200);
    const { context } = await json<{ context: { updatedAt: string } }>(putRes);

    const workspaceAfter = h.platform.projectWorkspaces.findByProjectId(projectId);
    assert.equal(
      workspaceAfter!.updatedAt,
      context.updatedAt,
      "the ProjectWorkspace's updatedAt must match the manifest's own updatedAt exactly",
    );
    assert.notEqual(workspaceAfter!.updatedAt, createdAt, "a real save must actually move the timestamp forward");
  } finally {
    await teardown(h);
  }
});

test("Slice 7 follow-up: a REJECTED Project Context save (stale revision) never touches the ProjectWorkspace's updatedAt", async () => {
  const h = await setupHarness("rejected-save-no-touch");
  try {
    const { projectId, client } = await createProject(h, "rejected-save-no-touch");
    await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["first"] }),
    });
    const workspaceAfterFirstSave = h.platform.projectWorkspaces.findByProjectId(projectId);
    const updatedAtAfterFirstSave = workspaceAfterFirstSave!.updatedAt;

    const staleRes = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["stale, must be rejected"] }),
    });
    assert.equal(staleRes.status, 409);

    const workspaceAfterRejection = h.platform.projectWorkspaces.findByProjectId(projectId);
    assert.equal(
      workspaceAfterRejection!.updatedAt,
      updatedAtAfterFirstSave,
      "a rejected (409) save must never touch the ProjectWorkspace's updatedAt",
    );
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 11-13. Owner-update success, non-owner, unknown project
// ================================================================================================

test("Slice 7: the owner can update with the correct current revision", async () => {
  const h = await setupHarness("owner-correct-revision");
  try {
    const { projectId, client } = await createProject(h, "owner-correct-revision");
    const res = await client.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1 }),
    });
    assert.equal(res.status, 200);
  } finally {
    await teardown(h);
  }
});

test("Slice 7: a non-owner remains unauthorized (existing 404 semantics) even with the correct revision", async () => {
  const h = await setupHarness("non-owner-revision");
  try {
    const { projectId, client: owner } = await createProject(h, "non-owner-revision-owner");
    const other = await registerClient(h.baseUrl, "non-owner-revision-other");

    const getRes = await other.fetch(`/projects/${projectId}/context`);
    assert.equal(getRes.status, 404);

    const putRes = await other.fetch(`/projects/${projectId}/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1 }),
    });
    assert.equal(putRes.status, 404);
    void owner;
  } finally {
    await teardown(h);
  }
});

test("Slice 7: an unknown project id returns 404 regardless of the submitted revision", async () => {
  const h = await setupHarness("unknown-project-revision");
  try {
    const client = await registerClient(h.baseUrl, "unknown-project-revision");
    const res = await client.fetch(`/projects/no-such-project/context`, {
      method: "PUT",
      body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: 1 }),
    });
    assert.equal(res.status, 404);
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 14. Concurrency: the race is genuinely closed, not just "usually fine"
// ================================================================================================

test("Slice 7: deterministic proof — a caller's cached (now-stale) revision is rejected even though it was valid when read, closing the read-then-write race", async () => {
  // The exact scenario from the spec: Client A and Client B both read revision 1. Client A submits
  // first and wins (revision 1 -> 2). Client B then submits using its own (no longer current) read
  // of revision 1 — this must be rejected, not silently applied on top of A's change. No sleeps or
  // real thread races needed: this deterministically proves the CAS re-reads the ACTUAL current
  // revision at write time rather than trusting a caller-supplied "I already checked" claim.
  const { service, cleanup } = await newService("cas-proof");
  try {
    const id = randomUUID();
    const { updatedAt: _readByBothUpdatedAt, ...readByBoth } = service.ensureManifest(id, "Fixture"); // both A and B "read" this: revision 1
    assert.equal(readByBoth.revision, 1);

    const afterA = service.replaceManifest(id, { ...readByBoth, revision: 1, instructions: ["A's change"] });
    assert.equal(afterA.revision, 2);

    assert.throws(
      () => service.replaceManifest(id, { ...readByBoth, revision: 1, instructions: ["B's change, based on a now-stale read"] }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectContextConflictError);
        assert.equal(err.currentRevision, 2);
        return true;
      },
    );

    const final = service.readManifest(id);
    assert.equal(final.revision, 2);
    assert.deepEqual(final.instructions, ["A's change"], "B's rejected update must have zero effect on the stored content");
  } finally {
    await cleanup();
  }
});

test("Slice 7: real concurrent HTTP requests against the same revision — exactly one succeeds, the other gets 409, nothing is silently lost", async () => {
  const h = await setupHarness("concurrent-http");
  try {
    const { projectId, client } = await createProject(h, "concurrent-http");
    const bodyA = { ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["from request A"] };
    const bodyB = { ...defaultProjectContextManifest("Fixture"), revision: 1, instructions: ["from request B"] };

    const [resA, resB] = await Promise.all([
      client.fetch(`/projects/${projectId}/context`, { method: "PUT", body: JSON.stringify(bodyA) }),
      client.fetch(`/projects/${projectId}/context`, { method: "PUT", body: JSON.stringify(bodyB) }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one of the two concurrent requests must succeed and the other must conflict");

    const getRes = await client.fetch(`/projects/${projectId}/context`);
    const { context } = await json<{ context: { revision: number; instructions: string[] } }>(getRes);
    assert.equal(context.revision, 2, "exactly one successful update must have happened — never zero, never two");
    assert.ok(
      context.instructions[0] === "from request A" || context.instructions[0] === "from request B",
      "the winning request's full content must be intact, not merged or corrupted",
    );
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 15-17. Atomicity, failed write, corrupt manifest
// ================================================================================================

test("Slice 7: withExclusiveLock provides real mutual exclusion — a held lock deterministically blocks a second acquisition until it times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-context-versioning-lock-"));
  try {
    const fs = new ProjectWorkspaceFsManager(root);
    const id = randomUUID();
    const dir = fs.ensureWorkspace(id);
    const lockName = ".simulated-holder.lock";
    // Simulates another process/request still inside its own critical section: pre-create the
    // exact lock file withExclusiveLock itself would create, using the same O_CREAT|O_EXCL
    // primitive — nothing ever releases it during this test.
    const fd = openSync(join(dir, lockName), "wx");
    try {
      assert.throws(
        () => fs.withExclusiveLock(id, lockName, () => "must never run", { maxAttempts: 3, retryDelayMs: 5 }),
        ProjectWorkspaceLockTimeoutError,
      );
    } finally {
      closeSync(fd);
      rmSync(join(dir, lockName), { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Slice 7: a failed write (permission denied) never advances the revision", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root — filesystem permission enforcement doesn't apply, test would be a false pass");
    return;
  }
  const { service, fs, cleanup } = await newService("failed-write-no-revision-bump");
  try {
    const id = randomUUID();
    const dir = fs.ensureWorkspace(id);
    const { updatedAt: _originalUpdatedAt, ...original } = service.ensureManifest(id, "Fixture");
    assert.equal(original.revision, 1);

    await chmod(dir, 0o555);
    try {
      assert.throws(() => service.replaceManifest(id, { ...original, revision: 1, instructions: ["should never land"] }));
    } finally {
      await chmod(dir, 0o755);
    }

    const stillThere = service.readManifest(id);
    assert.equal(stillThere.revision, 1, "a failed write must never have advanced the revision");
    assert.deepEqual(stillThere.instructions, []);
  } finally {
    await cleanup();
  }
});

test("Slice 7: an explicit but invalid revision value (zero, negative, non-integer) is rejected as invalid content", async () => {
  const h = await setupHarness("invalid-revision-value");
  try {
    const { projectId, client } = await createProject(h, "invalid-revision-value");
    for (const badRevision of [0, -1, 1.5, "3", null]) {
      const res = await client.fetch(`/projects/${projectId}/context`, {
        method: "PUT",
        body: JSON.stringify({ ...defaultProjectContextManifest("Fixture"), revision: badRevision }),
      });
      assert.equal(res.status, 400, `revision ${JSON.stringify(badRevision)} must be rejected as invalid, not silently coerced`);
    }
  } finally {
    await teardown(h);
  }
});

// ================================================================================================
// 18. AI context does not leak revision metadata
// ================================================================================================

test("Slice 7: the AI-facing rendered project context never includes the revision counter", () => {
  const manifest: ProjectContextManifest = {
    ...defaultProjectContextManifest("Fixture"),
    updatedAt: null,
    revision: 7,
    instructions: ["a real instruction the AI should see"],
  };
  const rendered = renderProjectContextSection(manifest);
  assert.ok(rendered.includes("a real instruction the AI should see"));
  assert.ok(!/revision/i.test(rendered), "the rendered AI context must never mention 'revision' — it is platform storage bookkeeping, not project knowledge");
  assert.ok(!rendered.includes("\n7\n") && !rendered.includes(": 7"), "the bare revision number must not leak into the rendered text either");
});
