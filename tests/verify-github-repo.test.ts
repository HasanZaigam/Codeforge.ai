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

interface Harness {
  platform: Platform;
  baseUrl: string;
  server: Server;
  repoPath: string;
}

async function setupHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `verify-gh-test-${label}-`));
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
  return { platform, baseUrl: `http://127.0.0.1:${address.port}`, server, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise((resolve) => h.server.close(resolve));
  h.platform.db.close();
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

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
    if (/\/branches\?per_page=/.test(url)) {
      const repoMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/branches/);
      if (repoMatch && repoMatch[2] !== repoName) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(JSON.stringify([...branches].map((name) => ({ name }))), { status: 200, headers: { "content-type": "application/json" } });
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

/**
 * Part A coverage: the "paste a URL, then Validate repository" project-connection flow (see
 * ProjectService.verifyGitHubRepositoryUrl and CreateProjectDialog.tsx). Confirms the endpoint
 * makes a real (here, stubbed) GitHub API check — not just URL-shape validation — and that
 * malformed input is rejected clearly before any GitHub call is even attempted.
 */
test("POST /projects/verify-github-repo: a valid GitHub URL is parsed, verified against the real API, and returns the derived identity + a suggested name", async () => {
  const h = await setupHarness("verify-ok");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets", defaultBranch: "develop" }));
  try {
    const client = await registerClient(h.baseUrl, "verify-ok");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });

    const res = await client.fetch("/projects/verify-github-repo", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "https://github.com/acme/widgets.git" }),
    });
    assert.equal(res.status, 200);
    const body = await json<{ owner: string; repo: string; defaultBranch: string; suggestedName: string; repoUrl: string }>(res);
    assert.equal(body.owner, "acme");
    assert.equal(body.repo, "widgets");
    assert.equal(body.defaultBranch, "develop");
    assert.equal(body.suggestedName, "widgets");
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("POST /projects/verify-github-repo: a malformed URL is rejected clearly, without ever calling GitHub", async () => {
  const h = await setupHarness("verify-malformed");
  const client = await registerClient(h.baseUrl, "verify-malformed");
  const restoreConnect = stubFetch(githubApiStub({ login: "octocat" }));
  await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });
  restoreConnect();

  let called = false;
  const restoreFetch = stubFetch((async () => {
    called = true;
    throw new Error("should not be called");
  }) as typeof fetch);
  try {
    const res = await client.fetch("/projects/verify-github-repo", { method: "POST", body: JSON.stringify({ repoUrl: "not a url" }) });
    assert.equal(res.status, 400);
    const body = await json<{ error: { code: string } }>(res);
    assert.equal(body.error.code, "INVALID_REPOSITORY");
    assert.equal(called, false, "a malformed URL must never reach the GitHub API");
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("POST /projects/verify-github-repo: an inaccessible/nonexistent repository surfaces a clear 400, not a raw upstream error", async () => {
  const h = await setupHarness("verify-missing");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets" }));
  try {
    const client = await registerClient(h.baseUrl, "verify-missing");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });

    const res = await client.fetch("/projects/verify-github-repo", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "https://github.com/acme/does-not-exist" }),
    });
    assert.equal(res.status, 400);
    const body = await json<{ error: { code: string } }>(res);
    assert.equal(body.error.code, "INVALID_REPOSITORY");
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("GET /projects/:projectId/branches: lists the repository's real remote branches for a GitHub project", async () => {
  const h = await setupHarness("list-branches");
  const restoreFetch = stubFetch(githubApiStub({ login: "octocat", repo: "widgets", defaultBranch: "main", branches: ["main", "develop", "release/1.0"] }));
  try {
    const client = await registerClient(h.baseUrl, "list-branches");
    await client.fetch("/integrations/github", { method: "POST", body: JSON.stringify({ token: "gh-token-abc123" }) });
    const { project } = await json<{ project: { id: string } }>(
      await client.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "Widgets", sourceControlProvider: "github", owner: "acme", repo: "widgets" }) }),
    );

    const res = await client.fetch(`/projects/${project.id}/branches`);
    assert.equal(res.status, 200);
    const body = await json<{ branches: string[] }>(res);
    assert.deepEqual(new Set(body.branches), new Set(["main", "develop", "release/1.0"]));
  } finally {
    restoreFetch();
    await teardown(h);
  }
});

test("GET /projects/:projectId/branches: a local-git project returns a best-effort branch list without requiring GitHub", async () => {
  const h = await setupHarness("list-branches-local");
  try {
    const client = await registerClient(h.baseUrl, "list-branches-local");
    const { project } = await json<{ project: { id: string } }>(
      await client.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "Fixture", sourceControlProvider: "local-git", repoUrl: h.repoPath, codingEngine: "fixture" }) }),
    );

    const res = await client.fetch(`/projects/${project.id}/branches`);
    assert.equal(res.status, 200);
    const body = await json<{ branches: string[] }>(res);
    assert.ok(body.branches.includes("main"));
  } finally {
    await teardown(h);
  }
});
