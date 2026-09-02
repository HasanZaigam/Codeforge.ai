import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGitHubError } from "../src/integrations/github/error-classifier.js";
import { GitHubApiError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from "../src/integrations/github/errors.js";

test("GitHubAuthError classifies as auth, never retryable", () => {
  const c = classifyGitHubError(new GitHubAuthError());
  assert.equal(c.category, "auth");
  assert.equal(c.retryable, false);
  assert.equal(c.suggestedDelayMs, null);
});

test("GitHubNotFoundError classifies as not_found, never retryable", () => {
  const c = classifyGitHubError(new GitHubNotFoundError("Repository acme/widgets"));
  assert.equal(c.category, "not_found");
  assert.equal(c.retryable, false);
});

test("GitHubRateLimitError classifies as rate_limited, retryable, with a suggested delay from retryAfterMs when present", () => {
  const c = classifyGitHubError(new GitHubRateLimitError(null, 30_000));
  assert.equal(c.category, "rate_limited");
  assert.equal(c.retryable, true);
  assert.equal(c.suggestedDelayMs, 30_000);
});

test("GitHubRateLimitError falls back to resetAt when retryAfterMs is absent", () => {
  const resetAt = new Date(Date.now() + 5000);
  const c = classifyGitHubError(new GitHubRateLimitError(resetAt, null));
  assert.equal(c.category, "rate_limited");
  assert.ok(c.suggestedDelayMs !== null && c.suggestedDelayMs > 4000 && c.suggestedDelayMs <= 5000);
});

test("a 403 (not rate limit) classifies as authorization, never retryable", () => {
  const c = classifyGitHubError(new GitHubApiError("Resource not accessible by integration", 403));
  assert.equal(c.category, "authorization");
  assert.equal(c.retryable, false);
});

test("a 409 classifies as conflict, never retryable", () => {
  const c = classifyGitHubError(new GitHubApiError("Merge conflict", 409));
  assert.equal(c.category, "conflict");
  assert.equal(c.retryable, false);
});

test("400 and 422 classify as invalid_request, never retryable", () => {
  assert.equal(classifyGitHubError(new GitHubApiError("Bad request", 400)).category, "invalid_request");
  assert.equal(classifyGitHubError(new GitHubApiError("Validation failed", 422)).category, "invalid_request");
  assert.equal(classifyGitHubError(new GitHubApiError("Validation failed", 422)).retryable, false);
});

test("5xx and status 0 (network failure) classify as retryable_transient", () => {
  assert.equal(classifyGitHubError(new GitHubApiError("Internal Server Error", 500)).category, "retryable_transient");
  assert.equal(classifyGitHubError(new GitHubApiError("Bad Gateway", 502)).category, "retryable_transient");
  assert.equal(classifyGitHubError(new GitHubApiError("Could not reach GitHub", 0)).retryable, true);
});

test("an unrecognized status classifies as unknown, never retryable", () => {
  const c = classifyGitHubError(new GitHubApiError("I'm a teapot", 418));
  assert.equal(c.category, "unknown");
  assert.equal(c.retryable, false);
});

test("a raw (non-GitHubApiError) error is treated as transient — e.g. a DNS failure before any status code exists", () => {
  const c = classifyGitHubError(new TypeError("fetch failed"));
  assert.equal(c.category, "retryable_transient");
  assert.equal(c.retryable, true);
});

test("no classification ever includes the token/credential in its reason", () => {
  const c = classifyGitHubError(new GitHubApiError("GitHub API request failed (500): Internal Server Error", 500));
  assert.ok(!c.reason.toLowerCase().includes("bearer"));
  assert.ok(!c.reason.toLowerCase().includes("ghp_"));
});
