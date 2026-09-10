import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenPullRequestRequest, SourceControlProvider } from "./source-control-provider.js";
import type { BranchComparisonStatus, GitCredential, HumanReviewFeedbackItem, Project, PullRequestRef, PullRequestStatus } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";
import { commitAllLocal } from "./git-commit.js";
import { gitCredentialEnv } from "./git-credential-env.js";
import { GitHubClient, GitHubNotFoundError } from "../integrations/github/github-client.js";
import { resolveGitHubToken } from "../integrations/github/credential-resolver.js";
import type { GitHubCredentialRepository } from "../persistence/repositories/github-credential-repository.js";
import { computeBackoffDelayMs, sleepUnlessAborted } from "../coding-engine/retry-backoff.js";

const execFileAsync = promisify(execFile);

export type GitHubClientFactory = (token: string) => GitHubClient;

/** Bounded retries for a `git push` that fails for a genuinely transient reason — see classifyGitPushError. Small and fixed, not env-configurable: this is a narrow, single-purpose retry, not a general-purpose knob. */
const PUSH_MAX_RETRIES = 2;
const PUSH_RETRY_BASE_DELAY_MS = 500;
const PUSH_RETRY_MAX_DELAY_MS = 5_000;

type GitPushFailureCategory = "retryable_transient" | "auth" | "authorization" | "conflict" | "unknown";

/**
 * Classifies a failed `git push`'s stderr text — the git-CLI counterpart to
 * `integrations/github/error-classifier.ts` (which classifies GitHub REST API
 * errors). Deliberately separate: git's own error text has no HTTP status
 * code to key off of. Conservative, same philosophy as every other
 * classifier in this codebase: only a recognized transient-network pattern
 * is retried — an auth/permission/non-fast-forward failure never is, so a
 * bad credential or a genuine conflict fails fast and clearly instead of
 * retrying into the same wall a few more times.
 */
export function classifyGitPushError(stderr: string): GitPushFailureCategory {
  const text = stderr.toLowerCase();
  if (/authentication failed|could not read username|invalid username or password|bad credentials/.test(text)) return "auth";
  if (/permission to .* denied|403|repository not found/.test(text)) return "authorization";
  if (/\[rejected\]|non-fast-forward|failed to push some refs|fetch first/.test(text)) return "conflict";
  if (
    /could not resolve host|connection timed out|connection reset|network is unreachable|temporary failure in name resolution|the remote end hung up unexpectedly|early eof|rpc failed|http\/2 stream|(?:^|\s)50[0-9](?:\s|$)|internal server error|timed out/.test(
      text,
    )
  ) {
    return "retryable_transient";
  }
  return "unknown";
}

/**
 * The real GitHub implementation of SourceControlProvider — see
 * /docs/GITHUB_INTEGRATION.md. Selected via `Project.sourceControlProvider
 * === "github"`. Every operation resolves the credential for
 * `project.ownerId` fresh (never cached across calls) via
 * `resolveGitHubToken`, and uses it only for the duration of one git
 * child-process or one GitHub API request — see git-credential-env.ts for
 * why it's never written to the workspace's git config.
 */
export class GitHubSourceControlProvider implements SourceControlProvider {
  readonly key = "github";

  constructor(
    private readonly credentials: GitHubCredentialRepository,
    private readonly encryptionKey: () => Buffer,
    private readonly clientFactory: GitHubClientFactory = (token) => new GitHubClient(token),
  ) {}

  async resolveCloneCredential(project: Project, _signal: AbortSignal): Promise<GitCredential> {
    const token = this.tokenFor(project);
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return { header: `Authorization: Basic ${basic}` };
  }

  async commitAll(_project: Project, workspacePath: string, message: string, signal: AbortSignal): Promise<string> {
    return commitAllLocal(workspacePath, message, signal); // purely local — no credential needed to commit
  }

  /**
   * Retries only a genuinely transient push failure (network-level — see
   * classifyGitPushError), bounded to `PUSH_MAX_RETRIES` extra attempts.
   * Never retries auth/permission/conflict failures — those need a human to
   * fix something, not another attempt. Safe to retry at all only because
   * pushing the exact same local branch state twice is itself idempotent at
   * the git level (a no-op if nothing changed, a fast-forward otherwise) —
   * see /docs/GITHUB_INTEGRATION.md "Push behavior"; no duplicate commit is
   * ever created by a push retry, since commits are made once, before this
   * is ever called (see `commitAll`/`commitAllLocal`'s own idempotency).
   */
  async push(project: Project, workspacePath: string, branch: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new CancellationError();
    const token = this.tokenFor(project);
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const credential = { header: `Authorization: Basic ${basic}` };
    const env = { ...process.env, ...gitCredentialEnv(credential) };

    const maxAttempts = PUSH_MAX_RETRIES + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: workspacePath, signal, env });
        return;
      } catch (err) {
        if (signal.aborted) throw new CancellationError();
        const stderr = sanitize(err);
        const category = classifyGitPushError(stderr);
        if (category !== "retryable_transient" || attempt >= maxAttempts) {
          // Never let the raw error (which could echo argv, though never the token — see
          // git-credential-env.ts) surface unfiltered; a clean, credential-free message only.
          throw new Error(`push to GitHub failed for branch "${branch}": ${stderr}`);
        }
        const delayMs = computeBackoffDelayMs(attempt, PUSH_RETRY_BASE_DELAY_MS, PUSH_RETRY_MAX_DELAY_MS);
        console.error(`[github] push to "${branch}" attempt ${attempt}/${maxAttempts} failed transiently — retrying in ${delayMs}ms: ${stderr}`);
        await sleepUnlessAborted(delayMs, signal, () => new CancellationError());
      }
    }
  }

  /**
   * Idempotent (see /docs/GITHUB_INTEGRATION.md "PR idempotency"): always
   * searches for an existing PR for this branch/base before creating one —
   * this is the second of two guards (the Orchestrator's own
   * `TaskRecord.pullRequest` check is the first) against a crash between a
   * successful push and a successful PR creation producing a duplicate PR.
   */
  async openPullRequest(project: Project, request: OpenPullRequestRequest, signal: AbortSignal): Promise<PullRequestRef> {
    if (signal.aborted) throw new CancellationError();
    if (!project.owner || !project.repo) {
      throw new Error(`Project ${project.id} has sourceControlProvider="github" but no owner/repo configured`);
    }
    const client = this.clientFactory(this.tokenFor(project));

    const existing = await withAbortAsCancellation(signal, () =>
      client.listPullRequests(project.owner!, project.repo!, { head: request.branch, base: request.baseBranch, state: "all" }, signal),
    );
    const found = existing.find((pr) => pr.state === "open") ?? existing[0];
    if (found) {
      return { provider: this.key, id: String(found.number), number: found.number, url: found.htmlUrl };
    }

    const created = await withAbortAsCancellation(signal, () =>
      client.createPullRequest(
        project.owner!,
        project.repo!,
        { title: request.title, body: request.description, head: request.branch, base: request.baseBranch },
        signal,
      ),
    );
    return { provider: this.key, id: String(created.number), number: created.number, url: created.htmlUrl };
  }

  /**
   * Reads reviews + conversation comments for `pr` and maps them to the
   * platform's small `HumanReviewFeedbackItem` shape — see
   * /docs/GITHUB_INTEGRATION.md "Human review feedback ingestion". Ids are
   * namespaced ("review:<n>"/"comment:<n>") so a review and a comment can
   * never collide, and both fetches run in parallel since they're
   * independent read-only requests.
   */
  async listPullRequestFeedback(project: Project, pr: PullRequestRef, signal: AbortSignal): Promise<HumanReviewFeedbackItem[]> {
    if (signal.aborted) throw new CancellationError();
    if (!project.owner || !project.repo || pr.number === null) return [];
    const client = this.clientFactory(this.tokenFor(project));

    // PR state handling (/docs/GITHUB_INTEGRATION.md "PR state handling"): a merged or closed PR
    // is never actionable — checking first avoids two wasted API calls, and (more importantly)
    // guarantees a stray/late review or comment on a PR that's already merged/closed can never
    // trigger a pointless fix cycle (pushing commits nobody will look at) on a later poll.
    const current = await withAbortAsCancellation(signal, () => client.getPullRequest(project.owner!, project.repo!, pr.number!, signal));
    if (current.merged || current.state !== "open") return [];

    const [reviews, comments] = await withAbortAsCancellation(signal, () =>
      Promise.all([
        client.listPullRequestReviews(project.owner!, project.repo!, pr.number!, signal),
        client.listIssueComments(project.owner!, project.repo!, pr.number!, signal),
      ]),
    );

    const reviewItems: HumanReviewFeedbackItem[] = reviews
      .filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED")
      .map((r) => ({
        id: `review:${r.id}`,
        kind: "review",
        verdict: r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes_requested" : "commented",
        body: r.body,
        authorLogin: r.authorLogin,
        createdAt: r.submittedAt ?? new Date(0).toISOString(),
        updatedAt: r.submittedAt ?? new Date(0).toISOString(),
      }));

    const commentItems: HumanReviewFeedbackItem[] = comments.map((c) => ({
      id: `comment:${c.id}`,
      kind: "comment",
      verdict: null,
      body: c.body,
      authorLogin: c.authorLogin,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    return [...reviewItems, ...commentItems];
  }

  /**
   * See SourceControlProvider.getPullRequestStatus's own doc comment. A
   * single `getPullRequest` call — the same one `listPullRequestFeedback`
   * already made internally, just with the `merged` field this method
   * actually surfaces to the caller instead of discarding it.
   */
  async getPullRequestStatus(project: Project, pr: PullRequestRef, signal: AbortSignal): Promise<PullRequestStatus> {
    if (signal.aborted) throw new CancellationError();
    if (!project.owner || !project.repo || pr.number === null) return { state: "open", merged: false, mergeable: null };
    const client = this.clientFactory(this.tokenFor(project));
    const current = await withAbortAsCancellation(signal, () => client.getPullRequest(project.owner!, project.repo!, pr.number!, signal));
    return {
      state: current.state === "closed" ? "closed" : "open",
      merged: current.merged === true,
      mergeable: current.mergeable ?? null,
    };
  }

  /** See SourceControlProvider.listBranches's own doc comment. */
  async listBranches(project: Project, signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) throw new CancellationError();
    if (!project.owner || !project.repo) {
      throw new Error(`Project ${project.id} has sourceControlProvider="github" but no owner/repo configured`);
    }
    const client = this.clientFactory(this.tokenFor(project));
    return withAbortAsCancellation(signal, () => client.listBranches(project.owner!, project.repo!, signal));
  }

  /** See SourceControlProvider.branchExists's own doc comment — a real, checkable GitHub API fact. */
  async branchExists(project: Project, branch: string, signal: AbortSignal): Promise<boolean | null> {
    if (signal.aborted) throw new CancellationError();
    if (!project.owner || !project.repo) {
      throw new Error(`Project ${project.id} has sourceControlProvider="github" but no owner/repo configured`);
    }
    const client = this.clientFactory(this.tokenFor(project));
    const branchRef = await withAbortAsCancellation(signal, () => client.getBranch(project.owner!, project.repo!, branch, signal));
    return branchRef !== null;
  }

  /**
   * See SourceControlProvider.getBranchStatus's own doc comment — GitHub's real compare API.
   * Advisory display data only (never a gate — see the interface's own doc comment), so a ref that
   * no longer exists (branch deleted, base renamed) reports `comparable: false` rather than
   * throwing; any other failure (auth, rate limit) is allowed to propagate — those are real,
   * surfaceable problems, not "nothing to compare."
   */
  async getBranchStatus(project: Project, branch: string, baseBranch: string, signal: AbortSignal): Promise<BranchComparisonStatus> {
    if (signal.aborted) throw new CancellationError();
    if (!project.owner || !project.repo) {
      throw new Error(`Project ${project.id} has sourceControlProvider="github" but no owner/repo configured`);
    }
    const client = this.clientFactory(this.tokenFor(project));
    try {
      const result = await withAbortAsCancellation(signal, () => client.compareCommits(project.owner!, project.repo!, baseBranch, branch, signal));
      return { comparable: true, aheadBy: result.aheadBy, behindBy: result.behindBy };
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return { comparable: false, aheadBy: null, behindBy: null };
      throw err;
    }
  }

  private tokenFor(project: Project): string {
    return resolveGitHubToken(this.credentials, this.encryptionKey(), project.ownerId);
  }
}

/**
 * Converts a network-level abort into the domain's own `CancellationError` —
 * `GitHubClient`'s own retry loop lets a genuine `AbortError` pass through
 * unconverted (see its own doc comment), so every call site that awaits a
 * `GitHubClient` method needs this, the same way `push()` above already
 * checked `signal.aborted` around its `execFileAsync` call. Without it, a
 * cancellation racing a GitHub API call would surface as a generic failure
 * (`TASK_FAILED`) instead of a clean `CANCELLED` — see
 * /docs/TASK_LIFECYCLE.md "Cancellation".
 */
async function withAbortAsCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (signal.aborted) throw new CancellationError();
    throw err;
  }
}

/** Strips anything that looks like an Authorization header value out of an error message before it's ever persisted to a TaskEvent. Defense in depth — the token is never in argv or env-dump form in these errors, but this guards against a future refactor accidentally introducing that. */
function sanitize(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/authorization:\s*bearer\s+\S+/gi, "authorization: bearer [redacted]")
    .replace(/authorization:\s*basic\s+\S+/gi, "authorization: basic [redacted]");
}
