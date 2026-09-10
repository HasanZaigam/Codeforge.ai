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
 * Server-side enforcement of the local-git production gate (see
 * /docs/GITHUB_INTEGRATION.md "Local git / plain-git testing" and
 * ALLOW_LOCAL_GIT_PROJECTS in /docs/DEPLOYMENT.md). ProjectService.create
 * reads `process.env` directly (isLocalGitProjectsAllowed, same pattern
 * already used for CODING_ENGINE default — see project-service.ts), so
 * these tests mutate `process.env.NODE_ENV`/`ALLOW_LOCAL_GIT_PROJECTS`
 * around each request and always restore them in `finally`, since this
 * suite runs with `--test-isolation=none` (shared process) alongside every
 * other test file.
 */

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
  client: AuthedClient;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `local-git-policy-${label}-`));
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

/** Runs `fn` with the given env vars set, restoring the previous values (including "was unset") afterward. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("POST /projects (local-git): allowed outside production with no ALLOW_LOCAL_GIT_PROJECTS set at all", async () => {
  const h = await setupHarness("dev-default");
  try {
    await withEnv({ NODE_ENV: undefined, ALLOW_LOCAL_GIT_PROJECTS: undefined }, async () => {
      const res = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Dev", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
      });
      assert.equal(res.status, 201);
    });
  } finally {
    await teardown(h);
  }
});

test("POST /projects (local-git): rejected in production by default", async () => {
  const h = await setupHarness("prod-default");
  try {
    await withEnv({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: undefined }, async () => {
      const res = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Prod", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "LOCAL_GIT_PROJECTS_DISABLED");
    });
  } finally {
    await teardown(h);
  }
});

test("POST /projects (local-git): rejected in production even when ALLOW_LOCAL_GIT_PROJECTS=false explicitly", async () => {
  const h = await setupHarness("prod-explicit-false");
  try {
    await withEnv({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "false" }, async () => {
      const res = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Prod", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await teardown(h);
  }
});

test("POST /projects (local-git): allowed in production when ALLOW_LOCAL_GIT_PROJECTS=true explicitly", async () => {
  const h = await setupHarness("prod-enabled");
  try {
    await withEnv({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "true" }, async () => {
      const res = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Prod", sourceControlProvider: "local-git", repoUrl: h.repoPath }),
      });
      assert.equal(res.status, 201);
    });
  } finally {
    await teardown(h);
  }
});

test("POST /projects (local-git): the production restriction cannot be bypassed by alternate request shapes (extra/reordered fields, whitespace-padded provider casing rejected by schema)", async () => {
  const h = await setupHarness("prod-bypass-attempt");
  try {
    await withEnv({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: undefined }, async () => {
      // Extra/unexpected fields alongside a valid local-git body still hit the same
      // ProjectService.create() enforcement point — it's not schema-shape-dependent.
      const res1 = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "Prod",
          sourceControlProvider: "local-git",
          repoUrl: h.repoPath,
          codingEngine: "fixture",
          commands: { test: "node test.js" },
          owner: "someone", // not part of the local-git schema branch — ignored by zod, not a bypass
        }),
      });
      assert.equal(res1.status, 403);

      // A malformed/unknown provider value never reaches ProjectService at all (schema 400) —
      // confirms there's no alternate code path that skips the gate.
      const res2 = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Prod", sourceControlProvider: "LOCAL-GIT", repoUrl: h.repoPath }),
      });
      assert.equal(res2.status, 400);
    });
  } finally {
    await teardown(h);
  }
});

test("POST /projects (github): completely unaffected by the local-git production gate, in every NODE_ENV/ALLOW_LOCAL_GIT_PROJECTS combination", async () => {
  const h = await setupHarness("github-unaffected");
  try {
    const combos: Array<Record<string, string | undefined>> = [
      { NODE_ENV: undefined, ALLOW_LOCAL_GIT_PROJECTS: undefined },
      { NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: undefined },
      { NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "false" },
      { NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "true" },
    ];
    for (const combo of combos) {
      await withEnv(combo, async () => {
        const res = await h.client.fetch("/projects", {
          method: "POST",
          body: JSON.stringify({ name: "GH", sourceControlProvider: "github", owner: "octocat", repo: "hello-world" }),
        });
        // No GitHub account connected for this user — expected to fail with GITHUB_NOT_CONNECTED
        // (409), never LOCAL_GIT_PROJECTS_DISABLED (403) or anything gate-related, in any combo.
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, "GITHUB_NOT_CONNECTED");
      });
    }
  } finally {
    await teardown(h);
  }
});

test("POST /projects (local-git): repoUrl pointed at github.com is rejected regardless of the production gate (GitHub-URL bypass restriction)", async () => {
  const h = await setupHarness("github-url-bypass");
  try {
    for (const repoUrl of [
      "https://github.com/octocat/hello-world.git",
      "git@github.com:octocat/hello-world.git",
      "ssh://git@github.com/octocat/hello-world.git",
    ]) {
      const res = await h.client.fetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Bypass attempt", sourceControlProvider: "local-git", repoUrl }),
      });
      assert.equal(res.status, 400, `expected 400 for repoUrl=${repoUrl}`);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "INVALID_REQUEST");
    }
  } finally {
    await teardown(h);
  }
});
