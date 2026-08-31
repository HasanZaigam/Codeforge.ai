/**
 * Narrow GitHub REST API client — the only place this platform makes an
 * HTTP request to api.github.com. Handles auth headers, response mapping,
 * and turning GitHub's error responses into a small typed error vocabulary
 * (`GitHubApiError` and its subclasses) — nothing above this file ever sees
 * a raw `fetch` Response or a raw GitHub error body. See
 * /docs/GITHUB_INTEGRATION.md "GitHub API client".
 *
 * Plain `fetch` (Node 24 built-in), not `@octokit/rest` — this needs five
 * endpoints; see /docs/TECHNICAL_DECISIONS.md for why that didn't justify a
 * dependency, consistent with this codebase's existing pattern (TD-17,
 * TD-20, TD-31, TD-33).
 */

const DEFAULT_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "ai-task-manager";

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
  constructor(public readonly resetAt: Date | null) {
    super("GitHub API rate limit exceeded", 403);
    this.name = "GitHubRateLimitError";
  }
}

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
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

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
    );
    return { number: body.number, htmlUrl: body.html_url, state: body.state };
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    notFoundLabel?: string,
  ): Promise<T> {
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
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
      throw new GitHubRateLimitError(resetAt);
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
