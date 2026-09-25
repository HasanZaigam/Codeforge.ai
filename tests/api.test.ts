import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { Worker } from "../src/worker/worker.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createNeedsInputDemoEngine, createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { registerClient, type AuthedClient } from "./helpers/auth-client.js";

interface Harness {
  platform: Platform;
  worker: Worker;
  baseUrl: string;
  server: Server;
  repoPath: string;
  client: AuthedClient;
}

async function setupHarness(label: string, engine: ReturnType<typeof createSelfFixDemoEngine>): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `api-test-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
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
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 }); // interval irrelevant — tests call tick() directly
  const client = await registerClient(baseUrl, label);
  return { platform, worker, baseUrl, server, repoPath, client };
}

async function teardown(h: Harness): Promise<void> {
  await h.worker.stop();
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

test("full HTTP flow: create project -> create task -> API returns immediately in TODO -> worker drives it to REVIEW", async () => {
  const h = await setupHarness("happy", createSelfFixDemoEngine());
  try {
    const projectRes = await h.client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
    });
    assert.equal(projectRes.status, 201);
    const { project } = await json<{ project: { id: string } }>(projectRes);

    const start = Date.now();
    const taskRes = await h.client.fetch(`/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Fix add()", description: "add() returns the wrong result" }),
    });
    const elapsedMs = Date.now() - start;
    assert.equal(taskRes.status, 201);
    const { task } = await json<{ task: { id: string; status: string } }>(taskRes);
    assert.equal(task.status, "BACKLOG", "task creation must not execute the task inline, and must not skip the human release gate");
    assert.ok(elapsedMs < 1000, `task creation should return near-instantly, took ${elapsedMs}ms`);

    // Nothing has executed yet — no worker has ticked, and the task hasn't even been released.
    const stillBacklog = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(stillBacklog.task.status, "BACKLOG");

    // The worker must never pick up a BACKLOG task on its own.
    await h.worker.tick();
    const stillBacklogAfterTick = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(stillBacklogAfterTick.task.status, "BACKLOG", "the worker must never claim a BACKLOG task");

    const startRes = await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });
    assert.equal(startRes.status, 200);
    const { task: released } = await json<{ task: { status: string } }>(startRes);
    assert.equal(released.status, "TODO");

    const stillTodo = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(stillTodo.task.status, "TODO");

    await h.worker.tick(); // simulates one poll cycle — drives the task through WORKING to REVIEW

    const afterTick = await json<{ task: { status: string; currentActivity: string } }>(
      await h.client.fetch(`/tasks/${task.id}`),
    );
    assert.equal(afterTick.task.status, "REVIEW");

    const eventsRes = await json<{ events: Array<{ type: string }> }>(await h.client.fetch(`/tasks/${task.id}/events`));
    const types = eventsRes.events.map((e) => e.type);
    assert.ok(types.includes("TASK_MOVED_TO_REVIEW"));
    assert.ok(types.includes("RETRY_STARTED"));

    const reportRes = await json<{ report: { status: string; confidence: string } }>(
      await h.client.fetch(`/tasks/${task.id}/report`),
    );
    assert.equal(reportRes.report.status, "Ready for review");
    assert.equal(reportRes.report.confidence, "high");
  } finally {
    await teardown(h);
  }
});

test("NEEDS_INPUT is exposed via the API and answering resumes the task to REVIEW", async () => {
  const h = await setupHarness("needs-input", createNeedsInputDemoEngine());
  try {
    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
      }),
    );
    const { task } = await json<{ task: { id: string } }>(
      await h.client.fetch(`/projects/${project.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Fix add()", description: "add() returns the wrong result" }),
      }),
    );
    await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });

    await h.worker.tick();

    const midStatus = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(midStatus.task.status, "NEEDS_INPUT");

    const before = await json<{ input: { question: string; discovered: string } | null }>(
      await h.client.fetch(`/tasks/${task.id}/input`),
    );
    assert.ok(before.input);
    assert.ok(before.input!.question.length > 0);
    assert.ok(before.input!.discovered.length > 0);

    const answerRes = await h.client.fetch(`/tasks/${task.id}/input`, {
      method: "POST",
      body: JSON.stringify({ selectedOption: "Fix add() to return a + b", freeText: "Fix add() to return a + b" }),
    });
    assert.equal(answerRes.status, 200);
    const { task: resumedTask } = await json<{ task: { status: string } }>(answerRes);
    assert.equal(resumedTask.status, "WORKING", "answering resumes but does not itself finish execution");

    // Answering again must be rejected (already answered).
    const secondAnswer = await h.client.fetch(`/tasks/${task.id}/input`, {
      method: "POST",
      body: JSON.stringify({ freeText: "duplicate" }),
    });
    assert.equal(secondAnswer.status, 409);

    await h.worker.tick(); // resumes execution, reaches REVIEW

    const finalStatus = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(finalStatus.task.status, "REVIEW");
  } finally {
    await teardown(h);
  }
});

test("error responses: 404s, invalid body, input-not-required, unauthenticated", async () => {
  const h = await setupHarness("errors", createSelfFixDemoEngine());
  try {
    assert.equal((await h.client.fetch("/projects/does-not-exist")).status, 404);
    assert.equal((await h.client.fetch("/tasks/does-not-exist")).status, 404);
    assert.equal((await h.client.fetch("/tasks/does-not-exist/events")).status, 404);

    const badBody = await h.client.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "" }) });
    assert.equal(badBody.status, 400);

    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "P", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture" }),
      }),
    );
    const { task } = await json<{ task: { id: string } }>(
      await h.client.fetch(`/projects/${project.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "T", description: "D" }),
      }),
    );

    const inputWhenNoneOpen = await h.client.fetch(`/tasks/${task.id}/input`, {
      method: "POST",
      body: JSON.stringify({ freeText: "x" }),
    });
    assert.equal(inputWhenNoneOpen.status, 409);

    // No session cookie at all -> 401, not treated as some fallback identity.
    const unauthenticated = await fetch(`${h.baseUrl}/projects`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    await teardown(h);
  }
});

test("POST /tasks/:id/cancel: cancels a TODO task, is idempotent, rejects an invalid task, and rejects an already-terminal one", async () => {
  const h = await setupHarness("cancel", createSelfFixDemoEngine());
  try {
    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
      }),
    );

    // Invalid task id -> 404, safe error body, no stack trace.
    const notFound = await h.client.fetch("/tasks/does-not-exist/cancel", { method: "POST" });
    assert.equal(notFound.status, 404);
    const notFoundBody = await json<{ error: { code: string; message: string } }>(notFound);
    assert.equal(notFoundBody.error.code, "NOT_FOUND");
    assert.ok(!notFoundBody.error.message.includes("at "), "must not leak a stack trace");

    // Cancel a BACKLOG task (never released — identical "nothing running" shape to cancelling TODO,
    // see task-state-machine.ts's TRANSITIONS comment).
    const { task } = await json<{ task: { id: string } }>(
      await h.client.fetch(`/projects/${project.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Fix add()", description: "add() returns the wrong result" }),
      }),
    );

    const cancelRes = await h.client.fetch(`/tasks/${task.id}/cancel`, { method: "POST" });
    assert.equal(cancelRes.status, 200);
    const { task: cancelled } = await json<{ task: { status: string; cancelledBy: string | null; cancelRequested: boolean } }>(
      cancelRes,
    );
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancelRequested, false, "cancelRequested is only true while WORKING and pending, not once terminal");
    assert.equal(cancelled.cancelledBy, h.client.userId, "the actor recorded is the authenticated user, not a client-supplied id");

    // The worker must never pick it back up.
    await h.worker.tick();
    const stillCancelled = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(stillCancelled.task.status, "CANCELLED");

    // Repeated cancellation is idempotent, not an error.
    const repeat = await h.client.fetch(`/tasks/${task.id}/cancel`, { method: "POST" });
    assert.equal(repeat.status, 200);
    const { task: repeatTask } = await json<{ task: { status: string } }>(repeat);
    assert.equal(repeatTask.status, "CANCELLED");

    // Cancelling an already-DONE task must be rejected, not silently accepted.
    const { task: task2 } = await json<{ task: { id: string } }>(
      await h.client.fetch(`/projects/${project.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Fix add() again", description: "add() returns the wrong result" }),
      }),
    );
    await h.client.fetch(`/tasks/${task2.id}/start`, { method: "POST" });
    await h.worker.tick();
    const inReview = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task2.id}`));
    assert.equal(inReview.task.status, "REVIEW");

    const cancelDone = await h.client.fetch(`/tasks/${task2.id}/cancel`, { method: "POST" });
    assert.equal(cancelDone.status, 409);
    const cancelDoneBody = await json<{ error: { code: string } }>(cancelDone);
    assert.equal(cancelDoneBody.error.code, "INVALID_STATE_TRANSITION");
  } finally {
    await teardown(h);
  }
});

test("POST /tasks/:id/cancel: concurrent cancel requests against the same task never double-finalize", async () => {
  const h = await setupHarness("cancel-concurrent", createSelfFixDemoEngine());
  try {
    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
      }),
    );
    const { task } = await json<{ task: { id: string } }>(
      await h.client.fetch(`/projects/${project.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Fix add()", description: "add() returns the wrong result" }),
      }),
    );

    // Still BACKLOG (never released): cancellation finalizes immediately (no live execution to race
    // against), so this exercises the atomic finalizeCancellationOnBacklog guard directly — only one
    // of these three concurrent requests may actually win the UPDATE; the rest must resolve
    // idempotently, not error.
    const responses = await Promise.all([
      h.client.fetch(`/tasks/${task.id}/cancel`, { method: "POST" }),
      h.client.fetch(`/tasks/${task.id}/cancel`, { method: "POST" }),
      h.client.fetch(`/tasks/${task.id}/cancel`, { method: "POST" }),
    ]);
    for (const res of responses) assert.equal(res.status, 200);

    const events = await json<{ events: Array<{ type: string }> }>(await h.client.fetch(`/tasks/${task.id}/events`));
    const cancelledEvents = events.events.filter((e) => e.type === "TASK_CANCELLED");
    assert.equal(cancelledEvents.length, 1, "three concurrent requests must still only finalize cancellation once");
  } finally {
    await teardown(h);
  }
});

test("POST /tasks/:id/start: releases a BACKLOG task, rejects a second call and a call against a non-BACKLOG task, and 404s for an unknown task", async () => {
  const h = await setupHarness("start", createSelfFixDemoEngine());
  try {
    const notFound = await h.client.fetch("/tasks/does-not-exist/start", { method: "POST" });
    assert.equal(notFound.status, 404);

    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
      }),
    );
    const { task } = await json<{ task: { id: string; status: string } }>(
      await h.client.fetch(`/projects/${project.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Fix add()", description: "add() returns the wrong result" }),
      }),
    );
    assert.equal(task.status, "BACKLOG");

    const startRes = await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });
    assert.equal(startRes.status, 200);
    const { task: started } = await json<{ task: { status: string } }>(startRes);
    assert.equal(started.status, "TODO");

    // A second start attempt is rejected, not a silent no-op — the task is already released.
    const secondStart = await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });
    assert.equal(secondStart.status, 409);
    const secondStartBody = await json<{ error: { code: string } }>(secondStart);
    assert.equal(secondStartBody.error.code, "INVALID_STATE_TRANSITION");

    // Still TODO — the rejected duplicate must not have changed anything.
    const stillTodo = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(stillTodo.task.status, "TODO");

    // Starting a task already in WORKING/REVIEW/etc. is equally rejected — drive this one all the
    // way to REVIEW first, then try to start it.
    await h.worker.tick();
    const inReview = await json<{ task: { status: string } }>(await h.client.fetch(`/tasks/${task.id}`));
    assert.equal(inReview.task.status, "REVIEW");
    const startOnReview = await h.client.fetch(`/tasks/${task.id}/start`, { method: "POST" });
    assert.equal(startOnReview.status, 409);
  } finally {
    await teardown(h);
  }
});

// Phase 3 — Project Workspace, Slice 1: GET /projects/:projectId/workspace over real HTTP. See
// tests/project-workspace.test.ts for the repository/service-level coverage (including the
// GitHub-provider and migration-backfill cases) — this covers only the HTTP-layer contract
// (owner/non-owner/unknown-id), matching this file's existing "over real HTTP" scope.
test("GET /projects/:projectId/workspace: 200 with the correct shape for the owner", async () => {
  const h = await setupHarness("workspace-owner", createSelfFixDemoEngine());
  try {
    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture" }),
      }),
    );

    const res = await h.client.fetch(`/projects/${project.id}/workspace`);
    assert.equal(res.status, 200);
    const body = await json<{ workspace: { id: string; projectId: string; createdAt: string; updatedAt: string } }>(res);
    assert.equal(body.workspace.projectId, project.id);
    assert.ok(body.workspace.id);
    assert.ok(body.workspace.createdAt);
    assert.ok(body.workspace.updatedAt);
  } finally {
    await teardown(h);
  }
});

test("GET /projects/:projectId/workspace: 404 for a non-owner (a real second authenticated user)", async () => {
  const h = await setupHarness("workspace-non-owner", createSelfFixDemoEngine());
  try {
    const { project } = await json<{ project: { id: string } }>(
      await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture" }),
      }),
    );

    const otherClient = await registerClient(h.baseUrl, "workspace-non-owner-other");
    const res = await otherClient.fetch(`/projects/${project.id}/workspace`);
    assert.equal(res.status, 404);
    const body = await json<{ error: { code: string } }>(res);
    assert.equal(body.error.code, "NOT_FOUND");
  } finally {
    await teardown(h);
  }
});

test("GET /projects/:projectId/workspace: 404 for an unknown projectId", async () => {
  const h = await setupHarness("workspace-unknown", createSelfFixDemoEngine());
  try {
    const res = await h.client.fetch("/projects/00000000-0000-0000-0000-000000000000/workspace");
    assert.equal(res.status, 404);
  } finally {
    await teardown(h);
  }
});
