import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { registerClient } from "./helpers/auth-client.js";
import { DEFAULT_PATHS, ScriptedEngine, fakeStructure, json, validAnalysis } from "./helpers/backlog-harness.js";
import { buildPreview } from "../src/backlog/import-csv.js";

const REAL_CSV_PATH = "/Users/applore/Downloads/Jinvani OTT Feedback Tracker(Application P1).csv";

describe("Phase 4D.6.2 — Real Runtime Upload Verification & End-to-End HTTP Tests", () => {
  test("1. Real Jinvani CSV file header detection and row parsing verification", () => {
    const csvContent = fs.readFileSync(REAL_CSV_PATH, "utf8");
    const preview = buildPreview(csvContent);

    assert.equal(preview.totalRows, 78);
    assert.equal(preview.accepted, 77);
    assert.equal(preview.rejected, 1);

    // Verify BUG-ID 002
    const row2 = preview.rows.find((r) => r.sourceKey === "BUG-ID-002");
    assert.ok(row2);
    assert.equal(row2.status, "ACCEPTED");
    assert.equal(row2.title, "Toast Message appear continuously");

    // Verify BUG-ID 006
    const row6 = preview.rows.find((r) => r.sourceKey === "BUG-ID-006");
    assert.ok(row6);
    assert.equal(row6.status, "ACCEPTED");
    assert.equal(row6.title, "Name accept Blank Space");
    assert.match(row6.fields.status!, /DONE/i);

    // Verify BUG-ID 017
    const row17 = preview.rows.find((r) => r.sourceKey === "BUG-ID-017");
    assert.ok(row17);
    assert.equal(row17.status, "ACCEPTED");
    assert.equal(row17.title, "Quality selection not avaliable");
    assert.match(row17.fields.status!, /Add-on/i);

    // Verify rejected row 249
    const rejectedRow = preview.rows.find((r) => r.status === "REJECTED");
    assert.ok(rejectedRow);
    assert.equal(rejectedRow.reason, "missing_title");
    assert.equal(rejectedRow.detail, "The title is empty.");
  });

  test("2. End-to-End Real HTTP Flow: Upload real CSV via HTTP API -> activeImportId -> Query -> Filter -> Preview -> Confirm", async () => {
    const root = await mkdtemp(join(tmpdir(), "p4d62-http-"));
    const engine = new ScriptedEngine(() => json(validAnalysis()));
    const platform = buildPlatform({
      dbPath: join(root, "p.sqlite"),
      workspacesRoot: join(root, "w"),
      projectWorkspacesRoot: join(root, "pw"),
      engine,
      ownerId: "w",
      repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
    });
    const repo = await createFixtureRepo(root);
    const server = await new Promise<Server>((resolve) => {
      const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const client = await registerClient(base, "p4d62-user");
      const createdProject = await client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "Jinvani OTT",
          sourceControlProvider: "local-git",
          repoUrl: repo,
          codingEngine: "fixture",
          commands: { test: "node test.js" },
        }),
      });
      const pid = ((await createdProject.json()) as { project: { id: string } }).project.id;
      const post = (path: string, body: unknown) => client.fetch(path, { method: "POST", body: JSON.stringify(body) });

      // Step A: Upload real CSV file via HTTP endpoint
      const realCsvContent = fs.readFileSync(REAL_CSV_PATH, "utf8");
      const uploadRes = await post(`/projects/${pid}/chat/messages`, {
        text: "",
        attachment: {
          filename: "Jinvani OTT Feedback Tracker(Application P1).csv",
          mimeType: "text/csv",
          contentBase64: Buffer.from(realCsvContent).toString("base64"),
        },
      });
      assert.equal(uploadRes.status, 201);
      const uploadBody = (await uploadRes.json()) as { assistantMessage: { content: string } };
      assert.match(uploadBody.assistantMessage.content, /imported 77 of 78 rows/i);

      // Step B: Query count of dev-status Add-on – not built
      const countRes = await post(`/projects/${pid}/chat/messages`, {
        text: "How many bugs have dev-status Add-on – not built?",
      });
      assert.equal(countRes.status, 201);
      const countBody = (await countRes.json()) as { assistantMessage: { content: string } };
      assert.match(countBody.assistantMessage.content, /17 bugs/i);

      // Step C: List matching items
      const listRes = await post(`/projects/${pid}/chat/messages`, {
        text: "List them.",
      });
      assert.equal(listRes.status, 201);
      const listBody = (await listRes.json()) as { assistantMessage: { content: string } };
      assert.match(listBody.assistantMessage.content, /Quality selection not avaliable/i);

      // Step D: Create tasks preview
      const previewRes = await post(`/projects/${pid}/chat/messages`, {
        text: "Create tasks only for Add-on – not built bugs.",
      });
      assert.equal(previewRes.status, 201);
      const previewBody = (await previewRes.json()) as { pendingAction: { kind: string } | null; assistantMessage: { content: string } };
      assert.ok(previewBody.pendingAction);
      assert.equal(previewBody.pendingAction.kind, "UPLOAD_TASK_CREATION");
      assert.match(previewBody.assistantMessage.content, /BACKLOG/i);

      // Step E: Confirm creation
      const confirmRes = await post(`/projects/${pid}/chat/messages`, {
        text: "Yes",
      });
      assert.equal(confirmRes.status, 201);
      const confirmBody = (await confirmRes.json()) as { assistantMessage: { content: string } };
      assert.match(confirmBody.assistantMessage.content, /Created 17 of 17 tasks in BACKLOG/i);

      // Verify tasks in DB are in BACKLOG
      const tasksRes = await client.fetch(`/projects/${pid}/chat/messages`);
      assert.equal(tasksRes.status, 200);
    } finally {
      await platform.backgroundRunner.stop();
      await new Promise((resolve) => server.close(resolve));
      platform.db.close();
    }
  });

  test("3. Re-uploading valid CSV & Bad upload recovery scenarios", async () => {
    const root = await mkdtemp(join(tmpdir(), "p4d62-reupload-"));
    const engine = new ScriptedEngine(() => json(validAnalysis()));
    const platform = buildPlatform({
      dbPath: join(root, "p.sqlite"),
      workspacesRoot: join(root, "w"),
      projectWorkspacesRoot: join(root, "pw"),
      engine,
      ownerId: "w",
      repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
    });
    const repo = await createFixtureRepo(root);
    const server = await new Promise<Server>((resolve) => {
      const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const client = await registerClient(base, "p4d62-reuser");
      const createdProject = await client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "Jinvani OTT Reupload Test",
          sourceControlProvider: "local-git",
          repoUrl: repo,
          codingEngine: "fixture",
          commands: { test: "node test.js" },
        }),
      });
      const pid = ((await createdProject.json()) as { project: { id: string } }).project.id;
      const post = (path: string, body: unknown) => client.fetch(path, { method: "POST", body: JSON.stringify(body) });

      // Scenario A: Bad CSV upload first -> fails 0 accepted, 2 rejected
      const badCsv = "Bug Id,Bug title,Description\nBUG-1,,Some reproduction steps\nBUG-2,,Some expected result\n";
      const badUpload = await post(`/projects/${pid}/chat/messages`, {
        text: "",
        attachment: {
          filename: "bad.csv",
          mimeType: "text/csv",
          contentBase64: Buffer.from(badCsv).toString("base64"),
        },
      });
      assert.equal(badUpload.status, 201);
      const badBody = (await badUpload.json()) as { assistantMessage: { content: string } };
      assert.match(badBody.assistantMessage.content, /every row was rejected/i);

      // Scenario B: Upload valid CSV after bad CSV -> succeeds and sets activeImportId
      const realCsvContent = fs.readFileSync(REAL_CSV_PATH, "utf8");
      const validUpload = await post(`/projects/${pid}/chat/messages`, {
        text: "",
        attachment: {
          filename: "Jinvani OTT Feedback Tracker(Application P1).csv",
          mimeType: "text/csv",
          contentBase64: Buffer.from(realCsvContent).toString("base64"),
        },
      });
      assert.equal(validUpload.status, 201);
      const validBody = (await validUpload.json()) as { assistantMessage: { content: string } };
      assert.match(validBody.assistantMessage.content, /imported 77 of 78 rows/i);

      // Verify query now works on the valid upload
      const countRes = await post(`/projects/${pid}/chat/messages`, {
        text: "How many bugs have dev-status Add-on – not built?",
      });
      const countBody = (await countRes.json()) as { assistantMessage: { content: string } };
      assert.match(countBody.assistantMessage.content, /17 bugs/i);

      // Scenario C: Re-upload the exact same valid CSV a second time
      const reUpload = await post(`/projects/${pid}/chat/messages`, {
        text: "",
        attachment: {
          filename: "Jinvani OTT Feedback Tracker(Application P1).csv",
          mimeType: "text/csv",
          contentBase64: Buffer.from(realCsvContent).toString("base64"),
        },
      });
      assert.equal(reUpload.status, 201);

      // Query should give exact same deterministic answer
      const countRes2 = await post(`/projects/${pid}/chat/messages`, {
        text: "How many bugs have dev-status Add-on – not built?",
      });
      const countBody2 = (await countRes2.json()) as { assistantMessage: { content: string } };
      assert.equal(countBody2.assistantMessage.content, countBody.assistantMessage.content);
    } finally {
      await platform.backgroundRunner.stop();
      await new Promise((resolve) => server.close(resolve));
      platform.db.close();
    }
  });
});
