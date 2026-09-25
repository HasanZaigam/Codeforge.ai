import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform, type Platform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { registerClient, type AuthedClient } from "./helpers/auth-client.js";
import { DEFAULT_PATHS, ScriptedEngine, fakeStructure, json, validAnalysis, type Respond } from "./helpers/backlog-harness.js";

/**
 * Phase 4A — the HTTP surface of Backlog Intelligence (see /docs/API.md "Backlog"): authentication,
 * ownership (IDOR), strict request validation, error codes, DTO shape, and the full flow over real
 * HTTP with real sessions. Model calls are always the scripted engine — never a real provider.
 */

interface Harness {
  platform: Platform;
  engine: ScriptedEngine;
  server: Server;
  baseUrl: string;
  a: AuthedClient;
  b: AuthedClient;
  projectId: string;
}

async function setup(label: string, respond?: Respond): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `backlog-api-${label}-`));
  const engine = new ScriptedEngine(respond ?? (() => json(validAnalysis())));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    projectWorkspacesRoot: join(root, "project-workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
  });
  const repoPath = await createFixtureRepo(root);
  const app = buildApp(platform);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const a = await registerClient(baseUrl, `${label}-a`);
  const b = await registerClient(baseUrl, `${label}-b`);
  const res = await a.fetch("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Jinvani", sourceControlProvider: "local-git", repoUrl: repoPath, codingEngine: "fixture", commands: { test: "node test.js" } }),
  });
  assert.equal(res.status, 201);
  const { project } = (await res.json()) as { project: { id: string } };
  return { platform, engine, server, baseUrl, a, b, projectId: project.id };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function withServer(label: string, respond: Respond | undefined, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setup(label, respond);
  try {
    await fn(h);
  } finally {
    // Let any in-flight background analysis settle before the DB closes.
    await new Promise((r) => setTimeout(r, 50));
    await teardown(h);
  }
}

const post = (c: AuthedClient, path: string, body: unknown = {}) => c.fetch(path, { method: "POST", body: JSON.stringify(body) });
const patch = (c: AuthedClient, path: string, body: unknown) => c.fetch(path, { method: "PATCH", body: JSON.stringify(body) });
async function body<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createItem(h: Harness, client: AuthedClient, title = "OTP can be requested unlimited times", externalRef?: string) {
  const res = await post(client, `/projects/${h.projectId}/backlog`, { title, description: "Users can spam OTP requests.", ...(externalRef ? { externalRef } : {}) });
  assert.equal(res.status, 201, await res.clone().text());
  return (await body<{ item: { id: string; status: string } }>(res)).item;
}

/**
 * The API process only ENQUEUES analysis. In production a separate worker process claims and runs
 * the job; here `platform.backlogRunner.drain()` plays that worker — deliberately called from the
 * TEST, never from the server — and then the HTTP surface is read like a polling client would.
 */
async function waitWhileAnalyzing(h: Harness, client: AuthedClient, itemId: string): Promise<string> {
  await h.platform.backlogRunner.drain();
  const detail = await body<{ item: { status: string } }>(await client.fetch(`/backlog/${itemId}`));
  return detail.item.status;
}

async function approvedProposal(h: Harness, client: AuthedClient, itemId: string): Promise<string> {
  assert.equal((await post(client, `/backlog/${itemId}/analyze`)).status, 202);
  assert.equal(await waitWhileAnalyzing(h, client, itemId), "ANALYZED");
  const gen = await post(client, `/backlog/${itemId}/proposal`);
  assert.equal(gen.status, 201);
  const { proposal } = await body<{ proposal: { id: string } }>(gen);
  assert.equal((await post(client, `/task-proposals/${proposal.id}/approve`)).status, 200);
  return proposal.id;
}

// ===========================================================================
// Authentication
// ===========================================================================

test("every backlog and task-proposal route requires authentication (401, no data)", async () => {
  await withServer("unauth", undefined, async (h) => {
    const item = await createItem(h, h.a);
    const proposalId = await approvedProposal(h, h.a, item.id);
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/projects/${h.projectId}/backlog`],
      ["POST", `/projects/${h.projectId}/backlog`, { title: "x", description: "y" }],
      ["GET", `/backlog/${item.id}`],
      ["PATCH", `/backlog/${item.id}`, { title: "x" }],
      ["POST", `/backlog/${item.id}/reject`, {}],
      ["POST", `/backlog/${item.id}/analyze`, {}],
      ["POST", `/backlog/${item.id}/analysis/cancel`, {}],
      ["GET", `/backlog/${item.id}/analysis`],
      ["GET", `/backlog/${item.id}/relationships`],
      ["POST", `/backlog/${item.id}/proposal`, {}],
      ["GET", `/task-proposals/${proposalId}`],
      ["POST", `/task-proposals/${proposalId}/approve`, {}],
      ["POST", `/task-proposals/${proposalId}/reject`, {}],
      ["POST", `/task-proposals/${proposalId}/convert`, {}],
    ];
    for (const [method, path, payload] of routes) {
      const res = await fetch(`${h.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
      assert.equal(res.status, 401, `${method} ${path}`);
      const text = await res.text();
      assert.ok(!text.includes("OTP can be requested"), `${method} ${path} must not leak data`);
    }
    // ...and none of those unauthenticated attempts changed anything.
    assert.equal((await h.platform.tasks.listByProject(h.projectId)).length, 0);
  });
});

// ===========================================================================
// Ownership / IDOR
// ===========================================================================

test("IDOR: another user gets an identical 404 for every route on someone else's project, item and proposal — and changes nothing", async () => {
  await withServer("idor", undefined, async (h) => {
    const item = await createItem(h, h.a);
    const proposalId = await approvedProposal(h, h.a, item.id);
    const missing = "00000000-0000-4000-8000-000000000000";

    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `/projects/${h.projectId}/backlog`],
      ["POST", `/projects/${h.projectId}/backlog`, { title: "intruder", description: "intruder" }],
      ["GET", `/backlog/${item.id}`],
      ["PATCH", `/backlog/${item.id}`, { title: "hacked" }],
      ["POST", `/backlog/${item.id}/reject`, {}],
      ["POST", `/backlog/${item.id}/analyze`, {}],
      ["POST", `/backlog/${item.id}/analysis/cancel`, {}],
      ["GET", `/backlog/${item.id}/analysis`],
      ["GET", `/backlog/${item.id}/relationships`],
      ["POST", `/backlog/${item.id}/proposal`, {}],
      ["GET", `/task-proposals/${proposalId}`],
      ["POST", `/task-proposals/${proposalId}/approve`, {}],
      ["POST", `/task-proposals/${proposalId}/reject`, {}],
      ["POST", `/task-proposals/${proposalId}/convert`, {}],
    ];
    for (const [method, path, payload] of attempts) {
      const res = await h.b.fetch(path, { method, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
      assert.equal(res.status, 404, `${method} ${path}`);
      const err = await body<{ error: { code: string } }>(res);
      assert.equal(err.error.code, "NOT_FOUND", `${method} ${path}`);
      // The same request for a genuinely nonexistent id looks identical (existence is never confirmed).
      const missingPath = path.replace(item.id, missing).replace(proposalId, missing).replace(h.projectId, missing);
      const missingRes = await h.a.fetch(missingPath, { method, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
      assert.equal(missingRes.status, 404, `missing: ${method} ${missingPath}`);
    }

    // Nothing the intruder tried changed anything.
    const detail = await body<{ item: { title: string; status: string } }>(await h.a.fetch(`/backlog/${item.id}`));
    assert.equal(detail.item.title, "OTP can be requested unlimited times");
    assert.equal(detail.item.status, "READY_FOR_TASK");
    const list = await body<{ items: unknown[] }>(await h.a.fetch(`/projects/${h.projectId}/backlog`));
    assert.equal(list.items.length, 1, "the intruder's POST created no item in A's project");
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0);
    assert.equal((await body<{ proposal: { status: string } }>(await h.a.fetch(`/task-proposals/${proposalId}`))).proposal.status, "APPROVED");
  });
});

test("a user only ever sees their own projects' backlog items in listings", async () => {
  await withServer("isolation", undefined, async (h) => {
    await createItem(h, h.a, "A's item");
    const bRepo = await createFixtureRepo(await mkdtemp(join(tmpdir(), "backlog-api-iso-b-")));
    const bProject = await body<{ project: { id: string } }>(
      await post(h.b, "/projects", { name: "B project", sourceControlProvider: "local-git", repoUrl: bRepo, codingEngine: "fixture" }),
    );
    const bItem = await post(h.b, `/projects/${bProject.project.id}/backlog`, { title: "B's item", description: "d" });
    assert.equal(bItem.status, 201);
    const aList = await body<{ items: Array<{ title: string }> }>(await h.a.fetch(`/projects/${h.projectId}/backlog`));
    const bList = await body<{ items: Array<{ title: string }> }>(await h.b.fetch(`/projects/${bProject.project.id}/backlog`));
    assert.deepEqual(aList.items.map((i) => i.title), ["A's item"]);
    assert.deepEqual(bList.items.map((i) => i.title), ["B's item"]);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

test("request bodies are STRICT: unknown keys (status, projectId, taskId, approved…) and out-of-range values are 400", async () => {
  await withServer("validation", undefined, async (h) => {
    const create = (payload: unknown) => post(h.a, `/projects/${h.projectId}/backlog`, payload);
    const bad: unknown[] = [
      {},
      { title: "x" },
      { description: "x" },
      { title: "", description: "x" },
      { title: "   ", description: "x" },
      { title: "x".repeat(301), description: "d" },
      { title: "t", description: "d".repeat(10_001) },
      { title: "t", description: "d", externalRef: "has spaces!" },
      { title: "t", description: "d", externalRef: "x".repeat(65) },
      { title: "t", description: "d", status: "CONVERTED" },
      { title: "t", description: "d", projectId: "other" },
      { title: "t", description: "d", source: "import" },
      { title: "t", description: "d", createdBy: "someone" },
    ];
    for (const payload of bad) {
      const res = await create(payload);
      assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 80));
      assert.equal((await body<{ error: { code: string } }>(res)).error.code, "INVALID_REQUEST");
    }
    assert.equal((await body<{ items: unknown[] }>(await h.a.fetch(`/projects/${h.projectId}/backlog`))).items.length, 0, "no rejected request created anything");

    const item = await createItem(h, h.a);
    for (const payload of [{}, { status: "CONVERTED" }, { title: "" }, { title: "ok", taskId: "x" }, { externalRef: "bad ref" }, { description: "d".repeat(10_001) }]) {
      const res = await patch(h.a, `/backlog/${item.id}`, payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
    }
    // Every action endpoint refuses any body content at all.
    const proposalId = await approvedProposal(h, h.a, (await createItem(h, h.a, "second", "SEC-2")).id);
    for (const path of [`/backlog/${item.id}/analyze`, `/backlog/${item.id}/analysis/cancel`, `/backlog/${item.id}/reject`, `/backlog/${item.id}/proposal`, `/task-proposals/${proposalId}/approve`, `/task-proposals/${proposalId}/reject`, `/task-proposals/${proposalId}/convert`]) {
      for (const payload of [{ status: "CONVERTED" }, { approved: true }, { taskId: "x" }, { retryLimit: 99 }]) {
        const res = await post(h.a, path, payload);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(payload)}`);
      }
    }
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0);

    const malformed = await h.a.fetch(`/projects/${h.projectId}/backlog`, { method: "POST", body: "{not json" });
    assert.equal(malformed.status, 400);
  });
});

// ===========================================================================
// The flow over HTTP
// ===========================================================================

test("full flow over HTTP: create -> analyze (202, async) -> analysis -> proposal -> approve -> convert -> an ordinary BACKLOG Task exists", async () => {
  await withServer("flow", () => json(validAnalysis({ candidateFiles: [{ path: "src/auth/otp.js", reason: "otp" }, { path: "src/nope.js", reason: "guess" }] })), async (h) => {
    const item = await createItem(h, h.a, "OTP can be requested unlimited times", "BUG-002");
    assert.equal(item.status, "NEW");

    const analyze = await post(h.a, `/backlog/${item.id}/analyze`);
    assert.equal(analyze.status, 202, "analysis is only ENQUEUED by the API");
    const queued = await body<{ item: { status: string }; job: { id: string; status: string; attemptCount: number; maxAttempts: number }; enqueued: boolean }>(analyze);
    assert.equal(queued.item.status, "ANALYZING");
    assert.equal(queued.job.status, "QUEUED");
    assert.equal(queued.job.attemptCount, 0);
    assert.equal(queued.enqueued, true);
    assert.equal(h.engine.calls.length, 0, "no model was called inside the API request (or anywhere in the API process)");
    const detailWhileQueued = await body<{ analysisJob: { id: string; status: string } | null }>(await h.a.fetch(`/backlog/${item.id}`));
    assert.deepEqual([detailWhileQueued.analysisJob?.id, detailWhileQueued.analysisJob?.status], [queued.job.id, "QUEUED"], "polling shows the queued job");
    assert.equal(await waitWhileAnalyzing(h, h.a, item.id), "ANALYZED");
    const finishedJob = (await body<{ analysisJob: any }>(await h.a.fetch(`/backlog/${item.id}`))).analysisJob;
    assert.equal(finishedJob.status, "SUCCEEDED");
    assert.equal(finishedJob.attemptCount, 1);
    assert.ok(finishedJob.analysisId);
    assert.ok(!("claimOwner" in finishedJob) && !("lockGeneration" in finishedJob) && !("leaseExpiresAt" in finishedJob));

    const analysis = (await body<{ analysis: any }>(await h.a.fetch(`/backlog/${item.id}/analysis`))).analysis;
    assert.equal(analysis.status, "succeeded");
    assert.equal(analysis.result.issueType, "bug");
    assert.deepEqual(analysis.platformChecks.candidateFiles.map((f: any) => f.existsInRepository), [true, false]);
    assert.equal(typeof analysis.durationMs, "number");
    assert.ok(!("claimId" in analysis) && !("analysis_claim_id" in analysis));

    const relationships = await body<{ relationships: unknown[] }>(await h.a.fetch(`/backlog/${item.id}/relationships`));
    assert.deepEqual(relationships.relationships, []);

    const gen = await post(h.a, `/backlog/${item.id}/proposal`);
    assert.equal(gen.status, 201);
    const generated = await body<{ proposal: any; created: boolean }>(gen);
    assert.equal(generated.created, true);
    assert.equal(generated.proposal.status, "PENDING");
    assert.equal(generated.proposal.taskId, null);
    const again = await post(h.a, `/backlog/${item.id}/proposal`);
    assert.equal(again.status, 200, "idempotent: the existing proposal is returned");
    assert.equal((await body<{ proposal: { id: string } }>(again)).proposal.id, generated.proposal.id);
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0, "no Task until approval + conversion");

    // convert before approval is a 409, never an implicit approval
    const early = await post(h.a, `/task-proposals/${generated.proposal.id}/convert`);
    assert.equal(early.status, 409);
    assert.equal((await body<{ error: { code: string } }>(early)).error.code, "INVALID_OPERATION");

    const approve = await post(h.a, `/task-proposals/${generated.proposal.id}/approve`);
    assert.equal(approve.status, 200);
    assert.equal((await body<{ proposal: { status: string } }>(approve)).proposal.status, "APPROVED");
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0, "approval alone creates no Task");

    const convert = await post(h.a, `/task-proposals/${generated.proposal.id}/convert`);
    assert.equal(convert.status, 201);
    const converted = await body<{ proposal: any; task: any; alreadyConverted: boolean }>(convert);
    assert.equal(converted.alreadyConverted, false);
    assert.equal(converted.proposal.status, "CONVERTED");
    assert.equal(converted.proposal.taskId, converted.task.id);
    assert.equal(converted.task.status, "BACKLOG", "the resulting Task still needs an explicit human Start");
    assert.equal(converted.task.title, "OTP can be requested unlimited times");
    assert.match(converted.task.description, /Backlog reference: BUG-002/);

    const again2 = await post(h.a, `/task-proposals/${generated.proposal.id}/convert`);
    assert.equal(again2.status, 200);
    const idempotent = await body<{ task: { id: string }; alreadyConverted: boolean }>(again2);
    assert.equal(idempotent.alreadyConverted, true);
    assert.equal(idempotent.task.id, converted.task.id);

    // It is a normal Task through the normal API.
    const tasks = await body<{ tasks: Array<{ id: string; status: string }> }>(await h.a.fetch(`/projects/${h.projectId}/tasks`));
    assert.deepEqual(tasks.tasks.map((t) => [t.id, t.status]), [[converted.task.id, "BACKLOG"]]);
    assert.equal((await h.a.fetch(`/tasks/${converted.task.id}`)).status, 200);
    assert.equal((await h.b.fetch(`/tasks/${converted.task.id}`)).status, 404);

    // The item is CONVERTED and the activity trail tells the whole story.
    const detail = await body<{ item: { status: string }; events: Array<{ type: string }>; proposal: { status: string; taskId: string } }>(await h.a.fetch(`/backlog/${item.id}`));
    assert.equal(detail.item.status, "CONVERTED");
    assert.equal(detail.proposal.taskId, converted.task.id);
    assert.deepEqual(detail.events.map((e) => e.type), [
      "BACKLOG_ITEM_CREATED", "ANALYSIS_QUEUED", "ANALYSIS_STARTED", "ANALYSIS_COMPLETED", "TASK_PROPOSAL_GENERATED", "TASK_PROPOSAL_APPROVED", "TASK_PROPOSAL_CONVERTED",
    ]);
    // Nothing ever ran a coding agent for the task: only the ONE analysis invocation happened.
    assert.equal(h.engine.calls.length, 1);
  });
});

test("DTOs expose only the public shape — no creator id, claim/lease columns, or reserved task id", async () => {
  await withServer("dto", undefined, async (h) => {
    const item = await createItem(h, h.a, "x", "DTO-1");
    const proposalId = await approvedProposal(h, h.a, item.id);
    await post(h.a, `/task-proposals/${proposalId}/convert`);

    const raw = await h.a.fetch(`/backlog/${item.id}`);
    const detail = await body<any>(raw);
    assert.deepEqual(Object.keys(detail.item).sort(), ["createdAt", "description", "externalRef", "id", "projectId", "source", "status", "title", "updatedAt"]);
    const serialized = JSON.stringify(detail) + JSON.stringify(await body(await h.a.fetch(`/task-proposals/${proposalId}`)));
    for (const forbidden of ["analysis_claim", "analysisClaim", "lease", "reserved", "conversion_claim", "createdBy", "decidedBy", "status_before"]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not be exposed`);
    }
    const list = await body<{ items: Array<Record<string, unknown>> }>(await h.a.fetch(`/projects/${h.projectId}/backlog`));
    assert.deepEqual(Object.keys(list.items[0]!).sort(), ["createdAt", "description", "externalRef", "id", "latestAnalysis", "projectId", "proposal", "source", "status", "title", "updatedAt"]);
  });
});

// ===========================================================================
// Error codes for state conflicts
// ===========================================================================

test("state conflicts map to specific 409 codes, and repeated analyze requests are idempotent (202, same job)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await withServer("conflicts", async () => { await gate; return json(validAnalysis()); }, async (h) => {
    await createItem(h, h.a, "first", "REF-1");
    const dup = await post(h.a, `/projects/${h.projectId}/backlog`, { title: "second", description: "d", externalRef: "ref-1" });
    assert.equal(dup.status, 409);
    assert.equal((await body<{ error: { code: string } }>(dup)).error.code, "DUPLICATE_BACKLOG_REFERENCE");

    const item = await createItem(h, h.a, "slow", "REF-2");
    const first = await post(h.a, `/backlog/${item.id}/analyze`);
    assert.equal(first.status, 202);
    const firstBody = await body<{ job: { id: string }; enqueued: boolean }>(first);
    for (let n = 0; n < 3; n++) {
      const again = await post(h.a, `/backlog/${item.id}/analyze`);
      assert.equal(again.status, 202, "a repeated request is not an error");
      const againBody = await body<{ job: { id: string }; enqueued: boolean }>(again);
      assert.equal(againBody.job.id, firstBody.job.id);
      assert.equal(againBody.enqueued, false);
    }
    // Start it on the "worker" (without waiting), then repeat while RUNNING.
    await h.platform.backlogRunner.tick();
    for (let i = 0; i < 100 && h.engine.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const running = await body<{ job: { id: string; status: string }; enqueued: boolean }>(await post(h.a, `/backlog/${item.id}/analyze`));
    assert.deepEqual([running.job.id, running.job.status, running.enqueued], [firstBody.job.id, "RUNNING", false]);

    const edit = await patch(h.a, `/backlog/${item.id}`, { title: "during analysis" });
    assert.equal(edit.status, 409);
    assert.equal((await body<{ error: { code: string } }>(edit)).error.code, "INVALID_OPERATION");
    assert.equal((await post(h.a, `/backlog/${item.id}/proposal`)).status, 409, "no proposal while ANALYZING");
    release();
    assert.equal(await waitWhileAnalyzing(h, h.a, item.id), "ANALYZED");
    assert.equal(h.engine.calls.length, 1, "all of those requests produced exactly one model call");
  });
});

test("HTTP: cancelling a queued analysis is immediate; cancelling with nothing live is a 409; a cancelled item can be analyzed again", async () => {
  await withServer("http-cancel", undefined, async (h) => {
    const item = await createItem(h, h.a);
    assert.equal((await post(h.a, `/backlog/${item.id}/analysis/cancel`)).status, 409, "nothing to cancel yet");
    await post(h.a, `/backlog/${item.id}/analyze`);
    const cancel = await post(h.a, `/backlog/${item.id}/analysis/cancel`);
    assert.equal(cancel.status, 202);
    const cancelled = await body<{ item: { status: string }; job: { status: string } }>(cancel);
    assert.deepEqual([cancelled.item.status, cancelled.job.status], ["NEW", "CANCELLED"]);
    await h.platform.backlogRunner.drain();
    assert.equal(h.engine.calls.length, 0, "a cancelled job is never run");
    const again = await post(h.a, `/backlog/${item.id}/analyze`);
    assert.equal(again.status, 202);
    assert.equal((await body<{ enqueued: boolean }>(again)).enqueued, true);
    assert.equal(await waitWhileAnalyzing(h, h.a, item.id), "ANALYZED");
  });
});

test("HTTP: a failed job is visible as FAILED (with category and reason) and the item returns to its previous status", async () => {
  await withServer("http-failed", () => { throw new Error("upstream exploded"); }, async (h) => {
    const item = await createItem(h, h.a);
    await post(h.a, `/backlog/${item.id}/analyze`);
    assert.equal(await waitWhileAnalyzing(h, h.a, item.id), "NEW");
    const detail = await body<{ analysisJob: any; latestAnalysis: any }>(await h.a.fetch(`/backlog/${item.id}`));
    assert.equal(detail.analysisJob.status, "FAILED");
    assert.equal(detail.analysisJob.failureCategory, "engine_error");
    assert.match(detail.analysisJob.failureReason, /upstream exploded/);
    assert.equal(detail.latestAnalysis.status, "failed");
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0);
  });
});

test("HTTP: malformed AI output surfaces as a failed analysis + NEEDS_CLARIFICATION and no proposal can be generated", async () => {
  await withServer("http-malformed", () => json(validAnalysis({ status: "CONVERTED", taskId: "abc" })), async (h) => {
    const item = await createItem(h, h.a);
    await post(h.a, `/backlog/${item.id}/analyze`);
    assert.equal(await waitWhileAnalyzing(h, h.a, item.id), "NEEDS_CLARIFICATION");
    const analysis = (await body<{ analysis: any }>(await h.a.fetch(`/backlog/${item.id}/analysis`))).analysis;
    assert.equal(analysis.status, "failed");
    assert.equal(analysis.failureCategory, "malformed_output");
    assert.equal(analysis.result, null);
    const gen = await post(h.a, `/backlog/${item.id}/proposal`);
    assert.equal(gen.status, 409);
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0);
  });
});

test("HTTP: editing and rejecting follow the lifecycle rules", async () => {
  await withServer("http-lifecycle", undefined, async (h) => {
    const item = await createItem(h, h.a, "orig", "L-1");
    const edited = await patch(h.a, `/backlog/${item.id}`, { title: "renamed", externalRef: null });
    assert.equal(edited.status, 200);
    const { item: after } = await body<{ item: { title: string; externalRef: string | null } }>(edited);
    assert.equal(after.title, "renamed");
    assert.equal(after.externalRef, null);

    const rejected = await post(h.a, `/backlog/${item.id}/reject`);
    assert.equal(rejected.status, 200);
    assert.equal((await body<{ item: { status: string } }>(rejected)).item.status, "REJECTED");
    assert.equal((await post(h.a, `/backlog/${item.id}/reject`)).status, 200, "idempotent");
    assert.equal((await post(h.a, `/backlog/${item.id}/analyze`)).status, 409, "a rejected item cannot be analyzed");
    assert.equal((await patch(h.a, `/backlog/${item.id}`, { title: "again" })).status, 409);
  });
});

test("HTTP: simultaneous conversions create exactly one Task", async () => {
  await withServer("http-convert-race", undefined, async (h) => {
    const item = await createItem(h, h.a);
    const proposalId = await approvedProposal(h, h.a, item.id);
    const responses = await Promise.all([1, 2, 3, 4].map(() => post(h.a, `/task-proposals/${proposalId}/convert`)));
    for (const res of responses) assert.ok([200, 201, 409].includes(res.status), `unexpected ${res.status}`);
    assert.ok(responses.some((r) => r.status === 201 || r.status === 200));
    for (const res of responses.filter((r) => r.status === 409)) {
      assert.equal((await body<{ error: { code: string } }>(res)).error.code, "CONVERSION_IN_PROGRESS");
    }
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 1);
  });
});

test("HTTP: rejecting a proposal returns the item to ANALYZED so a fresh proposal can be generated", async () => {
  await withServer("http-proposal-reject", undefined, async (h) => {
    const item = await createItem(h, h.a);
    const proposalId = await approvedProposal(h, h.a, item.id);
    const rejected = await post(h.a, `/task-proposals/${proposalId}/reject`);
    assert.equal(rejected.status, 200);
    assert.equal((await body<{ proposal: { status: string } }>(rejected)).proposal.status, "REJECTED");
    assert.equal((await body<{ item: { status: string } }>(await h.a.fetch(`/backlog/${item.id}`))).item.status, "ANALYZED");
    assert.equal((await post(h.a, `/task-proposals/${proposalId}/approve`)).status, 409);
    assert.equal((await post(h.a, `/task-proposals/${proposalId}/convert`)).status, 409);
    const fresh = await post(h.a, `/backlog/${item.id}/proposal`);
    assert.equal(fresh.status, 201);
    assert.notEqual((await body<{ proposal: { id: string } }>(fresh)).proposal.id, proposalId);
    assert.equal(h.platform.tasks.listByProject(h.projectId).length, 0);
  });
});

// ===========================================================================
// Phase 4A.2 — evidence and usage over the HTTP contract
// ===========================================================================

test("HTTP: the analysis separates the AI's claims from the platform's evidence and assessment, and reports usage/cost honestly (null, never zero)", async () => {
  const respond = () =>
    json(validAnalysis({
      claims: [{ statement: "OTP throttling does not exist.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "low" }],
    }));
  const root = await mkdtemp(join(tmpdir(), "backlog-api-evidence-"));
  const engine = new ScriptedEngine(respond);
  engine.cost = { inputTokens: 12446, outputTokens: 349, reasoningTokens: 1150 }; // no cache figures, no price
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    projectWorkspacesRoot: join(root, "project-workspaces"),
    engine,
    ownerId: "evidence-api",
    repositoryStructureProvider: fakeStructure({ "backend/services/otpThrottle.ts": "export function evaluateOtpThrottle() {}\n", "README.md": "# x\n" }),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  try {
    const client = await registerClient(`http://127.0.0.1:${address.port}`, "ev");
    const repo = await createFixtureRepo(root);
    const project = (await body<{ project: { id: string } }>(await client.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "P", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture" }) }))).project;
    const item = (await body<{ item: { id: string } }>(await post(client, `/projects/${project.id}/backlog`, { title: "OTP limit", description: "d", externalRef: "E-1" }))).item;
    await post(client, `/backlog/${item.id}/analyze`);
    await platform.backlogRunner.drain();

    const analysis = (await body<{ analysis: any }>(await client.fetch(`/backlog/${item.id}/analysis`))).analysis;
    // AI analysis (claims are the model's assertions)...
    assert.equal(analysis.result.claims[0].statement, "OTP throttling does not exist.");
    assert.ok(!("status" in analysis.result.claims[0]) && !("evidence" in analysis.result.claims[0]), "the AI's claim carries no verdict or evidence");
    // ...platform evidence and the deterministic assessment are a SEPARATE object.
    const assessment = analysis.platformChecks.assessment;
    assert.equal(assessment.claims[0].status, "CONTRADICTED");
    assert.equal(assessment.claims[0].aiConfidence, "low");
    assert.ok(assessment.evidence.some((e: any) => e.type === "PATH_MATCH" && e.path === "backend/services/otpThrottle.ts"));
    assert.equal(assessment.inspection.listing, "complete");
    // Usage: reported fields as numbers, unreported as null (NOT 0); no price ⇒ estimatedCost null.
    assert.deepEqual(analysis.usage, { inputTokens: 12446, outputTokens: 349, reasoningTokens: 1150, cacheReadTokens: null, cacheWriteTokens: null });
    assert.equal(analysis.estimatedCost, null);
    assert.ok(!("cost" in analysis), "the raw cost blob is no longer exposed");
    assert.equal(analysis.providerId, null);
    assert.equal(analysis.engineKey, "fixture");

    // A proposal generated from it carries the assessment, framed as an investigation.
    const gen = await body<{ proposal: any }>(await post(client, `/backlog/${item.id}/proposal`));
    assert.equal(gen.proposal.content.investigateFirst, true);
    assert.equal(gen.proposal.content.claimAssessments[0].status, "CONTRADICTED");
    assert.equal(gen.proposal.status, "PENDING");
  } finally {
    await platform.backlogRunner.stop();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});

test("HTTP: an analysis with no usage reported has usage null and estimatedCost null", async () => {
  await withServer("usage-null", undefined, async (h) => {
    h.engine.cost = null;
    const item = await createItem(h, h.a);
    await post(h.a, `/backlog/${item.id}/analyze`);
    assert.equal(await waitWhileAnalyzing(h, h.a, item.id), "ANALYZED");
    const analysis = (await body<{ analysis: any }>(await h.a.fetch(`/backlog/${item.id}/analysis`))).analysis;
    assert.equal(analysis.usage, null);
    assert.equal(analysis.estimatedCost, null);
  });
});
