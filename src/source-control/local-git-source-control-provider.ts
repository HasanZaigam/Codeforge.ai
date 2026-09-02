import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { OpenPullRequestRequest, SourceControlProvider } from "./source-control-provider.js";
import type { GitCredential, HumanReviewFeedbackItem, Project, PullRequestRef } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";
import { commitAllLocal } from "./git-commit.js";

const execFileAsync = promisify(execFile);

/**
 * MVP/test SourceControlProvider: operates on the local git checkout
 * produced by LocalGitWorkspaceProvider, against whatever remote ("origin")
 * the workspace was cloned from. Selected via `Project.sourceControlProvider
 * === "local-git"` — used by the demo/CLI harness and the entire automated
 * test suite (see /docs/GITHUB_INTEGRATION.md "Testing without GitHub") so
 * none of it depends on live GitHub credentials.
 *
 * DOCUMENTED BOUNDARY: `openPullRequest` does NOT call any real API — there
 * is no PR concept for a plain local git remote. It returns a local
 * reference (the pushed branch) so the Orchestrator/task lifecycle can still
 * reach REVIEW and the report can point at the branch. `GitHubSourceControlProvider`
 * implements the same interface with a real PR and requires no change to
 * any calling code — see /docs/INTEGRATION_ARCHITECTURE.md.
 */
export class LocalGitSourceControlProvider implements SourceControlProvider {
  readonly key = "local-git";

  async resolveCloneCredential(_project: Project, _signal: AbortSignal): Promise<GitCredential | null> {
    return null; // local fixture/dev remotes need no auth
  }

  async commitAll(_project: Project, workspacePath: string, message: string, signal: AbortSignal): Promise<string> {
    return commitAllLocal(workspacePath, message, signal);
  }

  async push(_project: Project, workspacePath: string, branch: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new CancellationError();
    try {
      const { stdout } = await execFileAsync("git", ["remote"], { cwd: workspacePath, signal });
      if (stdout.trim().length === 0) return; // no remote configured (e.g. bare fixture) — nothing to push to
      await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: workspacePath, signal });
    } catch (err) {
      if (signal.aborted) throw new CancellationError();
      throw new Error(`push failed for branch "${branch}": ${String(err)}`);
    }
  }

  async openPullRequest(_project: Project, _request: OpenPullRequestRequest, _signal: AbortSignal): Promise<PullRequestRef> {
    return { provider: this.key, id: randomUUID(), number: null, url: null };
  }

  /** No PR-review concept for a plain local git remote (see class doc) — always empty. */
  async listPullRequestFeedback(_project: Project, _pr: PullRequestRef, _signal: AbortSignal): Promise<HumanReviewFeedbackItem[]> {
    return [];
  }
}
