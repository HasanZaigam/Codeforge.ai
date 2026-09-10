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

/**
 * Dedicated coverage for POST /tasks/:taskId/edit — the narrow, BACKLOG-only
 * task-configuration edit endpoint (see TaskService.editBacklogTask and the
 * doc comment atop src/api/routes/tasks.ts). Uses the same HTTP-layer
 * harness pattern as local-git-project-policy.test.ts.
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
  client: AuthedClient;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `edit-task-${label}-`));
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = await registerClient(baseUrl, label);
  return { platform, baseUrl, server, repoPath, client };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function createProject(h: Harness, overrides: Record<string, unknown> = {}): Promise<{ id: string; defaultBranch: string }> {
  const res = await h.client.fetch("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, ...overrides }),
  });
  const body = (await res.json()) as { project: { id: string; defaultBranch: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.project;
}

async function createTask(h: Harness, projectId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await h.client.fetch(`/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ title: "Original title", description: "Original description", ...overrides }),
  });
  const body = (await res.json()) as { task: { id: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.task;
}

test("edit succeeds for a BACKLOG task and updates exactly the allowed fields", async () => {
  const h = await setupHarness("happy-path");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "Updated title", description: "Updated description", branchMode: "new", branchName: "task/updated", baseBranch: "main" }),
    });
    const body = (await res.json()) as { task: Record<string, unknown> };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.task.title, "Updated title");
    assert.equal(body.task.description, "Updated description");
    assert.equal(body.task.branchMode, "new");
    assert.equal(body.task.workingBranch, "task/updated");
    assert.equal(body.task.baseBranch, "main");
    assert.equal(body.task.status, "BACKLOG", "editing must never change status");
  } finally {
    await teardown(h);
  }
});

test("edit rejects a task that is not BACKLOG (TODO)", async () => {
  const h = await setupHarness("reject-todo");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);
    const started = await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });
    assert.equal(started.status, 200);

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "New", description: "New" }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "TASK_NOT_EDITABLE");
  } finally {
    await teardown(h);
  }
});

test("edit rejects a task that is not BACKLOG (CANCELLED)", async () => {
  const h = await setupHarness("reject-cancelled");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);
    const cancelled = await h.client.fetch(`/tasks/${task.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "New", description: "New" }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "TASK_NOT_EDITABLE");
  } finally {
    await teardown(h);
  }
});

test("edit rejects a task that is not BACKLOG (WORKING)", async () => {
  const h = await setupHarness("reject-working");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);
    await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });
    // Claim it into WORKING directly via the platform, same as a worker tick would.
    h.platform.tasks.claimTodo(task.id, "worker-1", 60_000, new Date().toISOString());

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "New", description: "New" }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "TASK_NOT_EDITABLE");
  } finally {
    await teardown(h);
  }
});

test("edit rejects an unsafe branch name using the same validation as creation", async () => {
  const h = await setupHarness("unsafe-branch");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "New", description: "New", branchMode: "new", branchName: "-rf" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
  } finally {
    await teardown(h);
  }
});

test("edit rejects a new-branch name identical to the base branch, mirroring creation", async () => {
  const h = await setupHarness("same-as-base");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "New", description: "New", branchMode: "new", branchName: "main", baseBranch: "main" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_BRANCH_SELECTION");
  } finally {
    await teardown(h);
  }
});

test("edit does not affect other fields (status, id, timestamps' identity) beyond what was requested", async () => {
  const h = await setupHarness("field-scope");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);

    const before = await (await h.client.fetch(`/tasks/${task.id}`)).json() as { task: { createdAt: string; id: string } };

    const res = await h.client.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "New title only", description: "New description only" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { task: Record<string, unknown> };
    assert.equal(body.task.id, before.task.id);
    assert.equal(body.task.createdAt, before.task.createdAt);
    assert.equal(body.task.status, "BACKLOG");
  } finally {
    await teardown(h);
  }
});

test("edit is scoped to the owning user's task — cannot edit another user's task (404, not 403)", async () => {
  const h = await setupHarness("access-control");
  try {
    const project = await createProject(h);
    const task = await createTask(h, project.id);

    const otherClient = await registerClient(h.baseUrl, "other-user");
    const res = await otherClient.fetch(`/tasks/${task.id}/edit`, {
      method: "POST",
      body: JSON.stringify({ title: "Hijacked", description: "Hijacked" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "NOT_FOUND");
  } finally {
    await teardown(h);
  }
});
