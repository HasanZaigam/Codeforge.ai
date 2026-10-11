import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform } from "../src/platform.js";
import { buildApp, getGitSha } from "../src/api/app.js";
import { checkPortOccupiedByCodeForge } from "../src/api/server.js";
import { DEFAULT_PATHS, ScriptedEngine, fakeStructure, json, validAnalysis } from "./helpers/backlog-harness.js";

describe("Dev Runtime Reliability & Process Management Tests", () => {
  test("1. GET /health exposes complete runtime metadata (service, pid, startedAt, gitSha, port, codingEngine)", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-runtime-1-"));
    const engine = new ScriptedEngine(() => json(validAnalysis()));
    const platform = buildPlatform({
      dbPath: join(root, "p.sqlite"),
      workspacesRoot: join(root, "w"),
      projectWorkspacesRoot: join(root, "pw"),
      engine,
      ownerId: "w",
      repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
    });

    const server = await new Promise<Server>((resolve) => {
      const s = buildApp(platform, {
        pid: 99999,
        startedAt: "2026-10-03T20:00:00.000Z",
        gitSha: "abc1234",
        port: 4567,
      }).listen(0, "127.0.0.1", () => resolve(s));
    });

    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        status: string;
        service: string;
        environment: string;
        pid: number;
        startedAt: string;
        gitSha: string | null;
        port: number;
        codingEngine: { engine: string; model: string | null };
      };

      assert.equal(data.status, "ok");
      assert.equal(data.service, "codeforge-api");
      assert.equal(data.pid, 99999);
      assert.equal(data.startedAt, "2026-10-03T20:00:00.000Z");
      assert.equal(data.gitSha, "abc1234");
      assert.equal(data.port, 4567);
      assert.ok(data.codingEngine);
      assert.ok(typeof data.codingEngine.engine === "string");
    } finally {
      await new Promise((r) => server.close(r));
      platform.db.close();
    }
  });

  test("2. getGitSha returns string or null safely without throwing errors", () => {
    const sha = getGitSha();
    if (sha !== null) {
      assert.equal(typeof sha, "string");
      assert.ok(sha.length > 0 && sha.length <= 12);
    }
  });

  test("3. checkPortOccupiedByCodeForge detects running CodeForge API vs free port", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-runtime-3-"));
    const engine = new ScriptedEngine(() => json(validAnalysis()));
    const platform = buildPlatform({
      dbPath: join(root, "p.sqlite"),
      workspacesRoot: join(root, "w"),
      projectWorkspacesRoot: join(root, "pw"),
      engine,
      ownerId: "w",
      repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
    });

    const server = await new Promise<Server>((resolve) => {
      const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
    });

    const port = (server.address() as { port: number }).port;

    try {
      // Probing active CodeForge API server
      const occupiedCheck = await checkPortOccupiedByCodeForge(port);
      assert.equal(occupiedCheck.occupied, true);
      assert.equal(occupiedCheck.isCodeForge, true);

      // Probing unused port (high unallocated port number)
      const unusedPort = 58912;
      const freePortCheck = await checkPortOccupiedByCodeForge(unusedPort);
      assert.equal(freePortCheck.occupied, false);
      assert.equal(freePortCheck.isCodeForge, false);
    } finally {
      await new Promise((r) => server.close(r));
      platform.db.close();
    }
  });

  test("4. Normal startup and graceful shutdown cleanly releases server resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-runtime-4-"));
    const engine = new ScriptedEngine(() => json(validAnalysis()));
    const platform = buildPlatform({
      dbPath: join(root, "p.sqlite"),
      workspacesRoot: join(root, "w"),
      projectWorkspacesRoot: join(root, "pw"),
      engine,
      ownerId: "w",
      repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
    });

    let isClosed = false;
    const server = await new Promise<Server>((resolve) => {
      const s = buildApp(platform).listen(0, "127.0.0.1", () => resolve(s));
    });

    server.on("close", () => {
      isClosed = true;
    });

    const port = (server.address() as { port: number }).port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    await new Promise((r) => server.close(r));
    assert.equal(isClosed, true);
    platform.db.close();
  });
});
