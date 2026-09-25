import { spawn } from "node:child_process";
import type { CheckOutcome, CheckResult, ProjectCommands, ValidationResult } from "../domain/types.js";
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
 * that check is simply skipped (not failed) — see ValidationResult.outcome
 * below for how this is reported honestly rather than as an unqualified
 * "passed" (see PLATFORM_GAPS.md GAP-004). A future improvement is letting
 * the Implementer determine and propose the missing command once, then
 * persisting it via ProjectRepository.updateCommands (see
 * docs/MVP_SCOPE.md assumption #3).
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
  // Test-only override for DEFAULT_CHECK_TIMEOUT_MS below — production code never passes this, so
  // every real run keeps the same 5-minute budget it always has. Exists purely so the "timed_out"
  // outcome (see CheckOutcome) can be exercised in a test without an actual 5-minute wait.
  checkTimeoutMsOverride?: number,
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
    if (!command) continue; // undeclared checks are skipped, not failed — see ValidationResult.outcome
    if (signal.aborted) throw new CancellationError();
    checks.push(await runCheck(workspacePath, name, command, signal, checkTimeoutMsOverride ?? DEFAULT_CHECK_TIMEOUT_MS));
  }

  // `status` keeps its original meaning exactly — the self-fix loop's own gate ("did this pass, do
  // I need to retry"), unconditionally "passed" when there is nothing to check, same as before this
  // slice. `outcome` is the truthful field for anything reporting this to a human: it is the ONLY
  // place "no commands were configured" and "the configured commands genuinely passed" are told
  // apart — see PLATFORM_GAPS.md GAP-004 and ValidationOutcome's own doc comment.
  const status: ValidationResult["status"] = checks.every((c) => c.passed) ? "passed" : "failed";
  const outcome: ValidationResult["outcome"] =
    checks.length === 0 ? "no_checks_configured" : status === "passed" ? "checks_passed" : "checks_failed";
  return { status, outcome, checks, durationMs: Date.now() - start };
}

/**
 * Spawns one command and turns its real exit into a truthful CheckResult —
 * exported (V1.1 Slice 2) so a Reviewer-requested verification
 * (review/reviewer-verification.ts) reuses this exact spawn/timeout/
 * cancellation machinery instead of a second execution engine. `runValidation`
 * above is just this function called once per declared project command;
 * nothing about spawning, timing out, or cancelling differs for a
 * Reviewer-requested check. `checkTimeoutMs` defaults to the same 5-minute
 * budget every other caller gets, same as `runValidation`'s own default.
 */
export function runCheck(cwd: string, name: CheckResult["name"], command: string, signal: AbortSignal, checkTimeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    // Distinguishes "the timeout killed this" from "the process exited/was killed for some other
    // reason" — see CheckOutcome's own doc comment on why "timed_out" must never collapse into
    // "failed" the way a plain SIGKILL exit code (null) would otherwise be indistinguishable from.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, checkTimeoutMs);

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
      const outcome: CheckOutcome = timedOut ? "timed_out" : code === 0 ? "passed" : "failed";
      resolve({
        name,
        command,
        passed: outcome === "passed",
        outcome,
        exitCode: code,
        durationMs: Date.now() - start,
        logExcerpt: timedOut
          ? `${output.slice(-MAX_LOG_EXCERPT_CHARS)}\n\n[terminated: exceeded the ${checkTimeoutMs}ms check timeout]`
          : output.slice(-MAX_LOG_EXCERPT_CHARS),
      });
    });

    child.on("error", (err) => {
      // The command could not even be started (binary missing, permission denied to exec, ...) —
      // this is an environment/infrastructure problem, not a real assertion failure in the code
      // under test, and must never be reported the same way a genuine non-zero exit is.
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return;
      resolve({
        name,
        command,
        passed: false,
        outcome: "infrastructure_error",
        exitCode: null,
        durationMs: Date.now() - start,
        logExcerpt: String(err).slice(-MAX_LOG_EXCERPT_CHARS),
      });
    });
  });
}
