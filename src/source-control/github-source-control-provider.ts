import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenPullRequestRequest, SourceControlProvider } from "./source-control-provider.js";
import type { GitCredential, Project, PullRequestRef } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";
import { commitAllLocal } from "./git-commit.js";
import { gitCredentialEnv } from "./git-credential-env.js";
import { GitHubClient } from "../integrations/github/github-client.js";
import { resolveGitHubToken } from "../integrations/github/credential-resolver.js";
import type { GitHubCredentialRepository } from "../persistence/repositories/github-credential-repository.js";

const execFileAsync = promisify(execFile);

export type GitHubClientFactory = (token: string) => GitHubClient;

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
    return { header: `Authorization: Bearer ${token}` };
  }

  async commitAll(_project: Project, workspacePath: string, message: string, signal: AbortSignal): Promise<string> {
    return commitAllLocal(workspacePath, message, signal); // purely local — no credential needed to commit
  }

  async push(project: Project, workspacePath: string, branch: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new CancellationError();
    const credential = { header: `Authorization: Bearer ${this.tokenFor(project)}` };
    const env = { ...process.env, ...gitCredentialEnv(credential) };
    try {
      await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: workspacePath, signal, env });
    } catch (err) {
      if (signal.aborted) throw new CancellationError();
      // Never let the raw error (which could echo argv, though never the token — see
      // git-credential-env.ts) surface unfiltered; a clean, credential-free message only.
      throw new Error(`push to GitHub failed for branch "${branch}": ${sanitize(err)}`);
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

    const existing = await client.listPullRequests(
      project.owner,
      project.repo,
      { head: request.branch, base: request.baseBranch, state: "all" },
      signal,
    );
    const found = existing.find((pr) => pr.state === "open") ?? existing[0];
    if (found) {
      return { provider: this.key, id: String(found.number), number: found.number, url: found.htmlUrl };
    }

    const created = await client.createPullRequest(
      project.owner,
      project.repo,
      { title: request.title, body: request.description, head: request.branch, base: request.baseBranch },
      signal,
    );
    return { provider: this.key, id: String(created.number), number: created.number, url: created.htmlUrl };
  }

  private tokenFor(project: Project): string {
    return resolveGitHubToken(this.credentials, this.encryptionKey(), project.ownerId);
  }
}

/** Strips anything that looks like an Authorization header value out of an error message before it's ever persisted to a TaskEvent. Defense in depth — the token is never in argv or env-dump form in these errors, but this guards against a future refactor accidentally introducing that. */
function sanitize(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/authorization:\s*bearer\s+\S+/gi, "authorization: bearer [redacted]");
}
