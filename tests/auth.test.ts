import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient, type AuthedClient } from "./helpers/auth-client.js";

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `auth-test-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
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
  return { platform, baseUrl: `http://127.0.0.1:${address.port}`, server, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProject(client: AuthedClient, repoPath: string): Promise<{ id: string }> {
  const res = await client.fetch("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Private Project", sourceControlProvider: "local-git", repoUrl: repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
  });
  const { project } = await json<{ project: { id: string } }>(res);
  return project;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test("register: creates an account, sets a session cookie, and never returns the password hash", async () => {
  const h = await setupHarness("register");
  try {
    const res = await fetch(`${h.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "a very good passphrase", name: "New Dev" }),
    });
    assert.equal(res.status, 201);
    assert.ok(res.headers.get("set-cookie")?.includes("session="));
    const body = await json<{ user: Record<string, unknown> }>(res);
    assert.equal(body.user.email, "new@example.com");
    assert.equal(body.user.name, "New Dev");
    assert.equal(body.user.passwordHash, undefined, "the DTO must never include a password hash");
    assert.equal((body.user as { password?: unknown }).password, undefined);
  } finally {
    await teardown(h);
  }
});

test("register: rejects a duplicate email with 409, and a weak password with 400", async () => {
  const h = await setupHarness("register-dup");
  try {
    const first = await fetch(`${h.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@example.com", password: "a very good passphrase", name: "First" }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${h.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@example.com", password: "another good passphrase", name: "Second" }),
    });
    assert.equal(second.status, 409);
    const body = await json<{ error: { code: string } }>(second);
    assert.equal(body.error.code, "EMAIL_ALREADY_REGISTERED");

    const weak = await fetch(`${h.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "weak@example.com", password: "short", name: "Weak" }),
    });
    assert.equal(weak.status, 400);
  } finally {
    await teardown(h);
  }
});

test("login: succeeds with correct credentials", async () => {
  const h = await setupHarness("login-ok");
  try {
    await fetch(`${h.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "login@example.com", password: "a very good passphrase", name: "Logger Inner" }),
    });

    const res = await fetch(`${h.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "login@example.com", password: "a very good passphrase" }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("set-cookie")?.includes("session="));
    const body = await json<{ user: { email: string } }>(res);
    assert.equal(body.user.email, "login@example.com");
  } finally {
    await teardown(h);
  }
});

test("login: wrong password and nonexistent email both return the same generic 401, not distinguishable", async () => {
  const h = await setupHarness("login-fail");
  try {
    await fetch(`${h.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "real@example.com", password: "a very good passphrase", name: "Real" }),
    });

    const wrongPassword = await fetch(`${h.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "real@example.com", password: "totally wrong password" }),
    });
    const nonexistent = await fetch(`${h.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "totally wrong password" }),
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(nonexistent.status, 401);
    const [a, b] = await Promise.all([json<{ error: { code: string; message: string } }>(wrongPassword), json<{ error: { code: string; message: string } }>(nonexistent)]);
    assert.equal(a.error.code, b.error.code);
    assert.equal(a.error.message, b.error.message, "must not hint at which case occurred");
    assert.equal(wrongPassword.headers.get("set-cookie"), null, "no session cookie on a failed login");
  } finally {
    await teardown(h);
  }
});

test("GET /auth/me: returns the current user when authenticated, 401 when not", async () => {
  const h = await setupHarness("me");
  try {
    const client = await registerClient(h.baseUrl, "me");
    const me = await client.fetch("/auth/me");
    assert.equal(me.status, 200);
    const body = await json<{ user: { email: string } }>(me);
    assert.equal(body.user.email, client.email);

    const anonymous = await fetch(`${h.baseUrl}/auth/me`);
    assert.equal(anonymous.status, 401);
  } finally {
    await teardown(h);
  }
});

test("logout: revokes the session server-side — the same cookie no longer authenticates", async () => {
  const h = await setupHarness("logout");
  try {
    const client = await registerClient(h.baseUrl, "logout");
    assert.equal((await client.fetch("/auth/me")).status, 200);

    const logoutRes = await client.fetch("/auth/logout", { method: "POST" });
    assert.equal(logoutRes.status, 204);

    // The exact same cookie, reused, must now be rejected — logout is a server-side revocation,
    // not just something the client is expected to forget.
    const afterLogout = await client.fetch("/auth/me");
    assert.equal(afterLogout.status, 401);
    assert.equal((await client.fetch("/projects")).status, 401);
  } finally {
    await teardown(h);
  }
});

test("an invalid/unknown session cookie is treated as unauthenticated, not an error", async () => {
  const h = await setupHarness("bad-cookie");
  try {
    const res = await fetch(`${h.baseUrl}/auth/me`, { headers: { cookie: "session=not-a-real-token" } });
    assert.equal(res.status, 401);
  } finally {
    await teardown(h);
  }
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("a user can access their own project and its tasks", async () => {
  const h = await setupHarness("own-access");
  try {
    const client = await registerClient(h.baseUrl, "owner");
    const project = await createProject(client, h.repoPath);

    assert.equal((await client.fetch(`/projects/${project.id}`)).status, 200);
    const taskRes = await client.fetch(`/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "T", description: "D" }),
    });
    assert.equal(taskRes.status, 201);
  } finally {
    await teardown(h);
  }
});

test("a user cannot access another user's project (404, not 403 — existence isn't confirmed)", async () => {
  const h = await setupHarness("cross-project");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const project = await createProject(owner, h.repoPath);

    const getRes = await stranger.fetch(`/projects/${project.id}`);
    assert.equal(getRes.status, 404);
    const body = await json<{ error: { code: string } }>(getRes);
    assert.equal(body.error.code, "NOT_FOUND");

    // The stranger's own project list must not include it either.
    const listRes = await json<{ projects: Array<{ id: string }> }>(await stranger.fetch("/projects"));
    assert.ok(!listRes.projects.some((p) => p.id === project.id));
  } finally {
    await teardown(h);
  }
});

test("a user cannot list or create tasks on another user's project", async () => {
  const h = await setupHarness("cross-project-tasks");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const project = await createProject(owner, h.repoPath);

    assert.equal((await stranger.fetch(`/projects/${project.id}/tasks`)).status, 404);
    const createRes = await stranger.fetch(`/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Hijack", description: "should not be allowed" }),
    });
    assert.equal(createRes.status, 404);
  } finally {
    await teardown(h);
  }
});

test("a user cannot access another user's task (get/events/report)", async () => {
  const h = await setupHarness("cross-task");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const project = await createProject(owner, h.repoPath);
    const { task } = await json<{ task: { id: string } }>(
      await owner.fetch(`/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "T", description: "D" }) }),
    );

    assert.equal((await stranger.fetch(`/tasks/${task.id}`)).status, 404);
    assert.equal((await stranger.fetch(`/tasks/${task.id}/events`)).status, 404);
    assert.equal((await stranger.fetch(`/tasks/${task.id}/report`)).status, 404);
    assert.equal((await stranger.fetch(`/tasks/${task.id}/input`)).status, 404);

    // The owner, meanwhile, can.
    assert.equal((await owner.fetch(`/tasks/${task.id}`)).status, 200);
  } finally {
    await teardown(h);
  }
});

test("a user cannot cancel another user's task", async () => {
  const h = await setupHarness("cross-cancel");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const project = await createProject(owner, h.repoPath);
    const { task } = await json<{ task: { id: string } }>(
      await owner.fetch(`/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "T", description: "D" }) }),
    );

    const cancelRes = await stranger.fetch(`/tasks/${task.id}/cancel`, { method: "POST" });
    assert.equal(cancelRes.status, 404);

    // Untouched: still BACKLOG, not cancelled by the stranger's attempt.
    const stillBacklog = await json<{ task: { status: string } }>(await owner.fetch(`/tasks/${task.id}`));
    assert.equal(stillBacklog.task.status, "BACKLOG");
  } finally {
    await teardown(h);
  }
});

test("a user cannot submit human input for another user's task", async () => {
  const h = await setupHarness("cross-input");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const project = await createProject(owner, h.repoPath);
    const { task } = await json<{ task: { id: string } }>(
      await owner.fetch(`/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "T", description: "D" }) }),
    );

    const submitRes = await stranger.fetch(`/tasks/${task.id}/input`, {
      method: "POST",
      body: JSON.stringify({ freeText: "an answer that should never be accepted" }),
    });
    assert.equal(submitRes.status, 404);
  } finally {
    await teardown(h);
  }
});

test("a user cannot trigger human-review feedback processing for another user's task", async () => {
  const h = await setupHarness("cross-review-feedback");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const project = await createProject(owner, h.repoPath);
    const { task } = await json<{ task: { id: string } }>(
      await owner.fetch(`/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "T", description: "D" }) }),
    );

    const res = await stranger.fetch(`/tasks/${task.id}/check-review-feedback`, { method: "POST" });
    assert.equal(res.status, 404);

    // The owner, meanwhile, can call it (a safe no-op for a task that isn't REVIEW yet).
    const ownerRes = await owner.fetch(`/tasks/${task.id}/check-review-feedback`, { method: "POST" });
    assert.equal(ownerRes.status, 200);
  } finally {
    await teardown(h);
  }
});

test("unauthenticated requests are rejected across the protected surface", async () => {
  const h = await setupHarness("unauth-surface");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const project = await createProject(owner, h.repoPath);
    const { task } = await json<{ task: { id: string } }>(
      await owner.fetch(`/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "T", description: "D" }) }),
    );

    const anon = (path: string, init?: RequestInit) => fetch(`${h.baseUrl}${path}`, init);
    for (const call of [
      () => anon("/projects"),
      () => anon("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      () => anon(`/projects/${project.id}`),
      () => anon(`/projects/${project.id}/tasks`),
      () => anon(`/tasks/${task.id}`),
      () => anon(`/tasks/${task.id}/events`),
      () => anon(`/tasks/${task.id}/report`),
      () => anon(`/tasks/${task.id}/input`),
      () => anon(`/tasks/${task.id}/cancel`, { method: "POST" }),
      () => anon(`/tasks/${task.id}/check-review-feedback`, { method: "POST" }),
    ]) {
      const res = await call();
      assert.equal(res.status, 401, `expected 401 for an unauthenticated call`);
    }
  } finally {
    await teardown(h);
  }
});

test("GET /health remains accessible without authentication and reveals no internal details", async () => {
  const h = await setupHarness("health");
  try {
    const res = await fetch(`${h.baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await json<Record<string, unknown>>(res);
    assert.deepEqual(Object.keys(body), ["status"]);
  } finally {
    await teardown(h);
  }
});

test("GET /health/ready is also public and reports ready when the database is reachable, revealing no internal details", async () => {
  const h = await setupHarness("health-ready");
  try {
    const res = await fetch(`${h.baseUrl}/health/ready`);
    assert.equal(res.status, 200);
    const body = await json<Record<string, unknown>>(res);
    assert.deepEqual(body, { status: "ready" });
  } finally {
    await teardown(h);
  }
});

test("GET /health/ready reports 503 once the database connection is closed", async () => {
  const h = await setupHarness("health-not-ready");
  try {
    h.platform.db.close();
    const res = await fetch(`${h.baseUrl}/health/ready`);
    assert.equal(res.status, 503);
    const body = await json<Record<string, unknown>>(res);
    assert.deepEqual(body, { status: "not_ready" });
  } finally {
    h.server.close();
  }
});

// ---------------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------------

test("a client cannot impersonate another user via a header — identity comes only from the session", async () => {
  const h = await setupHarness("impersonate");
  try {
    const userA = await registerClient(h.baseUrl, "userA");
    const userB = await registerClient(h.baseUrl, "userB");

    // userA sends its own valid session cookie (via userA.fetch) but also tries to claim to be
    // userB through headers — the server must trust only the cookie-derived identity.
    const impersonationAttempt = await userA.fetch("/projects", {
      method: "POST",
      headers: { "x-user-id": userB.userId, "x-actor-id": userB.userId },
      body: JSON.stringify({ name: "Impersonated Project", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    assert.equal(impersonationAttempt.status, 201);
    const { project } = await json<{ project: { id: string } }>(impersonationAttempt);

    // The project must be owned by userA (whoever's session cookie was actually presented),
    // never userB (whoever the client merely claimed to be via a header).
    const asUserA = await userA.fetch(`/projects/${project.id}`);
    assert.equal(asUserA.status, 200);
    const asUserB = await userB.fetch(`/projects/${project.id}`);
    assert.equal(asUserB.status, 404, "userB must not see a project the header claimed was theirs");
  } finally {
    await teardown(h);
  }
});
