import type { ChildProcess } from "node:child_process";

export const DEFAULT_TERMINATION_GRACE_MS = 5000;

/**
 * Shared child-process termination policy for cancellation (see
 * /docs/TASK_LIFECYCLE.md "Cancellation" and TECHNICAL_DECISIONS.md): signal
 * SIGTERM, give the process a bounded grace period to exit on its own, then
 * SIGKILL if it hasn't. Used identically by ClaudeCodeAdapter (the coding
 * engine's own child process) and the validation runner (build/test/lint
 * child processes) — one policy, not two ad hoc ones.
 *
 * Only ever called with a specific `ChildProcess` this platform itself
 * spawned for one task's execution — never a PID or process group looked up
 * by name, and never anything resembling a shell-constructed kill command.
 * See /docs/SECURITY_ARCHITECTURE.md.
 */
export function terminateGracefully(child: ChildProcess, graceMs: number = DEFAULT_TERMINATION_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };

    child.once("close", finish);
    child.once("error", finish); // process already gone / couldn't be signaled — nothing more to do

    child.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, graceMs);
  });
}
