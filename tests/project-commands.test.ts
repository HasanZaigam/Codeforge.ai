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
 * PATCH /projects/:projectId/commands — see ProjectService.updateCommands's own doc comment for
 * why this exists (previously the only place `commands` could be set was project creation, which
 * has no corresponding frontend UI at all, leaving `runValidation` unable to run any check on any
 * task for a project connected without them — undeclared checks are silently skipped, not failed).
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `project-commands-${label}-`));
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

test("PATCH /projects/:projectId/commands: sets commands, and GET reflects both commandsDeclared and the real values", async () => {
  const h = await setupHarness("set");
  try {
    const client = await registerClient(h.baseUrl, "set");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const created = await json<{ project: { id: string; commandsDeclared: string[] } }>(createRes);
    const project = created.project;
    assert.deepEqual(created.project.commandsDeclared, []);

    const patchRes = await client.fetch(`/projects/${project.id}/commands`, {
      method: "PATCH",
      body: JSON.stringify({ commands: { build: "npm run build", typecheck: "npm run typecheck" } }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await json<{ project: { commandsDeclared: string[]; commands: Record<string, string> } }>(patchRes);
    assert.deepEqual(new Set(patched.project.commandsDeclared), new Set(["build", "typecheck"]));
    assert.equal(patched.project.commands.build, "npm run build");
    assert.equal(patched.project.commands.typecheck, "npm run typecheck");

    const getRes = await client.fetch(`/projects/${project.id}`);
    const fetched = await json<{ project: { commands: Record<string, string> } }>(getRes);
    assert.equal(fetched.project.commands.build, "npm run build");
  } finally {
    await teardown(h);
  }
});

test("PATCH /projects/:projectId/commands: is a full replacement — a field omitted from a later PATCH clears it, not merged with the previous value", async () => {
  const h = await setupHarness("replace");
  try {
    const client = await registerClient(h.baseUrl, "replace");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    await client.fetch(`/projects/${project.id}/commands`, {
      method: "PATCH",
      body: JSON.stringify({ commands: { build: "npm run build", test: "npm test" } }),
    });
    const secondPatch = await client.fetch(`/projects/${project.id}/commands`, {
      method: "PATCH",
      body: JSON.stringify({ commands: { build: "npm run build" } }),
    });
    const { project: updated } = await json<{ project: { commandsDeclared: string[] } }>(secondPatch);
    assert.deepEqual(updated.commandsDeclared, ["build"], "test must have been cleared, not left over from the first PATCH");
  } finally {
    await teardown(h);
  }
});

test("PATCH /projects/:projectId/commands: a non-owner gets a 404, never silently succeeding against someone else's project", async () => {
  const h = await setupHarness("non-owner");
  try {
    const ownerClient = await registerClient(h.baseUrl, "non-owner-owner");
    const otherClient = await registerClient(h.baseUrl, "non-owner-other");
    const createRes = await ownerClient.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const res = await otherClient.fetch(`/projects/${project.id}/commands`, {
      method: "PATCH",
      body: JSON.stringify({ commands: { build: "npm run build" } }),
    });
    assert.equal(res.status, 404);

    const getRes = await ownerClient.fetch(`/projects/${project.id}`);
    const { project: unchanged } = await json<{ project: { commandsDeclared: string[] } }>(getRes);
    assert.deepEqual(unchanged.commandsDeclared, [], "the non-owner's rejected PATCH must not have changed anything");
  } finally {
    await teardown(h);
  }
});

test("PATCH /projects/:projectId/commands: an empty-string command is rejected as invalid input (400), not silently stored", async () => {
  const h = await setupHarness("invalid");
  try {
    const client = await registerClient(h.baseUrl, "invalid");
    const createRes = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
    });
    const { project } = await json<{ project: { id: string } }>(createRes);

    const res = await client.fetch(`/projects/${project.id}/commands`, {
      method: "PATCH",
      body: JSON.stringify({ commands: { build: "" } }),
    });
    assert.equal(res.status, 400);

    const getRes = await client.fetch(`/projects/${project.id}`);
    const { project: unchanged } = await json<{ project: { commandsDeclared: string[] } }>(getRes);
    assert.deepEqual(unchanged.commandsDeclared, []);
  } finally {
    await teardown(h);
  }
});
