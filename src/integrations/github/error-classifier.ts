import { GitHubApiError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from "./errors.js";

/**
 * Classifies a failed GitHub REST API call for retry purposes — the
 * GitHub-specific counterpart to `coding-engine/engine-failure-classifier.ts`
 * (which classifies OpenCode/model-provider failures). Deliberately separate:
 * the error surface is completely different (typed HTTP-status exceptions
 * here vs. parsed NDJSON child-process output there), and conflating them
 * would mean one classifier guessing about errors it was never designed for.
 * See /docs/GITHUB_INTEGRATION.md "GitHub API error classification".
 *
 * Conservative by design, same philosophy as the OpenCode classifier:
 * anything not clearly transient is treated as non-retryable — blindly
 * retrying an auth/permission/invalid-request failure just turns a fast,
 * clear error into a slow one.
 */

export type GitHubFailureCategory =
  | "retryable_transient"
  | "rate_limited"
  | "auth"
  | "authorization"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "unknown";

export interface GitHubFailureClassification {
  category: GitHubFailureCategory;
  retryable: boolean;
  /** Human-readable, safe to put in a TaskEvent/log line — never contains the token (GitHubApiError's own message is already sanitized, see github-client.ts's safeErrorMessage). */
  reason: string;
  /** GitHub's own suggested wait, if any (Retry-After header, or the rate-limit reset time) — null when there's no such hint. */
  suggestedDelayMs: number | null;
}

export function classifyGitHubError(err: unknown): GitHubFailureClassification {
  if (err instanceof GitHubRateLimitError) {
    const suggestedDelayMs = err.retryAfterMs ?? (err.resetAt ? Math.max(0, err.resetAt.getTime() - Date.now()) : null);
    return { category: "rate_limited", retryable: true, reason: err.message, suggestedDelayMs };
  }
  if (err instanceof GitHubAuthError) {
    return { category: "auth", retryable: false, reason: err.message, suggestedDelayMs: null };
  }
  if (err instanceof GitHubNotFoundError) {
    return { category: "not_found", retryable: false, reason: err.message, suggestedDelayMs: null };
  }
  if (err instanceof GitHubApiError) {
    const { status } = err;
    if (status === 403) return { category: "authorization", retryable: false, reason: err.message, suggestedDelayMs: null };
    if (status === 409) return { category: "conflict", retryable: false, reason: err.message, suggestedDelayMs: null };
    if (status === 400 || status === 422) return { category: "invalid_request", retryable: false, reason: err.message, suggestedDelayMs: null };
    if (status === 0 || status >= 500) return { category: "retryable_transient", retryable: true, reason: err.message, suggestedDelayMs: null };
    return { category: "unknown", retryable: false, reason: err.message, suggestedDelayMs: null };
  }
  // A raw network/fetch-level error (not one of GitHubClient's own typed exceptions) — e.g. DNS
  // failure, connection reset, before a status code was ever received. Treated as transient: the
  // same class of failure `status === 0` above represents, just not wrapped in GitHubApiError.
  const message = err instanceof Error ? err.message : String(err);
  return { category: "retryable_transient", retryable: true, reason: message, suggestedDelayMs: null };
}
