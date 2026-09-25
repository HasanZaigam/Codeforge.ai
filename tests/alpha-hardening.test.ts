import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { EngineExecutionError } from "../src/coding-engine/coding-engine.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import { ModelRegistry, UNKNOWN_CAPABILITY_PROFILE } from "../src/routing/model-registry.js";
import { redactSecrets } from "../src/security/redact.js";
import { validateSharedConfig, ConfigError } from "../src/config/startup-config.js";
import { isSecureCookieEnabled } from "../src/api/cookies.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { registerClient, type AuthedClient } from "./helpers/auth-client.js";
import type { Project } from "../src/domain/types.js";

/**
 * Developer Alpha hardening — regression coverage for the isolation, concurrency and configuration
 * claims docs/INTERNAL_ALPHA.md makes. Real HTTP server, real SQLite file, real fixture repos.
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `alpha-${label}-`));
  const platform = buildPlatform({ dbPath: join(root, "platform.sqlite"), workspacesRoot: join(root, "workspaces"), engine: createSelfFixDemoEngine(), ownerId: `w-${label}` });
  const repoPath = await createFixtureRepo(root);
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return { platform, baseUrl: `http://127.0.0.1:${address.port}`, server, repoPath };
}
async function teardown(h: Harness) {
  await new Promise((r) => h.server.close(r));
  h.platform.db.close();
}
async function createProject(c: AuthedClient, repoPath: string): Promise<string> {
  const res = await c.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "P", sourceControlProvider: "local-git", repoUrl: repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }) });
  return ((await res.json()) as { project: { id: string } }).project.id;
}
async function createTask(c: AuthedClient, projectId: string): Promise<string> {
  const res = await c.fetch(`/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ title: "Fix add()", description: "add() returns the wrong result" }) });
  return ((await res.json()) as { task: { id: string } }).task.id;
}

// ---------------------------------------------------------------------------
// Test 1/2/3/16 — isolation sweep over EVERY project/task route
// ---------------------------------------------------------------------------

test("isolation sweep: every project/task route is 401 unauthenticated and 404 for a different user — none confirms the resource exists", async () => {
  const h = await setupHarness("sweep");
  try {
    const owner = await registerClient(h.baseUrl, "owner");
    const stranger = await registerClient(h.baseUrl, "stranger");
    const projectId = await createProject(owner, h.repoPath);
    const taskId = await createTask(owner, projectId);
    const otherTaskId = await createTask(owner, projectId);

    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/projects/${projectId}`],
      ["PATCH", `/projects/${projectId}/commands`, { commands: { test: "node test.js" } }],
      ["DELETE", `/projects/${projectId}`],
      ["GET", `/projects/${projectId}/workspace`],
      ["GET", `/projects/${projectId}/context`],
      ["PUT", `/projects/${projectId}/context`, { revision: 0, manifest: {} }],
      ["GET", `/projects/${projectId}/branches`],
      ["GET", `/projects/${projectId}/tasks`],
      ["POST", `/projects/${projectId}/tasks`, { title: "x", description: "y" }],
      ["GET", `/tasks/${taskId}`],
      ["GET", `/tasks/${taskId}/events`],
      ["GET", `/tasks/${taskId}/report`],
      ["GET", `/tasks/${taskId}/input`],
      ["POST", `/tasks/${taskId}/input`, { freeText: "x" }],
      ["POST", `/tasks/${taskId}/start`],
      ["POST", `/tasks/${taskId}/edit`, { title: "x", description: "y" }],
      ["POST", `/tasks/${taskId}/cancel`],
      ["GET", `/tasks/${taskId}/branch-state`],
      ["POST", `/tasks/${taskId}/check-review-feedback`],
      ["GET", `/tasks/${taskId}/dependencies`],
      ["POST", `/tasks/${taskId}/dependencies`, { dependsOnTaskId: otherTaskId }],
      ["DELETE", `/tasks/${taskId}/dependencies/${otherTaskId}`],
    ];
    for (const [method, path, body] of routes) {
      const init: RequestInit = { method, body: body === undefined ? undefined : JSON.stringify(body) };
      const anon = await fetch(`${h.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json" } });
      assert.equal(anon.status, 401, `${method} ${path} unauthenticated`);
      const res = await stranger.fetch(path, init);
      assert.equal(res.status, 404, `${method} ${path} as another user must be 404 (existence-masking), got ${res.status}`);
    }
    // ...and the owner's project/tasks were never touched by any of the stranger's attempts.
    const still = await owner.fetch(`/tasks/${taskId}`);
    assert.equal(still.status, 200);
    assert.equal(((await still.json()) as { task: { status: string } }).task.status, "BACKLOG");
  } finally {
    await teardown(h);
  }
});

// ---------------------------------------------------------------------------
// Test 5 — the same task started twice
// ---------------------------------------------------------------------------

test("two simultaneous Start requests for the same task: exactly one succeeds, the task is released exactly once", async () => {
  const h = await setupHarness("double-start");
  try {
    const c = await registerClient(h.baseUrl, "dev");
    const projectId = await createProject(c, h.repoPath);
    const taskId = await createTask(c, projectId);
    const results = await Promise.all([c.fetch(`/tasks/${taskId}/start`, { method: "POST" }), c.fetch(`/tasks/${taskId}/start`, { method: "POST" })]);
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one Start may win, got ${statuses}`);
    assert.ok(statuses.every((s) => s === 200 || s === 409), `the loser must be a clean 409, got ${statuses}`);
    const released = h.platform.taskEvents.listForTask(taskId).filter((e) => e.type === "TASK_RELEASED");
    assert.equal(released.length, 1);
  } finally {
    await teardown(h);
  }
});

// ---------------------------------------------------------------------------
// Operations / HTTP hardening
// ---------------------------------------------------------------------------

test("/ops/summary requires auth and is scoped to the caller's own tasks", async () => {
  const h = await setupHarness("ops");
  try {
    assert.equal((await fetch(`${h.baseUrl}/ops/summary`)).status, 401);
    const owner = await registerClient(h.baseUrl, "owner");
    const other = await registerClient(h.baseUrl, "other");
    const projectId = await createProject(owner, h.repoPath);
    await createTask(owner, projectId);
    const mine = (await (await owner.fetch("/ops/summary")).json()) as { tasks: { byStatus: Record<string, number> }; providers: unknown[] };
    assert.equal(mine.tasks.byStatus.BACKLOG, 1);
    const theirs = (await (await other.fetch("/ops/summary")).json()) as { tasks: { byStatus: Record<string, number> } };
    assert.deepEqual(theirs.tasks.byStatus, {}, "another developer's counts never include this task");
  } finally {
    await teardown(h);
  }
});

test("malformed JSON is a clean 400, not a 500, and leaks no internals", async () => {
  const h = await setupHarness("badjson");
  try {
    const res = await fetch(`${h.baseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!/at .*\.(js|ts):\d+/.test(text) && !text.includes("node_modules"), "no stack trace or file path in the response");
    assert.equal(((JSON.parse(text) as { error: { code: string } }).error.code), "INVALID_REQUEST");
  } finally {
    await teardown(h);
  }
});

test("session cookie is HttpOnly + SameSite=Lax, and Secure follows COOKIE_SECURE / NODE_ENV", async () => {
  const h = await setupHarness("cookie");
  try {
    const res = await fetch(`${h.baseUrl}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "cookie@example.com", password: "correct horse battery staple", name: "C" }) });
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.ok(/HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie));
  } finally {
    await teardown(h);
  }
  assert.equal(isSecureCookieEnabled({ NODE_ENV: "production" }), true);
  assert.equal(isSecureCookieEnabled({ NODE_ENV: "production", COOKIE_SECURE: "false" }), false, "an HTTP-only alpha box can opt out explicitly");
  assert.equal(isSecureCookieEnabled({ COOKIE_SECURE: "true" }), true);
  assert.equal(isSecureCookieEnabled({}), false);
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("redactSecrets removes secret-named env values from agent-produced text, leaves ordinary text alone", () => {
  const env = { OPENAI_API_KEY: "sk-live-abcdef123456", GITHUB_TOKEN: "ghp_abcdefghijkl", PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc", NODE_ENV: "production" };
  const out = redactSecrets("$ printenv\nOPENAI_API_KEY=sk-live-abcdef123456\nGITHUB_TOKEN=ghp_abcdefghijkl\nPATH=/usr/bin:/bin\nSHORT_TOKEN=abc", env);
  assert.ok(!out.includes("sk-live-abcdef123456") && !out.includes("ghp_abcdefghijkl"));
  assert.ok(out.includes("[REDACTED:OPENAI_API_KEY]") && out.includes("[REDACTED:GITHUB_TOKEN]"));
  assert.ok(out.includes("PATH=/usr/bin:/bin"), "non-secret values are untouched");
  assert.ok(out.includes("SHORT_TOKEN=abc"), "values under 8 chars are never treated as secrets (they'd redact ordinary text)");
});

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

test("production startup validation fails fast and clearly on missing/invalid configuration", () => {
  const good = { NODE_ENV: "production", DB_PATH: "/var/lib/cf/db.sqlite", WORKSPACES_ROOT: "/var/lib/cf/ws", PROJECT_WORKSPACE_ROOT: "/var/lib/cf/pws", CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
  assert.doesNotThrow(() => validateSharedConfig(good));
  assert.throws(() => validateSharedConfig({ ...good, DB_PATH: undefined }), /DB_PATH must be set/);
  assert.throws(() => validateSharedConfig({ ...good, WORKSPACES_ROOT: "./relative" }), /absolute/);
  assert.throws(() => validateSharedConfig({ ...good, CREDENTIAL_ENCRYPTION_KEY: undefined }), /CREDENTIAL_ENCRYPTION_KEY must be set/);
  assert.throws(() => validateSharedConfig({ ...good, COOKIE_SECURE: "yes" }), ConfigError);
  assert.throws(() => validateSharedConfig({ ...good, TRUST_PROXY: "lots" }), ConfigError);
  // Development stays permissive — the same variables are not required outside production.
  assert.doesNotThrow(() => validateSharedConfig({ NODE_ENV: "development" }));
});

// ---------------------------------------------------------------------------
// Test 4/18 — five developers, five projects, two workers, one database
// ---------------------------------------------------------------------------

const GOOD_ADD_JS = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
const approve = async (): Promise<EngineInvocationResult> => ({ result: { status: "completed" as const, summary: "VERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" });
const fixer = async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
  await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
  return { result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" };
};

test("5 developers / 5 projects / 2 workers on one database: all tasks complete, isolated, each claimed exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-five-"));
  const engine = new FixtureCodingEngine({ implementer: fixer, reviewer: approve });
  const opts = { dbPath: join(root, "platform.sqlite"), workspacesRoot: join(root, "workspaces"), engine };
  const workerA = buildPlatform({ ...opts, ownerId: "worker-A" });
  const workerB = buildPlatform({ ...opts, ownerId: "worker-B" });

  const devs: Array<{ userId: string; project: Project; taskId: string }> = [];
  for (let i = 0; i < 5; i++) {
    const devRoot = await mkdtemp(join(tmpdir(), `alpha-dev${i}-`));
    const repoPath = await createFixtureRepo(devRoot);
    const now = new Date().toISOString();
    const user = { id: randomUUID(), tenantId: "default", email: `dev${i}@example.com`, name: `Dev ${i}`, passwordHash: "", createdAt: now };
    workerA.users.insert(user);
    const project: Project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: `Project ${i}`, repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
    workerA.projects.insert(project);
    const task = createReadyTask(workerA.tasks, workerA.taskEvents, { tenantId: "default", projectId: project.id, title: `Task ${i}`, goal: `Fix add() in project ${i}`, createdBy: user.id });
    devs.push({ userId: user.id, project, taskId: task.id });
  }

  // Every task is offered to BOTH workers at once — the atomic claim must give each to exactly one.
  const runs = devs.flatMap((d) => [workerA.orchestrator.executeTask(d.taskId), workerB.orchestrator.executeTask(d.taskId)]);
  await Promise.all(runs);

  const workspacePaths = new Set<string>();
  const branches = new Set<string>();
  for (const d of devs) {
    const task = workerA.tasks.findById(d.taskId)!;
    assert.equal(task.status, "REVIEW", `task for ${d.project.name}`);
    assert.equal(task.projectId, d.project.id);
    const events = workerA.taskEvents.listForTask(d.taskId);
    assert.equal(events.filter((e) => e.type === "TASK_CLAIMED").length, 1, "claimed exactly once across both workers");
    assert.equal(events.filter((e) => e.type === "WORKSPACE_CREATED").length, 1);
    const ws = workerA.workspaces.findByTaskId(d.taskId)!;
    assert.ok(ws.path.endsWith(d.taskId), "workspace path is derived only from the task id");
    workspacePaths.add(ws.path);
    branches.add(ws.branch);
    for (const run of workerA.agentRuns.listForTask(d.taskId)) assert.equal(run.taskId, d.taskId);
  }
  assert.equal(workspacePaths.size, 5, "5 distinct workspaces");
  assert.equal(branches.size, 5, "5 distinct branches");
  workerA.db.close();
  workerB.db.close();
});

// ---------------------------------------------------------------------------
// Test 9 — provider cooldown observed across independent worker instances
// ---------------------------------------------------------------------------

test("provider cooldown recorded by one worker is honoured by another worker on the same database", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-cooldown-"));
  const registry = new ModelRegistry();
  for (const [modelId, providerId] of [["model-a", "provider-a"], ["model-b", "provider-b"]] as const) {
    registry.register({ modelId, providerId, displayName: modelId, engineKey: "fixture", capability: UNKNOWN_CAPABILITY_PROFILE, contextWindow: null, credentialMode: "managed", enabled: true });
  }
  const engine = new FixtureCodingEngine({
    implementer: async (request) => {
      if (request.modelSelection?.providerId === "provider-a") {
        throw new EngineExecutionError("implementer", "Gemini returned HTTP 429 RESOURCE_EXHAUSTED: quota", { attempts: 1, retryable: true, classification: "rate_limit" });
      }
      return fixer(request);
    },
    reviewer: approve,
  });
  const opts = { dbPath: join(root, "platform.sqlite"), workspacesRoot: join(root, "workspaces"), engine, modelRegistry: registry, orchestratorConfig: { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 10, infrastructureRetryMaxDelayMs: 50 } };
  const workerA = buildPlatform({ ...opts, ownerId: "cd-A" });
  const workerB = buildPlatform({ ...opts, ownerId: "cd-B" });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "cd@example.com", name: "CD", passwordHash: "", createdAt: now };
  workerA.users.insert(user);
  const project: Project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: "P", repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
  workerA.projects.insert(project);
  const mk = () => createReadyTask(workerA.tasks, workerA.taskEvents, { tenantId: "default", projectId: project.id, title: "t", goal: "g", createdBy: user.id });

  const t1 = mk();
  assert.equal((await workerA.orchestrator.executeTask(t1.id)).status, "REVIEW");
  assert.equal(workerB.providerHealth.get("provider-a")?.state, "cooldown", "worker B reads the cooldown worker A recorded — via the database, not shared memory");

  const t2 = mk();
  assert.equal((await workerB.orchestrator.executeTask(t2.id)).status, "REVIEW");
  const t2Runs = workerB.agentRuns.listForTask(t2.id).filter((r) => r.role === "implementer");
  assert.equal(t2Runs.length, 1, "worker B never re-probed the cooling provider");
  assert.equal(t2Runs[0]!.providerId, "provider-b");
  workerA.db.close();
  workerB.db.close();
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

test("task report telemetry is derived from real evidence and never fabricates token counts", async () => {
  const h = await setupHarness("telemetry");
  try {
    const c = await registerClient(h.baseUrl, "dev");
    const projectId = await createProject(c, h.repoPath);
    const taskId = await createTask(c, projectId);
    const report = (await (await c.fetch(`/tasks/${taskId}/report`)).json()) as { report?: { telemetry: Record<string, unknown> } } & { telemetry?: Record<string, unknown> };
    const telemetry = (report.report ?? report).telemetry!;
    assert.equal(telemetry.implementerAttempts, 0);
    assert.equal(telemetry.inputTokens, null, "no run reported tokens — must be null, not 0");
    assert.equal(telemetry.tokensReportedRuns, 0);
    assert.deepEqual(telemetry.modelsUsed, []);
  } finally {
    await teardown(h);
  }
});
