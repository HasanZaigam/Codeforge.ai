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

const CSV = "Bug Id,Module,Bug title,Step to Reproduce ,Expected Result ,Actual Ressult,Priority\nBUG-ID 001,SignUp,Wrong message,1. open,should be clear,raw error,High\nBUG-ID 002,SignUp,,1. open,x,y,Low\n";

test("HTTP bulk: import → preview/confirm → bulk analysis (202, enqueue only) → review → actions; every route is authenticated, owner-only (404), strict and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "bulk-api-"));
  const engine = new ScriptedEngine(() => json(validAnalysis()));
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "w"), projectWorkspacesRoot: join(root, "pw"), engine, ownerId: "w", repositoryStructureProvider: fakeStructure(DEFAULT_PATHS) });
  const repo = await createFixtureRepo(root);
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const a = await registerClient(base, "bulk-a");
    const b = await registerClient(base, "bulk-b");
    const created = await a.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "J", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture", commands: { test: "node test.js" } }) });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;
    const post = (c: typeof a, path: string, body: unknown = {}) => c.fetch(path, { method: "POST", body: JSON.stringify(body) });

    // unauthenticated
    assert.equal((await fetch(`${base}/projects/${pid}/backlog/review`)).status, 401);
    assert.equal((await fetch(`${base}/projects/${pid}/backlog/imports/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

    // preview + confirm
    const pre = await post(a, `/projects/${pid}/backlog/imports/preview`, { csv: CSV, sourceName: "Application" });
    assert.equal(pre.status, 200);
    const preview = ((await pre.json()) as { preview: { accepted: number; rejected: number; rows: Array<{ reason: string | null }> } }).preview;
    assert.deepEqual([preview.accepted, preview.rejected, preview.rows[1]!.reason], [1, 1, "missing_title"]);
    const conf = await post(a, `/projects/${pid}/backlog/imports`, { csv: CSV, sourceName: "Application" });
    assert.equal(conf.status, 201);
    const imp = ((await conf.json()) as { import: { id: string; acceptedRows: number } }).import;
    assert.equal(imp.acceptedRows, 1);
    assert.equal(engine.calls.length, 0, "import never calls a model");

    // strict/bounded bodies
    assert.equal((await post(a, `/projects/${pid}/backlog/imports`, { csv: CSV, sourceName: "x", status: "ANALYZED" })).status, 400);
    assert.equal((await post(a, `/projects/${pid}/backlog/imports`, { csv: CSV })).status, 400);
    assert.equal((await post(a, `/projects/${pid}/backlog/imports`, { csv: "x".repeat(700_000), sourceName: "x" })).status, 400);
    assert.equal((await post(a, `/projects/${pid}/backlog/imports`, { csv: "Foo,Bar\n1,2\n", sourceName: "x" })).status, 400);
    assert.equal((await post(a, `/projects/${pid}/backlog/bulk-analysis`, { importId: imp.id, itemIds: [] })).status, 400);
    assert.equal((await post(a, `/projects/${pid}/backlog/actions`, { action: "start_all", itemIds: [imp.id] })).status, 400, "there is no Start All");

    // owner-only
    for (const [method, path, body] of [
      ["POST", `/projects/${pid}/backlog/imports/preview`, { csv: CSV, sourceName: "x" }],
      ["POST", `/projects/${pid}/backlog/imports`, { csv: CSV, sourceName: "x" }],
      ["GET", `/projects/${pid}/backlog/imports`, null],
      ["GET", `/backlog/imports/${imp.id}`, null],
      ["POST", `/projects/${pid}/backlog/bulk-analysis`, { importId: imp.id }],
      ["GET", `/projects/${pid}/backlog/review`, null],
      ["GET", `/projects/${pid}/backlog/groups`, null],
    ] as const) {
      const res = await b.fetch(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, 404, `${method} ${path}`);
    }

    // bulk analysis: 202 enqueue only, worker drains, review reads
    const start = await post(a, `/projects/${pid}/backlog/bulk-analysis`, { importId: imp.id });
    assert.equal(start.status, 202);
    const { bulk } = (await start.json()) as { bulk: { job: { id: string }; status: string } };
    assert.equal(bulk.status, "QUEUED");
    assert.equal(engine.calls.length, 0);
    assert.equal((await b.fetch(`/backlog/bulk-analysis/${bulk.job.id}`)).status, 404);
    assert.equal((await post(b, `/backlog/bulk-analysis/${bulk.job.id}/cancel`)).status, 404);
    await platform.backlogRunner.drain();
    const status = (await (await a.fetch(`/backlog/bulk-analysis/${bulk.job.id}`)).json()) as { bulk: { status: string } };
    assert.equal(status.bulk.status, "COMPLETED");
    const review = (await (await a.fetch(`/projects/${pid}/backlog/review?filter=analysis_ready`)).json()) as { rows: Array<{ ref: string; module: string; review: { behavior: string } }>; counts: Record<string, number>; usage: { analyses: number } };
    assert.equal(review.rows.length, 1);
    assert.equal(review.rows[0]!.module, "SignUp");
    assert.equal(review.rows[0]!.review.behavior, "BEHAVIOR_UNVERIFIED");
    assert.equal(review.usage.analyses, 1);
    assert.equal((await a.fetch(`/projects/${pid}/backlog/review?filter=bogus`)).status, 400);

    // actions: generate/approve/convert, tasks stay BACKLOG
    const itemId = (platform.db.prepare("SELECT id FROM backlog_items").get() as { id: string }).id;
    for (const action of ["generate_proposals", "approve_proposals", "convert_proposals"]) {
      const res = await post(a, `/projects/${pid}/backlog/actions`, { action, itemIds: [itemId] });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { ok: number }).ok, 1, action);
    }
    assert.equal((platform.db.prepare("SELECT status FROM tasks").get() as { status: string }).status, "BACKLOG");
  } finally {
    await platform.backgroundRunner.stop();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});
