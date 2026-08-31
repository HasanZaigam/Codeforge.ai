import { spawn } from "node:child_process";
import type { CheckResult, ProjectCommands, ValidationResult } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";
import { terminateGracefully } from "../process/terminate-gracefully.js";

const MAX_LOG_EXCERPT_CHARS = 2000;
const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs the checks a project has declared (build/test/lint/typecheck) as
 * plain shell commands inside the workspace — never hardcoded to a
 * language or framework. See /docs/ARCHITECTURE.md layer 11 and
 * /docs/CONTEXT_ARCHITECTURE.md on why commands are project config, not
 * platform code.
 *
 * Pragmatic MVP discovery: if a project has not declared a given command,
 * that check is simply skipped (not failed) — see runValidation's return
 * for how this is reported. A future improvement is letting the Implementer
 * determine and propose the missing command once, then persisting it via
 * ProjectRepository.updateCommands (see docs/MVP_SCOPE.md assumption #3).
 *
 * Cancellation: an aborted `signal` stops the currently running check
 * (graceful SIGTERM, bounded grace period, then SIGKILL — same policy as
 * ClaudeCodeAdapter, see terminate-gracefully.ts) and skips any remaining
 * ones, throwing CancellationError rather than returning a bogus "failed"
 * result — a cancelled validation run is not a failed one. See
 * /docs/TASK_LIFECYCLE.md "Cancellation".
 */
export async function runValidation(
  workspacePath: string,
  commands: ProjectCommands | null,
  signal: AbortSignal,
): Promise<ValidationResult> {
  const start = Date.now();
  const declared: Array<{ name: CheckResult["name"]; command: string | undefined }> = [
    { name: "build", command: commands?.build },
    { name: "typecheck", command: commands?.typecheck },
    { name: "lint", command: commands?.lint },
    { name: "test", command: commands?.test },
  ];

  const checks: CheckResult[] = [];
  for (const { name, command } of declared) {
    if (!command) continue; // undeclared checks are skipped, not failed
    if (signal.aborted) throw new CancellationError();
    checks.push(await runCheck(workspacePath, name, command, signal));
  }

  const status: ValidationResult["status"] = checks.every((c) => c.passed) ? "passed" : "failed";
  return { status, checks, durationMs: Date.now() - start };
}

function runCheck(cwd: string, name: CheckResult["name"], command: string, signal: AbortSignal): Promise<CheckResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), DEFAULT_CHECK_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      terminateGracefully(child).then(() => reject(new CancellationError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));

    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return; // handled by onAbort's own rejection
      resolve({
        name,
        command,
        passed: code === 0,
        exitCode: code,
        durationMs: Date.now() - start,
        logExcerpt: output.slice(-MAX_LOG_EXCERPT_CHARS),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return;
      resolve({
        name,
        command,
        passed: false,
        exitCode: null,
        durationMs: Date.now() - start,
        logExcerpt: String(err).slice(-MAX_LOG_EXCERPT_CHARS),
      });
    });
  });
}
