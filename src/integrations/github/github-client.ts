/**
 * Narrow GitHub REST API client — the only place this platform makes an
 * HTTP request to api.github.com. Handles auth headers, response mapping,
 * retrying transient failures, and turning GitHub's error responses into a
 * small typed error vocabulary (`GitHubApiError` and its subclasses) —
 * nothing above this file ever sees a raw `fetch` Response or a raw GitHub
 * error body. See /docs/GITHUB_INTEGRATION.md "GitHub API client" and
 * "GitHub API error classification".
 *
 * Plain `fetch` (Node 24 built-in), not `@octokit/rest` — this needs a
 * handful of endpoints; see /docs/TECHNICAL_DECISIONS.md for why that didn't
 * justify a dependency, consistent with this codebase's existing pattern
 * (TD-17, TD-20, TD-31, TD-33).
 */
import { classifyGitHubError } from "./error-classifier.js";
import { computeBackoffDelayMs, sleepUnlessAborted } from "../../coding-engine/retry-backoff.js";
import { CancellationError } from "../../domain/errors.js";

const DEFAULT_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "codeforge-ai";

/** Bounds so an env var/caller can't accidentally configure a near-infinite or near-zero-delay retry loop — same idea as OpenCodeAdapter's, deliberately not shared code (see error-classifier.ts doc comment). */
const MAX_ALLOWED_RETRIES = 8;
const MAX_ALLOWED_DELAY_MS = 60 * 1000;

export interface GitHubClientOptions {
  /**
   * Retries AFTER the first attempt for transient/retryable failures (network
   * errors, 5xx, or a rate limit whose suggested wait fits within
   * `retryMaxDelayMs`) — see error-classifier.ts. Default 2 (so up to 3 total
   * attempts). Auth/authorization/not-found/conflict/invalid-request never
   * retry regardless of this value. Only applied to idempotent (read) calls —
   * see `request()`'s own doc comment for why a PR-creation POST never
   * auto-retries. Configurable via `GITHUB_MAX_RETRIES`, clamped to [0, 8].
   */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries. Default 500ms. Configurable via `GITHUB_RETRY_BASE_DELAY_MS`. */
  retryBaseDelayMs?: number;
  /** Upper bound on any single backoff delay, and the cutoff past which a rate limit's own suggested wait is treated as "too long to retry inline" (see request()). Default 10000ms. Configurable via `GITHUB_RETRY_MAX_DELAY_MS`. */
  retryMaxDelayMs?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Re-exported from errors.ts (not defined here) so error-classifier.ts can import the classes
// without a circular dependency on this file — every existing call site is unaffected.
export { GitHubApiError, GitHubNotFoundError, GitHubAuthError, GitHubRateLimitError } from "./errors.js";
import { GitHubApiError, GitHubNotFoundError, GitHubAuthError, GitHubRateLimitError } from "./errors.js";

export interface GitHubRepository {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}

export interface GitHubPullRequest {
  number: number;
  htmlUrl: string;
  state: string;
  /** Present (and meaningful) only on the single-PR fetch (`getPullRequest`) — the list/create
   *  endpoints don't return it, and a PR search result is never stale enough to need it. */
  merged?: boolean;
  /**
   * GitHub's own mergeable verdict — present only on the single-PR fetch
   * (`getPullRequest`), same as `merged`. `null`/`undefined` when GitHub
   * hasn't finished computing it yet (a real, expected transient state right
   * after a push) — never coerced to `true` or `false`.
   */
  mergeable?: boolean | null;
}

/** Ahead/behind commit counts between two refs — see GitHubClient.compareCommits. */
export interface GitHubCompareResult {
  aheadBy: number;
  behindBy: number;
  status: string; // "ahead" | "behind" | "diverged" | "identical"
}

/** A submitted PR review — carries the verdict ("state"), unlike a plain comment. */
export interface GitHubPullRequestReview {
  id: number;
  authorLogin: string;
  body: string;
  state: string; // "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED"
  submittedAt: string | null;
}

/** A general PR conversation comment (the "issue comments" API — PRs are issues in GitHub's model). */
export interface GitHubIssueComment {
  id: number;
  authorLogin: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export class GitHubClient {
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    options: GitHubClientOptions = {},
  ) {
    this.maxRetries = clamp(options.maxRetries ?? envInt("GITHUB_MAX_RETRIES", 2), 0, MAX_ALLOWED_RETRIES);
    this.retryBaseDelayMs = clamp(options.retryBaseDelayMs ?? envInt("GITHUB_RETRY_BASE_DELAY_MS", 500), 0, MAX_ALLOWED_DELAY_MS);
    this.retryMaxDelayMs = clamp(options.retryMaxDelayMs ?? envInt("GITHUB_RETRY_MAX_DELAY_MS", 10_000), this.retryBaseDelayMs, MAX_ALLOWED_DELAY_MS);
  }

  async getAuthenticatedUser(signal?: AbortSignal): Promise<{ login: string }> {
    const body = await this.request<{ login: string }>("GET", "/user", undefined, signal);
    return { login: body.login };
  }

  async getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepository> {
    const body = await this.request<{ full_name: string; default_branch: string; private: boolean; html_url: string }>(
      "GET",
      `/repos/${owner}/${repo}`,
      undefined,
      signal,
      `Repository ${owner}/${repo}`,
    );
    return { fullName: body.full_name, defaultBranch: body.default_branch, private: body.private, htmlUrl: body.html_url };
  }

  /** Returns null (not an error) if the branch doesn't exist — a missing branch is an expected, checkable condition, not a failure. */
  async getBranch(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<{ sha: string } | null> {
    try {
      const body = await this.request<{ commit: { sha: string } }>(
        "GET",
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
        undefined,
        signal,
      );
      return { sha: body.commit.sha };
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null;
      throw err;
    }
  }

  /**
   * First page (up to 100) of the repository's branch names — enough for
   * the task-creation "existing branch" picker's MVP scope; a repository
   * with more than 100 branches would need pagination this doesn't yet do
   * (see /docs/MVP_SCOPE.md). Not used for anything gating — only to
   * populate a UI list.
   */
  async listBranches(owner: string, repo: string, signal?: AbortSignal): Promise<string[]> {
    const body = await this.request<Array<{ name: string }>>(
      "GET",
      `/repos/${owner}/${repo}/branches?per_page=100`,
      undefined,
      signal,
    );
    return body.map((b) => b.name);
  }

  async listPullRequests(
    owner: string,
    repo: string,
    params: { head: string; base: string; state?: "open" | "closed" | "all" },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest[]> {
    const query = new URLSearchParams({
      head: `${owner}:${params.head}`,
      base: params.base,
      state: params.state ?? "open",
    });
    const body = await this.request<Array<{ number: number; html_url: string; state: string }>>(
      "GET",
      `/repos/${owner}/${repo}/pulls?${query.toString()}`,
      undefined,
      signal,
    );
    return body.map((pr) => ({ number: pr.number, htmlUrl: pr.html_url, state: pr.state }));
  }

  /**
   * NOT auto-retried on a transient failure (see `request()`'s `idempotent`
   * parameter) — creating a PR is not idempotent at the HTTP layer, and
   * blindly retrying a POST whose response was merely lost (but which GitHub
   * actually processed) would create a duplicate PR. Safe retry for this
   * operation happens one layer up: `GitHubSourceControlProvider.openPullRequest`
   * always searches for an existing PR before calling this, so a caller that
   * retries the whole *operation* (not just this one HTTP call) — the next
   * `checkHumanReviewFeedback`, worker poll, or crash-recovery attempt —
   * discovers the already-created PR instead of creating a second one. See
   * /docs/GITHUB_INTEGRATION.md "PR idempotency".
   */
  async createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; body: string; head: string; base: string },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest> {
    const body = await this.request<{ number: number; html_url: string; state: string }>(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      { title: input.title, body: input.body, head: input.head, base: input.base },
      signal,
      undefined,
      false, // not idempotent — see doc comment above
    );
    return { number: body.number, htmlUrl: body.html_url, state: body.state };
  }

  /**
   * The single PR's own current state, including `merged` — unlike
   * `listPullRequests`, which only ever returns the coarse `open`/`closed`
   * state a search returns. Used to decide whether a merged/closed PR's
   * feedback should still be acted on — see
   * /docs/GITHUB_INTEGRATION.md "PR state handling".
   */
  async getPullRequest(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubPullRequest> {
    const body = await this.request<{ number: number; html_url: string; state: string; merged: boolean; mergeable: boolean | null }>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}`,
      undefined,
      signal,
      `Pull request #${number}`,
    );
    return { number: body.number, htmlUrl: body.html_url, state: body.state, merged: body.merged, mergeable: body.mergeable ?? null };
  }

  /**
   * Real ahead/behind commit counts between `base` and `head` — the compare
   * API GitHub itself uses for its "X commits behind" UI. Used for
   * stale/behind detection (see /docs/TASK_LIFECYCLE.md "Stale/behind
   * detection") — never used to gate task execution, only to display.
   */
  async compareCommits(owner: string, repo: string, base: string, head: string, signal?: AbortSignal): Promise<GitHubCompareResult> {
    const body = await this.request<{ ahead_by: number; behind_by: number; status: string }>(
      "GET",
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      undefined,
      signal,
    );
    return { aheadBy: body.ahead_by, behindBy: body.behind_by, status: body.status };
  }

  /** Every submitted review on the PR — this is where a "changes requested" verdict lives. */
  async listPullRequestReviews(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubPullRequestReview[]> {
    const body = await this.request<Array<{ id: number; user: { login: string } | null; body: string | null; state: string; submitted_at: string | null }>>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      undefined,
      signal,
    );
    return body.map((r) => ({
      id: r.id,
      authorLogin: r.user?.login ?? "unknown",
      body: r.body ?? "",
      state: r.state,
      submittedAt: r.submitted_at,
    }));
  }

  /** General PR conversation comments (not inline diff comments) — the "issue comments" endpoint, since a PR is an issue. */
  async listIssueComments(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubIssueComment[]> {
    const body = await this.request<Array<{ id: number; user: { login: string } | null; body: string | null; created_at: string; updated_at: string }>>(
      "GET",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      undefined,
      signal,
    );
    return body.map((c) => ({
      id: c.id,
      authorLogin: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }

  /**
   * `idempotent` (default `true`): whether this specific call is safe to
   * automatically retry on a transient failure. Every read (`GET`) is;
   * `createPullRequest`'s `POST` explicitly passes `false` — see its own doc
   * comment for why. A retry only ever happens for a classification the
   * caller can't have caused (`retryable_transient`) or a rate limit whose
   * own suggested wait is short enough to be worth waiting out inline
   * (`suggestedDelayMs <= retryMaxDelayMs`) — a rate limit with a long reset
   * fails immediately instead of blocking this call for potentially an hour;
   * see /docs/GITHUB_INTEGRATION.md "Rate limit handling". Bounded to
   * `maxRetries` additional attempts — never an unbounded loop.
   */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    notFoundLabel?: string,
    idempotent = true,
  ): Promise<T> {
    const maxAttempts = idempotent ? this.maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.doRequest<T>(method, path, body, signal, notFoundLabel);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err; // cancellation — never retry, never reclassify
        const classification = classifyGitHubError(err);
        const withinDelayBudget = classification.suggestedDelayMs === null || classification.suggestedDelayMs <= this.retryMaxDelayMs;
        if (!classification.retryable || !withinDelayBudget || attempt >= maxAttempts) throw err;

        const delayMs = classification.suggestedDelayMs ?? computeBackoffDelayMs(attempt, this.retryBaseDelayMs, this.retryMaxDelayMs);
        console.error(
          `[github] ${method} ${path} attempt ${attempt}/${maxAttempts} failed (${classification.category}) — retrying in ${delayMs}ms: ${classification.reason}`,
        );
        await sleepUnlessAborted(delayMs, signal ?? new AbortController().signal, () => new CancellationError());
      }
    }
  }

  private async doRequest<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined, notFoundLabel?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
          "user-agent": USER_AGENT,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (signal?.aborted) throw err; // let the caller's own abort handling take over
      throw new GitHubApiError(`Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`, 0);
    }

    if (res.status === 401) throw new GitHubAuthError();
    if (res.status === 404) throw new GitHubNotFoundError(notFoundLabel ?? "Resource");
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfterHeader = res.headers.get("retry-after");
      // Two distinct GitHub rate limits share HTTP 403: the primary limit (x-ratelimit-remaining
      // reaches 0, resets at a known time) and the secondary/abuse-detection limit (no ratelimit
      // headers at all, just a `Retry-After`) — see /docs/GITHUB_INTEGRATION.md "Rate limit
      // handling". Either signal means "rate limited," not "forbidden."
      if (remaining === "0" || retryAfterHeader) {
        const resetHeader = res.headers.get("x-ratelimit-reset");
        const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        throw new GitHubRateLimitError(resetAt, Number.isFinite(retryAfterMs) ? retryAfterMs : null);
      }
    }
    if (!res.ok) {
      const message = await safeErrorMessage(res);
      throw new GitHubApiError(`GitHub API request failed (${res.status}): ${message}`, res.status);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** Extracts GitHub's own `message` field where present — never forwards raw headers/response internals. */
async function safeErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}
