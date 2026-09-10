import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CancellationError } from "../domain/errors.js";

const execFileAsync = promisify(execFile);

/**
 * The local `git add -A && git commit` sequence — identical for every
 * SourceControlProvider regardless of remote (committing is always local,
 * never needs a credential). Shared by LocalGitSourceControlProvider and
 * GitHubSourceControlProvider instead of duplicated.
 */
export async function commitAllLocal(workspacePath: string, message: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new CancellationError();
  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath, signal });
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath, signal });
  if (status.trim().length === 0) {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal });
    return stdout.trim(); // nothing to commit — idempotent no-op, return current HEAD
  }
  await execFileAsync(
    "git",
    ["-c", "user.email=platform@local", "-c", "user.name=AI Task Manager", "commit", "-m", message],
    { cwd: workspacePath, signal },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal });
  return stdout.trim();
}

/**
 * True if the workspace has literally nothing to commit or push: no uncommitted working-tree
 * changes AND HEAD is still exactly `baseCommit` (the commit the workspace was branched from —
 * see Workspace.baseCommit / LocalGitWorkspaceProvider.provision). Used by the orchestrator to
 * detect an implementer pass that correctly decided no change was safe/necessary to make, so it
 * can stop BEFORE ever calling commitAll/push/openPullRequest for that pass — see
 * /docs/TASK_LIFECYCLE.md "Zero-change detection" and orchestrator.ts's use right before its
 * first prepareChanges() call in runWorkingEpisode.
 *
 * Deliberately checks both conditions rather than just "working tree clean": on a crash-recovery
 * resume the workspace may already carry real, committed-but-not-yet-pushed changes from a prior
 * interrupted attempt (see provisionWorkspace's reuse-if-ready path) — a clean working tree alone
 * would wrongly look like "no changes" in that case. Comparing HEAD to the workspace's own
 * recorded `baseCommit` (not the base branch's current tip, which can move) is what makes this
 * correct regardless of how many prior implementer/commit cycles already ran in this episode.
 */
export async function hasNoRepositoryChanges(workspacePath: string, baseCommit: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new CancellationError();
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath, signal });
  if (status.trim().length > 0) return false;
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal });
  return head.trim() === baseCommit;
}
