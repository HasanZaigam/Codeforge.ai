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
