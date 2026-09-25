import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CancellationError } from "../domain/errors.js";
import { BranchMismatchError } from "../domain/errors.js";
import type { CommitResult } from "../domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * The workspace's actual current branch, straight from git — the only
 * source of truth this platform trusts for "what branch is the workspace
 * really on," as opposed to what the task record or workspace row believes
 * it should be. See BranchMismatchError's own doc comment for why this
 * distinction exists at all.
 */
export async function getCurrentBranch(workspacePath: string, signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath, signal });
  return stdout.trim();
}

/**
 * The workspace's real current HEAD commit sha — straight from git, same
 * "never trust anything but the repository itself" posture as
 * getCurrentBranch. Used (V1.1 Slice 2) to bind a Reviewer-requested
 * verification's evidence to the exact commit it actually ran against — see
 * domain/types.ts VerificationEvidence's own doc comment on commit binding.
 */
export async function getHeadCommit(workspacePath: string, signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal });
  return stdout.trim();
}

/**
 * Throws BranchMismatchError if the workspace's actual current branch is not
 * `expectedBranch` — the single choke point both commitAllLocal (below) and
 * every SourceControlProvider.push implementation call immediately before
 * doing anything to the remote or to git history. See PLATFORM_GAPS.md
 * GAP-015 and BranchMismatchError's own doc comment.
 */
export async function assertOnExpectedBranch(
  workspacePath: string,
  expectedBranch: string,
  operation: "commit" | "push",
  signal: AbortSignal,
): Promise<void> {
  const actualBranch = await getCurrentBranch(workspacePath, signal);
  if (actualBranch !== expectedBranch) {
    throw new BranchMismatchError(expectedBranch, actualBranch, operation);
  }
}

/** Parses `git status --porcelain` (v1) output into the plain list of paths it touches — a rename's `"R  old -> new"` line reports the new path, matching what a diff/PR would actually show as changed. */
function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3); // strip the 2-char status code + 1 space, per porcelain v1
    const arrow = rest.indexOf(" -> ");
    paths.push(arrow === -1 ? rest : rest.slice(arrow + 4));
  }
  return paths;
}

/**
 * The local `git add -A && git commit` sequence — identical for every
 * SourceControlProvider regardless of remote (committing is always local,
 * never needs a credential). Shared by LocalGitSourceControlProvider and
 * GitHubSourceControlProvider instead of duplicated.
 *
 * Two invariants this slice added on top of the original "add everything,
 * commit" behavior (see PLATFORM_GAPS.md GAP-015 and GAP-019):
 *
 * 1. `expectedBranch` is asserted BEFORE anything is staged. If the
 *    workspace is on a different branch than the task recorded for itself —
 *    most likely because the coding engine ran its own `git checkout` —
 *    this throws BranchMismatchError and stages/commits nothing. There is
 *    no safe branch to fall back to; the caller must fail the step.
 * 2. `changedFiles` in the returned CommitResult comes from `git status
 *    --porcelain`, read BEFORE `git add -A` runs — the platform's own git
 *    evidence of what actually changed, never the coding engine's
 *    self-reported file list (which is derived from its own tool-call log,
 *    a claim rather than evidence — see /docs/SECURITY_ARCHITECTURE.md "AI
 *    claims are not execution evidence"). This does not filter or exclude
 *    anything `git add -A` would have staged (a stack-agnostic "unrelated
 *    file" heuristic was deliberately not built — see the V1.1 Slice 1
 *    scope notes); it makes what was staged visible to the report instead,
 *    so a file no step of the task was asked to touch is at least no longer
 *    silent.
 */
export async function commitAllLocal(
  workspacePath: string,
  message: string,
  expectedBranch: string,
  signal: AbortSignal,
): Promise<CommitResult> {
  if (signal.aborted) throw new CancellationError();
  await assertOnExpectedBranch(workspacePath, expectedBranch, "commit", signal);

  const { stdout: statusBefore } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath, signal });
  const changedFiles = parsePorcelainPaths(statusBefore);
  if (changedFiles.length === 0) {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal });
    return { commitSha: stdout.trim(), changedFiles: [] }; // nothing to commit — idempotent no-op, return current HEAD
  }

  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath, signal });
  await execFileAsync(
    "git",
    ["-c", "user.email=platform@local", "-c", "user.name=AI Task Manager", "commit", "-m", message],
    { cwd: workspacePath, signal },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal });
  return { commitSha: stdout.trim(), changedFiles };
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
