/**
 * GitHub API error vocabulary — split out from github-client.ts so
 * error-classifier.ts can import these classes without a circular
 * dependency (github-client.ts itself imports the classifier for retry
 * logic). Re-exported from github-client.ts for backward compatibility —
 * every existing call site keeps importing from there.
 */

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** The repository/branch doesn't exist OR the credential can't see it — GitHub itself doesn't distinguish these for private repos, and neither do we (see /docs/GITHUB_INTEGRATION.md "Repository connection"). */
export class GitHubNotFoundError extends GitHubApiError {
  constructor(what: string) {
    super(`${what} not found or not accessible with the connected GitHub account`, 404);
    this.name = "GitHubNotFoundError";
  }
}

export class GitHubAuthError extends GitHubApiError {
  constructor(message = "GitHub rejected the connected account's credentials") {
    super(message, 401);
    this.name = "GitHubAuthError";
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    public readonly resetAt: Date | null,
    /** GitHub's own `Retry-After` header value (seconds), when present — the secondary/abuse rate
     *  limit sends this instead of (or alongside) the primary limit's `x-ratelimit-reset`. Preferred
     *  over `resetAt` when both are present since it's the more specific signal. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super("GitHub API rate limit exceeded", 403);
    this.name = "GitHubRateLimitError";
  }
}
