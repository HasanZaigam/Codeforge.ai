import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubApiError, GitHubAuthError, GitHubClient, GitHubNotFoundError, GitHubRateLimitError } from "../src/integrations/github/github-client.js";

/**
 * Unit tests for the GitHub REST API client's error mapping and
 * error-message sanitization — see /docs/GITHUB_INTEGRATION.md "Safe error
 * handling". No network access: `globalThis.fetch` is stubbed per test.
 */
function stubFetch(handler: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("getRepository maps a 404 to GitHubNotFoundError, not a raw error", async () => {
  const restore = stubFetch(async () => jsonResponse(404, { message: "Not Found" }));
  try {
    const client = new GitHubClient("fake-token");
    await assert.rejects(() => client.getRepository("acme", "widgets"), GitHubNotFoundError);
  } finally {
    restore();
  }
});

test("getBranch returns null (not a thrown error) when the branch doesn't exist", async () => {
  const restore = stubFetch(async () => jsonResponse(404, { message: "Branch not found" }));
  try {
    const client = new GitHubClient("fake-token");
    const branch = await client.getBranch("acme", "widgets", "does-not-exist");
    assert.equal(branch, null);
  } finally {
    restore();
  }
});

test("a 401 response maps to GitHubAuthError", async () => {
  const restore = stubFetch(async () => jsonResponse(401, { message: "Bad credentials" }));
  try {
    const client = new GitHubClient("fake-token");
    await assert.rejects(() => client.getAuthenticatedUser(), GitHubAuthError);
  } finally {
    restore();
  }
});

test("a rate-limited 403 maps to GitHubRateLimitError carrying the reset time from headers, not the raw headers", async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
  const restore = stubFetch(async () =>
    jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpoch) }),
  );
  try {
    const client = new GitHubClient("fake-token");
    try {
      await client.getAuthenticatedUser();
      assert.fail("expected GitHubRateLimitError");
    } catch (err) {
      assert.ok(err instanceof GitHubRateLimitError);
      assert.equal(err.resetAt?.getTime(), resetEpoch * 1000);
    }
  } finally {
    restore();
  }
});

test("an unexpected error response never leaks the request's authorization header into the thrown error", async () => {
  const restore = stubFetch(async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.ok(headers.authorization?.includes("fake-token"), "sanity: the token really was sent to GitHub");
    return jsonResponse(500, { message: "Internal Server Error", documentation_url: "https://internal.example/secret" });
  });
  try {
    const client = new GitHubClient("fake-token");
    try {
      await client.getAuthenticatedUser();
      assert.fail("expected GitHubApiError");
    } catch (err) {
      assert.ok(err instanceof GitHubApiError);
      const message = (err as Error).message;
      assert.ok(!message.includes("fake-token"), "error message must never contain the credential");
    }
  } finally {
    restore();
  }
});

test("createPullRequest sends the title/body/head/base and returns a mapped PullRequest, not the raw GitHub body", async () => {
  const restore = stubFetch(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(body, { title: "My PR", body: "desc", head: "task/abc", base: "main" });
    return jsonResponse(201, { number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open" });
  });
  try {
    const client = new GitHubClient("fake-token");
    const pr = await client.createPullRequest("acme", "widgets", { title: "My PR", body: "desc", head: "task/abc", base: "main" });
    assert.deepEqual(pr, { number: 42, htmlUrl: "https://github.com/acme/widgets/pull/42", state: "open" });
  } finally {
    restore();
  }
});
