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

const CSV = "Bug Id,Bug title,Step to Reproduce,Expected Result,Actual Result\nBUG-1,Broken thing,Open app,Works,Broken\n";

test("HTTP Chat: send/list messages, CSV attachment starts real analysis, suggestions, create-tasks (BACKLOG only); authenticated, owner-only, strict bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-api-"));
  const engine = new ScriptedEngine(() => json(validAnalysis()));
  const platform = buildPlatform({ dbPath: join(root, "p.sqlite"), workspacesRoot: join(root, "w"), projectWorkspacesRoot: join(root, "pw"), engine, ownerId: "w", repositoryStructureProvider: fakeStructure(DEFAULT_PATHS) });
  const repo = await createFixtureRepo(root);
  const server = await new Promise<Server>((resolve) => {
    const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const a = await registerClient(base, "chat-a");
    const b = await registerClient(base, "chat-b");
    const created = await a.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "J", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture", commands: { test: "node test.js" } }) });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;
    const post = (c: typeof a, path: string, body: unknown = {}) => c.fetch(path, { method: "POST", body: JSON.stringify(body) });

    // unauthenticated
    assert.equal((await fetch(`${base}/projects/${pid}/chat/messages`)).status, 401);
    assert.equal((await fetch(`${base}/projects/${pid}/chat/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

    // strict/bounded body — an empty body is schema-valid (zod default("")) but ChatService itself rejects an empty message with no attachment.
    assert.equal((await post(a, `/projects/${pid}/chat/messages`, {})).status, 400);
    assert.equal((await post(a, `/projects/${pid}/chat/messages`, { text: "x", extra: "nope" })).status, 400, "unknown fields are rejected (strict schema)");
    assert.equal((await post(a, `/projects/${pid}/chat/messages`, { text: "x".repeat(5_000) })).status, 400, "over the text length bound");

    // send a plain text message
    const sent = await post(a, `/projects/${pid}/chat/messages`, { text: "Explain how OTP works here." });
    assert.equal(sent.status, 201);
    const sentBody = (await sent.json()) as { userMessage: { role: string }; assistantMessage: { role: string; content: string } };
    assert.equal(sentBody.userMessage.role, "user");
    assert.equal(sentBody.assistantMessage.role, "assistant");
    assert.ok(sentBody.assistantMessage.content.length > 0);

    const list = await a.fetch(`/projects/${pid}/chat/messages`);
    assert.equal(list.status, 200);
    const listed = ((await list.json()) as { messages: unknown[] }).messages;
    assert.equal(listed.length, 2);

    // CSV attachment: real import + real bulk analysis, never a fake filename-only attachment
    const csvB64 = Buffer.from(CSV, "utf8").toString("base64");
    const attached = await post(a, `/projects/${pid}/chat/messages`, { text: "", attachment: { filename: "bugs.csv", mimeType: "text/csv", contentBase64: csvB64 } });
    assert.equal(attached.status, 201);
    const attachedBody = (await attached.json()) as { assistantMessage: { content: string; bulkJobId: string } };
    assert.match(attachedBody.assistantMessage.content, /imported 1 of 1/i);
    const bulkJobId = attachedBody.assistantMessage.bulkJobId;
    assert.ok(bulkJobId);

    // fabricated attachment types are rejected
    assert.equal((await post(a, `/projects/${pid}/chat/messages`, { text: "", attachment: { filename: "x.exe", mimeType: "application/octet-stream", contentBase64: "AAAA" } })).status, 400);

    // drain the real worker-side analysis job, exactly like the existing bulk-analysis flow
    await platform.backlogRunner.drain();

    const sugg = await a.fetch(`/projects/${pid}/chat/suggestions/${bulkJobId}`);
    assert.equal(sugg.status, 200);
    const suggestions = ((await sugg.json()) as { suggestions: Array<{ itemId: string }> }).suggestions;
    assert.equal(suggestions.length, 1);

    // create-tasks: strict body, at least one id
    assert.equal((await post(a, `/projects/${pid}/chat/create-tasks`, { itemIds: [] })).status, 400);
    const createRes = await post(a, `/projects/${pid}/chat/create-tasks`, { itemIds: suggestions.map((s) => s.itemId) });
    assert.equal(createRes.status, 200);
    const createBody = (await createRes.json()) as { createdTaskIds: string[] };
    assert.equal(createBody.createdTaskIds.length, 1);

    // the created task is a REAL task, in BACKLOG, reachable via the ordinary Tasks endpoint
    const taskResp = await a.fetch(`/tasks/${createBody.createdTaskIds[0]}`);
    assert.equal(taskResp.status, 200);
    const task = (await taskResp.json()) as { task: { status: string } };
    assert.equal(task.task.status, "BACKLOG");

    // owner isolation: a second user gets 404s, not another project's data
    for (const [method, path, body] of [
      ["GET", `/projects/${pid}/chat/messages`, null],
      ["POST", `/projects/${pid}/chat/messages`, { text: "hi" }],
      ["GET", `/projects/${pid}/chat/suggestions/${bulkJobId}`, null],
      ["POST", `/projects/${pid}/chat/create-tasks`, { itemIds: suggestions.map((s) => s.itemId) }],
    ] as const) {
      const resp = await b.fetch(path, method === "POST" ? { method, body: JSON.stringify(body) } : {});
      assert.equal(resp.status, 404, `${method} ${path} should be owner-only`);
    }
  } finally {
    await platform.backgroundRunner.stop();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});
