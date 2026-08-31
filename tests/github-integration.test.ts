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
import { registerClient, type AuthedClient } from "./helpers/auth-client.js";

// A real key must be present for any credential-store code path to run at all (loadEncryptionKey
// throws otherwise) — see auth/credential-encryption.ts. Test-only; never a real secret.
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `gh-int-test-${label}-`));
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
  return { platform, baseUrl, server, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Only intercepts requests to api.github.com — the test server itself
 * (registerClient, client.fetch) uses the same global fetch to reach the
 * local HTTP harness, so everything else must pass through untouched.
 */
type FetchInput = Parameters<typeof fetch>[0];

function stubFetch(handler: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.github.com")) return original(input, init);
    return handler(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function githubApiStub(opts: { login?: string; repo?: string; defaultBranch?: string; branches?: string[] }): typeof fetch {
  const repoName = opts.repo ?? "widgets";
  const defaultBranch = opts.defaultBranch ?? "main";
  const branches = new Set(opts.branches ?? [defaultBranch]);
  return (async (input: FetchInput) => {
    const url = String(input);
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: opts.login ?? "octocat" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const branchMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/branches\/([^/?]+)/);
    if (branchMatch) {
      const [, , repo, encodedBranch] = branchMatch;
      const branch = decodeURIComponent(encodedBranch!);
      if (repo !== repoName || !branches.has(branch)) return new Response(JSON.stringify({ message: "Branch not found" }), { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: "deadbeef" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const repoMatch = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
    if (repoMatch) {
      const [, owner, repo] = repoMatch;
      if (repo !== repoName) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(
        JSON.stringify({ full_name: `${owner}/${repo}`, default_branch: defaultBranch, private: false, html_url: `https://github.com/${owner}/${repo}` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`githubApiStub: unexpected request to ${url}`);
  }) as typeof fetch;
}

test("connecting a GitHub account verifies the token against the real API before storing it, and never echoes the token back", async () => {
  const h = await setupHarness("connect");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat" }));
  try {
    const client = await registerClient(h.baseUrl, "connect");
    const res = await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });
    assert.equal(res.status, 200);
    const body = await json<Record<string, unknown>>(res);
    assert.equal(body.connected, true);
    assert.equal(body.githubLogin, "octocat");
    assert.ok(!JSON.stringify(body).includes("gh-token-abc123"), "the raw token must never appear in the response");

    const status = await json<Record<string, unknown>>(await client.fetch("/integrations/github"));
    assert.equal(status.connected, true);
    assert.equal(status.githubLogin, "octocat");
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("a token GitHub rejects (401) is reported as 400 INVALID_GITHUB_TOKEN, and nothing is stored", async () => {
  const h = await setupHarness("bad-token");
  const restoreFetch = stubFetch((async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch);
  try {
    const client = await registerClient(h.baseUrl, "bad-token");
    const res = await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "not-a-real-token" }) });
    assert.equal(res.status, 400);
    const body = await json<{ error: { code: string } }>(res);
    assert.equal(body.error.code, "INVALID_GITHUB_TOKEN");

    const status = await json<Record<string, unknown>>(await client.fetch("/integrations/github"));
    assert.equal(status.connected, false);
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("the stored GitHub credential is encrypted at rest — the raw ciphertext column never contains the plaintext token", async () => {
  const h = await setupHarness("encrypted");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat" }));
  try {
    const client = await registerClient(h.baseUrl, "encrypted");
    const plaintextToken = "ghp_supersecrettoken000000000000000000";
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: plaintextToken }) });

    const record = h.platform.githubCredentials.findByUserId(client.userId);
    assert.ok(record);
    assert.ok(!record!.secret.ciphertext.includes(Buffer.from(plaintextToken).toString("hex")), "ciphertext must not trivially contain the plaintext");
    assert.notEqual(record!.secret.ciphertext, plaintextToken);
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("disconnecting deletes the stored credential entirely, not just marks it inactive", async () => {
  const h = await setupHarness("disconnect");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat" }));
  try {
    const client = await registerClient(h.baseUrl, "disconnect");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });
    assert.ok(h.platform.githubCredentials.findByUserId(client.userId));

    const res = await client.fetch("/integrations/github", { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(h.platform.githubCredentials.findByUserId(client.userId), null);

    const status = await json<Record<string, unknown>>(await client.fetch("/integrations/github"));
    assert.equal(status.connected, false);
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("two users' GitHub connections are fully isolated — one user's status/connect/disconnect never touches another's", async () => {
  const h = await setupHarness("cross-user");
  const restoreFetch = stubFetch(githubApiStub({ login: "user-a-login" }));
  try {
    const userA = await registerClient(h.baseUrl, "userA");
    const userB = await registerClient(h.baseUrl, "userB");

    await userA.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "token-for-a" }) });

    const bStatus = await json<Record<string, unknown>>(await userB.fetch("/integrations/github"));
    assert.equal(bStatus.connected, false, "user B must not see user A's connection");

    // user B disconnecting must not affect user A's stored credential
    await userB.fetch("/integrations/github", { method: "DELETE" });
    assert.ok(h.platform.githubCredentials.findByUserId(userA.userId), "user A's credential must survive user B's disconnect call");
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("creating a github-backed project without a connected GitHub account fails clearly (409), not with an opaque 500", async () => {
  const h = await setupHarness("not-connected");
  try {
    const client = await registerClient(h.baseUrl, "not-connected");
    const res = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "P", sourceControlProvider: "github", owner: "acme", repo: "widgets" }),
    });
    assert.equal(res.status, 409);
    const body = await json<{ error: { code: string } }>(res);
    assert.equal(body.error.code, "GITHUB_NOT_CONNECTED");
  } finally {
    await teardown(h);
  }
});

test("creating a github-backed project validates the repository and branch for real before persisting anything", async () => {
  const h = await setupHarness("verify-repo");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets", defaultBranch: "main", branches: ["main", "develop"] }));
  try {
    const client = await registerClient(h.baseUrl, "verify-repo");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });

    const missingRepo = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Bad", sourceControlProvider: "github", owner: "acme", repo: "does-not-exist" }),
    });
    assert.equal(missingRepo.status, 400);
    assert.equal(h.platform.projects.listByOwner(client.userId).length, 0, "nothing should be persisted when repo verification fails");

    const missingBranch = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Bad Branch", sourceControlProvider: "github", owner: "acme", repo: "widgets", defaultBranch: "no-such-branch" }),
    });
    assert.equal(missingBranch.status, 400);
    const missingBranchBody = await json<{ error: { code: string } }>(missingBranch);
    assert.equal(missingBranchBody.error.code, "INVALID_REPOSITORY");

    const ok = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Widgets", sourceControlProvider: "github", owner: "acme", repo: "widgets", defaultBranch: "develop" }),
    });
    assert.equal(ok.status, 201);
    const { project } = await json<{ project: { owner: string; repo: string; defaultBranch: string } }>(ok);
    assert.equal(project.owner, "acme");
    assert.equal(project.repo, "widgets");
    assert.equal(project.defaultBranch, "develop");
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("the project DTO for a github project never includes a token or credential material", async () => {
  const h = await setupHarness("dto-safety");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets", defaultBranch: "main" }));
  try {
    const client = await registerClient(h.baseUrl, "dto-safety");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });
    const created = await client.fetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Widgets", sourceControlProvider: "github", owner: "acme", repo: "widgets" }),
    });
    const body = await json<unknown>(created);
    assert.ok(!JSON.stringify(body).includes("gh-token-abc123"));
  } finally {
    restoreFetch();
    await teardown(h);
  }
});
