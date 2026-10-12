import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient } from "./helpers/auth-client.js";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/**
 * DELETE /projects/:projectId — see ProjectService.delete's own doc comment. Blocked (409
 * PROJECT_HAS_ACTIVE_TASKS) while any task is TODO/WORKING/NEEDS_INPUT/REVIEW; otherwise cascades
 * through every row scoped to the project (tasks and everything that in turn belongs to them).
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `project-delete-${label}-`));
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

test("DELETE /projects/:projectId: a project with no tasks is deleted outright (204), and a subsequent GET 404s", async () => {
  const h = await setupHarness("empty");
  try {
    const client = await registerClient(h.baseUrl, "empty");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const deleteRes = await client.fetch(`/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 204);

    const getRes = await client.fetch(`/projects/${project.id}`);
    assert.equal(getRes.status, 404);
  } finally {
    await teardown(h);
  }
});

test("DELETE /projects/:projectId: a BACKLOG task never blocks deletion, and the task row itself is gone afterward", async () => {
  const h = await setupHarness("backlog-ok");
  try {
    const client = await registerClient(h.baseUrl, "backlog-ok");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);
    const taskRes = await client.fetch(`/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Backlog task", description: "Stays in backlog" }),
    });
    const { task } = await json<{ task: { id: string; status: string } }>(taskRes);
    assert.equal(task.status, "BACKLOG");

    const deleteRes = await client.fetch(`/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 204);

    assert.equal(h.platform.tasks.findById(task.id), null, "the task row must have been cascade-deleted with its project");
  } finally {
    await teardown(h);
  }
});

test("DELETE /projects/:projectId: a WORKING task blocks deletion with 409 PROJECT_HAS_ACTIVE_TASKS, and nothing is deleted", async () => {
  const h = await setupHarness("working-blocks");
  try {
    const client = await registerClient(h.baseUrl, "working-blocks");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);
    const taskRes = await client.fetch(`/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Active task", description: "Will be started" }),
    });
    const { task } = await json<{ task: { id: string } }>(taskRes);
    await client.fetch(`/tasks/${task.id}/start`, { method: "POST" });

    const now = new Date().toISOString();
    const claimed = h.platform.tasks.claimTodo(task.id, "test-owner", 60_000, now);
    assert.ok(claimed !== null, "expected the task to be claimable straight into WORKING for this test's setup");

    const deleteRes = await client.fetch(`/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 409);
    const body = await json<{ error: { code: string } }>(deleteRes);
    assert.equal(body.error.code, "PROJECT_HAS_ACTIVE_TASKS");

    const getRes = await client.fetch(`/projects/${project.id}`);
    assert.equal(getRes.status, 200, "the project must still exist — the blocked delete must not have partially applied");
  } finally {
    await teardown(h);
  }
});

test("DELETE /projects/:projectId: a non-owner gets a 404, and the project is left completely untouched", async () => {
  const h = await setupHarness("non-owner");
  try {
    const ownerClient = await registerClient(h.baseUrl, "non-owner-owner");
    const otherClient = await registerClient(h.baseUrl, "non-owner-other");
    const createRes = await ownerClient.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const deleteRes = await otherClient.fetch(`/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 404);

    const getRes = await ownerClient.fetch(`/projects/${project.id}`);
    assert.equal(getRes.status, 200);
  } finally {
    await teardown(h);
  }
});

test("DELETE /projects/:projectId: a project whose Chat was used and that imported a bug sheet is still deletable, leaving nothing behind (regression)", async () => {
  const h = await setupHarness("chat-import");
  try {
    const client = await registerClient(h.baseUrl, "chat-import");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    // Opening the Overview creates the Chat conversation; a deterministic question adds messages without a model call.
    assert.equal((await client.fetch(`/projects/${project.id}/chat/messages`)).status, 200);
    const chatRes = await client.fetch(`/projects/${project.id}/chat/messages`, { method: "POST", body: JSON.stringify({ text: "How many tasks are in Review?" }) });
    assert.equal(chatRes.status, 201);
    const csv = "Bug Id,Bug title,Step to Reproduce,Expected Result,Actual Result\nBUG-1,Login broken,Open app,Works,Broken\n";
    const importRes = await client.fetch(`/projects/${project.id}/backlog/imports`, { method: "POST", body: JSON.stringify({ csv, sourceName: "bugs.csv" }) });
    assert.equal(importRes.status, 201);

    const deleteRes = await client.fetch(`/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 204);

    const db = h.platform.db;
    const projectScoped = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "project_id"));
    for (const table of projectScoped) {
      const left = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(project.id) as { n: number }).n;
      assert.equal(left, 0, `${table} still has rows for the deleted project`);
    }
    assert.equal((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n, 0);
  } finally {
    await teardown(h);
  }
});

test("deleteCascade covers every project-scoped table and every table hanging off one — a new one can't silently block deletes again", async () => {
  const h = await setupHarness("coverage");
  try {
    const db = h.platform.db;
    const source = (await import("node:fs")).readFileSync(join(process.cwd(), "src/persistence/repositories/project-repository.ts"), "utf8");
    const body = source.slice(source.indexOf("deleteCascade(projectId: string): void {"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => !t.startsWith("sqlite_") && !t.startsWith("_"));
    const fks = new Map(tables.map((t) => [t, (db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[]).map((f) => f.table)]));

    // Project-scoped: has project_id, or references (directly or transitively) a project-scoped table.
    const scoped = new Set(tables.filter((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "project_id")));
    scoped.add("projects");
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of tables) {
        if (!scoped.has(t) && fks.get(t)!.some((parent) => scoped.has(parent) && parent !== "users")) {
          scoped.add(t);
          grew = true;
        }
      }
    }
    const missing = [...scoped].filter((t) => !body.includes(`FROM ${t} `) && !body.includes(`FROM ${t}"`));
    assert.deepEqual(missing, [], `deleteCascade doesn't delete from: ${missing.join(", ")}`);
  } finally {
    await teardown(h);
  }
});

test("deleteCascade is all-or-nothing: if the final delete fails, nothing has been removed", async () => {
  const h = await setupHarness("atomic");
  try {
    const client = await registerClient(h.baseUrl, "atomic");
    const { project } = await json<{ project: { id: string } }>(
      await client.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }) }),
    );
    await client.fetch(`/projects/${project.id}/chat/messages`);

    h.platform.db.exec("CREATE TRIGGER block_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    assert.throws(() => h.platform.projects.deleteCascade(project.id), /simulated failure/);

    const count = (sql: string) => (h.platform.db.prepare(sql).get(project.id) as { n: number }).n;
    assert.equal(count("SELECT COUNT(*) AS n FROM chat_conversations WHERE project_id = ?"), 1, "the conversation was rolled back, not half-deleted");
    assert.equal(count("SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM projects WHERE id = ?"), 1);
  } finally {
    await teardown(h);
  }
});
