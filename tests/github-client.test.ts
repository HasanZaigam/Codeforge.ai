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

test("getPullRequest returns the merged flag, which listPullRequests/createPullRequest never expose", async () => {
  const restore = stubFetch(async () => jsonResponse(200, { number: 7, html_url: "https://github.com/acme/widgets/pull/7", state: "closed", merged: true }));
  try {
    const client = new GitHubClient("fake-token");
    const pr = await client.getPullRequest("acme", "widgets", 7);
    assert.deepEqual(pr, { number: 7, htmlUrl: "https://github.com/acme/widgets/pull/7", state: "closed", merged: true, mergeable: null });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

test("a retryable_transient failure (500) is retried and eventually succeeds, for an idempotent (GET) call", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    if (calls < 3) return jsonResponse(500, { message: "Internal Server Error" });
    return jsonResponse(200, { login: "octocat" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { retryBaseDelayMs: 1, retryMaxDelayMs: 5 });
    const user = await client.getAuthenticatedUser();
    assert.deepEqual(user, { login: "octocat" });
    assert.equal(calls, 3);
  } finally {
    restore();
  }
});

test("a non-retryable failure (404) is never retried — exactly one request", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return jsonResponse(404, { message: "Not Found" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { maxRetries: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5 });
    await assert.rejects(() => client.getRepository("acme", "widgets"));
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("a non-retryable failure (401) is never retried — exactly one request", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return jsonResponse(401, { message: "Bad credentials" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { maxRetries: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5 });
    await assert.rejects(() => client.getAuthenticatedUser(), GitHubAuthError);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("a retry loop is bounded: after maxRetries + 1 total attempts, the classified error is still thrown", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return jsonResponse(503, { message: "Service Unavailable" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { maxRetries: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 5 });
    await assert.rejects(() => client.getAuthenticatedUser(), GitHubApiError);
    assert.equal(calls, 3, "1 initial attempt + 2 retries, never more");
  } finally {
    restore();
  }
});

test("a rate limit with a short Retry-After is retried once that wait elapses", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(403, { message: "secondary rate limit" }, { "retry-after": "0" });
    return jsonResponse(200, { login: "octocat" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { retryMaxDelayMs: 5000 });
    const user = await client.getAuthenticatedUser();
    assert.deepEqual(user, { login: "octocat" });
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("a rate limit whose suggested wait exceeds retryMaxDelayMs fails fast instead of blocking this call for a long time", async () => {
  let calls = 0;
  const resetEpoch = Math.floor(Date.now() / 1000) + 3600; // an hour away
  const restore = stubFetch(async () => {
    calls += 1;
    return jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpoch) });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { maxRetries: 3, retryMaxDelayMs: 2000 });
    const start = Date.now();
    await assert.rejects(() => client.getAuthenticatedUser(), GitHubRateLimitError);
    assert.ok(Date.now() - start < 500, "must fail fast, not wait out (or repeatedly poll against) an hour-long rate limit");
    assert.equal(calls, 1, "never retried — the wait would exceed the configured budget");
  } finally {
    restore();
  }
});

test("createPullRequest (a non-idempotent write) is never auto-retried, even on a transient-looking 500 — avoids a duplicate PR from a lost response", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return jsonResponse(500, { message: "Internal Server Error" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { maxRetries: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5 });
    await assert.rejects(() => client.createPullRequest("acme", "widgets", { title: "T", body: "B", head: "task/abc", base: "main" }), GitHubApiError);
    assert.equal(calls, 1, "exactly one POST — never retried automatically");
  } finally {
    restore();
  }
});

test("cancellation during a retry wait is honored immediately, not after the full delay", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return jsonResponse(500, { message: "Internal Server Error" });
  });
  try {
    const client = new GitHubClient("fake-token", undefined, { maxRetries: 5, retryBaseDelayMs: 5000, retryMaxDelayMs: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await assert.rejects(() => client.getAuthenticatedUser(controller.signal));
    assert.ok(Date.now() - start < 1000, "must not wait out the full 5s backoff after cancellation");
    assert.equal(calls, 1, "must not have started a second attempt after cancellation");
  } finally {
    restore();
  }
});
