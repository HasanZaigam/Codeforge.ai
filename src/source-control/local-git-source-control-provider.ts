import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { OpenPullRequestRequest, SourceControlProvider } from "./source-control-provider.js";
import type { BranchComparisonStatus, GitCredential, HumanReviewFeedbackItem, Project, PullRequestRef, PullRequestStatus } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";
import { commitAllLocal } from "./git-commit.js";

const execFileAsync = promisify(execFile);

/**
 * Defense-in-depth for every git operation below that takes an untrusted ref
 * (branch/base-branch name) as a *combined* argv token (e.g. `"base...head"`
 * for `rev-list`) rather than each ref as its own separate argv element:
 * everything here is already argv-based `execFile` (never shell string
 * concatenation, so no shell metacharacter injection is possible regardless),
 * but a ref starting with `-` inside a combined token could still be
 * misread by git itself as an option rather than a revision — this rejects
 * that shape outright rather than ever passing it through. See
 * /docs/SECURITY_ARCHITECTURE.md.
 */
function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-");
}

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

  /**
   * No real PR concept for a plain local git remote (see class doc) — nothing external could ever
   * merge or close it, so this always reports open/unmerged, and `mergeable: null` ("not
   * applicable") rather than fabricating a true/false GitHub-style verdict that has no meaning here.
   */
  async getPullRequestStatus(_project: Project, _pr: PullRequestRef, _signal: AbortSignal): Promise<PullRequestStatus> {
    return { state: "open", merged: false, mergeable: null };
  }

  /**
   * Best-effort `git ls-remote --heads` against `project.repoUrl` — no
   * credential, no workspace/clone required (see SourceControlProvider.listBranches's
   * own doc comment). A local-git project is dev/testing-only and this is
   * purely advisory UI data, so any failure (unreachable path, no such repo)
   * is swallowed and reported as "no branches" rather than surfaced as an error.
   */
  async listBranches(project: Project, signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) throw new CancellationError();
    try {
      const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", project.repoUrl], { signal });
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.split("refs/heads/")[1])
        .filter((name): name is string => !!name);
    } catch (err) {
      if (signal.aborted) throw new CancellationError();
      return [];
    }
  }

  /**
   * Best-effort `git ls-remote --heads` filtered to the exact branch — same
   * "advisory, not a hard gate" policy as `listBranches` (see
   * SourceControlProvider.branchExists's own doc comment): a genuinely
   * unreachable remote reports `null` ("can't verify"), never `false`
   * ("confirmed missing") — only an actual empty match on a reachable remote
   * is `false`.
   */
  async branchExists(project: Project, branch: string, signal: AbortSignal): Promise<boolean | null> {
    if (signal.aborted) throw new CancellationError();
    if (!isSafeGitRef(branch)) return null;
    try {
      const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", project.repoUrl, branch], { signal });
      return stdout.trim().length > 0;
    } catch (err) {
      if (signal.aborted) throw new CancellationError();
      return null; // unreachable remote — can't verify, not "doesn't exist"
    }
  }

  /**
   * Real `git rev-list --left-right --count base...branch` plumbing against
   * `project.repoUrl` directly (a local path for this MVP/test provider —
   * same access pattern `listBranches` already uses, no clone/workspace
   * required). `left` = commits reachable from `baseBranch` but not
   * `branch` (how far behind); `right` = the reverse (how far ahead). Never
   * fabricated: an unreachable remote or unknown ref reports
   * `comparable: false`, not a guessed number.
   */
  async getBranchStatus(project: Project, branch: string, baseBranch: string, signal: AbortSignal): Promise<BranchComparisonStatus> {
    if (signal.aborted) throw new CancellationError();
    if (!isSafeGitRef(branch) || !isSafeGitRef(baseBranch)) return { comparable: false, aheadBy: null, behindBy: null };
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", project.repoUrl, "rev-list", "--left-right", "--count", `${baseBranch}...${branch}`],
        { signal },
      );
      const [behindStr, aheadStr] = stdout.trim().split(/\s+/);
      const behindBy = Number.parseInt(behindStr ?? "", 10);
      const aheadBy = Number.parseInt(aheadStr ?? "", 10);
      if (!Number.isFinite(behindBy) || !Number.isFinite(aheadBy)) return { comparable: false, aheadBy: null, behindBy: null };
      return { comparable: true, aheadBy, behindBy };
    } catch (err) {
      if (signal.aborted) throw new CancellationError();
      return { comparable: false, aheadBy: null, behindBy: null }; // unreachable remote / unknown ref — advisory only
    }
  }
}
