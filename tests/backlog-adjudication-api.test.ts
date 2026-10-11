import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { registerClient } from "./helpers/auth-client.js";
import { DEFAULT_PATHS, ScriptedEngine, fakeStructure, json, validAnalysis } from "./helpers/backlog-harness.js";

const CSV = "Bug Id,Bug title,Description\nB-1,First bug,First description\nB-2,Second bug,Second description\n";

test("HTTP adjudication: owner-only sampling/judging/metrics/export; strict bodies; a client can never supply an analysisId or revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "adj-api-"));
  const engine = new ScriptedEngine(() => json(validAnalysis()));
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "w"), projectWorkspacesRoot: join(root, "pw"), engine, ownerId: "w", repositoryStructureProvider: fakeStructure(DEFAULT_PATHS) });
  const repo = await createFixtureRepo(root);
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const a = await registerClient(base, "adj-a");
    const b = await registerClient(base, "adj-b");
    const created = await a.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "J", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture", commands: { test: "node test.js" } }) });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;
    const post = (c: typeof a, path: string, body: unknown = {}) => c.fetch(path, { method: "POST", body: JSON.stringify(body) });

    await post(a, `/projects/${pid}/backlog/imports`, { csv: CSV, sourceName: "S" });
    const start = await post(a, `/projects/${pid}/backlog/bulk-analysis`, { itemIds: (await (await a.fetch(`/projects/${pid}/backlog/review`)).json() as { rows: Array<{ itemId: string }> }).rows.map((r) => r.itemId) });
    void start;
    await new Promise((r) => setTimeout(r, 50));
    await platform.backlogRunner.drain();

    // unauthenticated
    assert.equal((await fetch(`${base}/projects/${pid}/backlog/adjudication/metrics`)).status, 401);

    // sampling: bad query is 400, missing seed/size is 400
    assert.equal((await a.fetch(`/projects/${pid}/backlog/adjudication/sample/clarification`)).status, 400);
    assert.equal((await a.fetch(`/projects/${pid}/backlog/adjudication/sample/clarification?seed=s&size=0`)).status, 400);
    const sample = await a.fetch(`/projects/${pid}/backlog/adjudication/sample/proposal-ready?seed=fixed&size=5`);
    assert.equal(sample.status, 200);
    const { sampled } = (await sample.json()) as { sampled: Array<{ row: { itemId: string } }> };

    // owner-only
    assert.equal((await b.fetch(`/projects/${pid}/backlog/adjudication/sample/clarification?seed=s&size=5`)).status, 404);
    assert.equal((await b.fetch(`/projects/${pid}/backlog/adjudication/metrics`)).status, 404);
    assert.equal((await b.fetch(`/projects/${pid}/backlog/adjudication/export`)).status, 404);

    if (sampled.length > 0) {
      const itemId = sampled[0]!.row.itemId;
      // a body can never carry analysisId/revision — it is a 400 (strict schema)
      assert.equal((await post(a, `/backlog/items/${itemId}/judgments`, { category: "PROPOSAL_READINESS", label: "CORRECT_PROPOSAL_READY", analysisId: "x" })).status, 400);
      // a label from the WRONG category is rejected
      assert.equal((await post(a, `/backlog/items/${itemId}/judgments`, { category: "PROPOSAL_READINESS", label: "CORRECT_CLARIFICATION" })).status, 400);
      const ok = await post(a, `/backlog/items/${itemId}/judgments`, { category: "PROPOSAL_READINESS", label: "CORRECT_PROPOSAL_READY", note: "looks right" });
      assert.equal(ok.status, 201);
      assert.equal((await b.fetch(`/backlog/items/${itemId}/judgments?category=PROPOSAL_READINESS`)).status, 404);
      const listed = (await (await a.fetch(`/backlog/items/${itemId}/judgments?category=PROPOSAL_READINESS`)).json()) as { judgments: unknown[] };
      assert.equal(listed.judgments.length, 1);
    }

    const metrics = await (await a.fetch(`/projects/${pid}/backlog/adjudication/metrics`)).json() as { duplicates: unknown };
    assert.ok(metrics.duplicates);

    const exp = await a.fetch(`/projects/${pid}/backlog/adjudication/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-type") ?? "", /text\/csv/);
    const csvText = await exp.text();
    assert.match(csvText, /^kind,projectId,backlogItemId/);
  } finally {
    await platform.backgroundRunner.stop();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});

test("HTTP adjudication import/baseline: owner-only, strict bodies, per-row isolation, immutable baseline snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "adj-api2-"));
  const engine = new ScriptedEngine(() => json(validAnalysis()));
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "w"), projectWorkspacesRoot: join(root, "pw"), engine, ownerId: "w", repositoryStructureProvider: fakeStructure(DEFAULT_PATHS) });
  const repo = await createFixtureRepo(root);
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const a = await registerClient(base, "adj2-a");
    const b = await registerClient(base, "adj2-b");
    const created = await a.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "J", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture", commands: { test: "node test.js" } }) });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;
    const post = (c: typeof a, path: string, body: unknown = {}) => c.fetch(path, { method: "POST", body: JSON.stringify(body) });

    await post(a, `/projects/${pid}/backlog/imports`, { csv: CSV, sourceName: "S" });
    const items = (await (await a.fetch(`/projects/${pid}/backlog/review`)).json() as { rows: Array<{ itemId: string }> }).rows;
    await post(a, `/projects/${pid}/backlog/bulk-analysis`, { itemIds: items.map((r) => r.itemId) });
    await platform.backlogRunner.drain();

    // strict body: unknown field is 400
    assert.equal((await post(a, `/projects/${pid}/backlog/adjudication/import`, { csv: "x", analysisId: "y" })).status, 400);
    // owner-only
    assert.equal((await post(b, `/projects/${pid}/backlog/adjudication/import`, { csv: "kind,targetId,category,context,ai,label,note\n" })).status, 404);
    assert.equal((await post(b, `/projects/${pid}/backlog/adjudication/baselines`, { seed: "s", duplicateSize: 1, clarificationSize: 1, proposalReadySize: 1 })).status, 404);

    const csvBody = ["kind,targetId,category,context,aiConfidenceOrState,label,note", `item,${items[0]!.itemId},PROPOSAL_READINESS,ctx,state,CORRECT_PROPOSAL_READY,ok`].join("\n");
    const imp = await post(a, `/projects/${pid}/backlog/adjudication/import`, { csv: csvBody });
    assert.equal(imp.status, 200);
    assert.equal(((await imp.json()) as { imported: number }).imported, 1);

    const baseline1 = await post(a, `/projects/${pid}/backlog/adjudication/baselines`, { seed: "s1", duplicateSize: 5, clarificationSize: 5, proposalReadySize: 5 });
    assert.equal(baseline1.status, 201);
    const b1 = ((await baseline1.json()) as { baseline: { id: string; version: number; metrics: { coverage: { labelsCollected: number } } } }).baseline;
    assert.equal(b1.version, 1);
    // judge more, then re-fetch the SAME baseline — must be unchanged
    await post(a, `/backlog/items/${items[1]!.itemId}/judgments`, { category: "PROPOSAL_READINESS", label: "CORRECT_PROPOSAL_READY" });
    const reread = await (await a.fetch(`/backlog/adjudication/baselines/${b1.id}`)).json() as { baseline: { metrics: { coverage: { labelsCollected: number } } } };
    assert.equal(reread.baseline.metrics.coverage.labelsCollected, b1.metrics.coverage.labelsCollected, "baseline snapshot is immutable");
    assert.equal((await b.fetch(`/backlog/adjudication/baselines/${b1.id}`)).status, 404);

    const baseline2 = await post(a, `/projects/${pid}/backlog/adjudication/baselines`, { seed: "s1", duplicateSize: 5, clarificationSize: 5, proposalReadySize: 5 });
    const b2 = ((await baseline2.json()) as { baseline: { version: number } }).baseline;
    assert.equal(b2.version, 2, "a fresh, separately versioned snapshot");
    const list = (await (await a.fetch(`/projects/${pid}/backlog/adjudication/baselines`)).json()) as { baselines: Array<{ version: number }> };
    assert.deepEqual(list.baselines.map((x) => x.version), [2, 1]);
  } finally {
    await platform.backgroundRunner.stop();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});

test("HTTP: sample/baseline endpoints accept a runId query/body param and scope accordingly; a malformed runId is a 400", async () => {
  const root = await mkdtemp(join(tmpdir(), "adj-api3-"));
  const engine = new ScriptedEngine(() => json(validAnalysis()));
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "w"), projectWorkspacesRoot: join(root, "pw"), engine, ownerId: "w", repositoryStructureProvider: fakeStructure(DEFAULT_PATHS) });
  const repo = await createFixtureRepo(root);
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const a = await registerClient(base, "adj3-a");
    const created = await a.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "J", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture", commands: { test: "node test.js" } }) });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;
    const post = (path: string, body: unknown = {}) => a.fetch(path, { method: "POST", body: JSON.stringify(body) });

    await post(`/projects/${pid}/backlog/imports`, { csv: CSV, sourceName: "S" });
    const items = (await (await a.fetch(`/projects/${pid}/backlog/review`)).json() as { rows: Array<{ itemId: string }> }).rows;
    const start = await post(`/projects/${pid}/backlog/bulk-analysis`, { itemIds: items.map((r) => r.itemId) });
    const { bulk } = (await start.json()) as { bulk: { job: { id: string } } };
    await platform.backlogRunner.drain();

    assert.equal((await a.fetch(`/projects/${pid}/backlog/adjudication/sample/proposal-ready?seed=s&size=5&runId=not-a-uuid`)).status, 400);
    const scoped = await a.fetch(`/projects/${pid}/backlog/adjudication/sample/proposal-ready?seed=s&size=5&runId=${bulk.job.id}`);
    assert.equal(scoped.status, 200);
    const scopedBody = (await scoped.json()) as { infrastructureFailures: unknown[] };
    assert.deepEqual(scopedBody.infrastructureFailures, []);

    const baseline = await post(`/projects/${pid}/backlog/adjudication/baselines`, { seed: "s", duplicateSize: 5, clarificationSize: 5, proposalReadySize: 5, runId: bulk.job.id });
    assert.equal(baseline.status, 201);
    const b = ((await baseline.json()) as { baseline: { sample: { runId: string | null } } }).baseline;
    assert.equal(b.sample.runId, bulk.job.id);
  } finally {
    await platform.backgroundRunner.stop();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});
