import type { Project, VerificationEvidence, VerificationOutcome, VerificationRequest } from "../domain/types.js";
import { runCheck } from "../validation/validation-runner.js";
import { getCurrentBranch, getHeadCommit } from "../source-control/git-commit.js";

/**
 * The only check identifiers a Reviewer may ever request — deliberately the
 * same four names `ProjectCommands` already recognizes, never a
 * Reviewer-supplied shell command. See PLATFORM_GAPS.md GAP-016 and
 * /docs/SECURITY_ARCHITECTURE.md "AI may request verification. CodeForge
 * owns verification evidence."
 */
const KNOWN_CHECK_NAMES = ["build", "test", "lint", "typecheck"] as const;
type KnownCheckName = (typeof KNOWN_CHECK_NAMES)[number];

function isKnownCheckName(value: string): value is KnownCheckName {
  return (KNOWN_CHECK_NAMES as readonly string[]).includes(value);
}

/**
 * The check ids a Reviewer may request for this project right now — only
 * ones the project has actually configured a command for. Never invents a
 * command for a check the project hasn't declared; used both to advertise
 * the options to the Reviewer (context-builder.ts) and to police an actual
 * request (resolveCommand below) — one source of truth for both.
 */
export function resolveApprovedVerificationChecks(project: Project): string[] {
  return KNOWN_CHECK_NAMES.filter((name) => Boolean(project.commands?.[name]));
}

/** `null` when `checkId` is not a known, approved name for this project — the caller must reject, never fall back to anything. */
function resolveCommand(project: Project, checkId: string): string | null {
  if (!isKnownCheckName(checkId)) return null;
  return project.commands?.[checkId] ?? null;
}

const CHECK_OUTCOME_TO_VERIFICATION_OUTCOME: Record<string, VerificationOutcome> = {
  passed: "passed",
  failed: "failed",
  timed_out: "timed_out",
  infrastructure_error: "infrastructure_error",
};

export interface ExecuteVerificationParams {
  workspacePath: string;
  /** The task's recorded branch — see VerificationEvidence.expectedBranch. */
  expectedBranch: string;
  project: Project;
  request: VerificationRequest;
  signal: AbortSignal;
  /** Test-only override — see validation-runner.ts runCheck's own equivalent parameter. Production callers never pass this. */
  checkTimeoutMsOverride?: number;
}

/**
 * Executes (or safely rejects) a request for one of the project's own
 * configured checks — the one path by which "this was actually executed"
 * can ever become platform truth. See PLATFORM_GAPS.md GAP-016 and
 * /docs/SECURITY_ARCHITECTURE.md "AI may request verification. CodeForge
 * owns verification evidence."
 *
 * Deliberately reuses validation-runner.ts's own exported `runCheck` (the
 * exact spawn/timeout/cancellation machinery `runValidation` already uses
 * for the Implementer's own checks) instead of a second execution engine —
 * the only new logic here is the request/policy/evidence layer around it.
 * A request for anything other than one of the project's own configured
 * build/test/lint/typecheck commands is rejected before a single process is
 * spawned; nothing ever supplies, and this never executes, an arbitrary
 * shell command or working directory.
 *
 * Read/verify-oriented only (item 10): this never touches git branches,
 * never commits, never pushes — it runs exactly one already-configured
 * project command inside the already-provisioned task workspace, the same
 * as any declared validation check.
 *
 * V1.1 Slice 2 introduced this for Reviewer-requested (`VERIFY:`)
 * verification; V1.1 Slice 3 reuses it unchanged for the platform's own
 * bug-fix reproduction/fix-verification checks (see
 * review/bug-fix-verification.ts) — the same mechanism, two different
 * callers, never a second implementation.
 */
export async function executeApprovedVerification(params: ExecuteVerificationParams): Promise<VerificationEvidence> {
  const { workspacePath, expectedBranch, project, request, signal, checkTimeoutMsOverride } = params;
  const startedAt = new Date().toISOString();
  const command = resolveCommand(project, request.checkId);

  if (!command) {
    const approved = resolveApprovedVerificationChecks(project);
    return {
      requested: request,
      outcome: "rejected",
      rejectionReason:
        approved.length > 0
          ? `"${request.checkId}" is not an approved verification check for this project — only ${approved.join(", ")} ${approved.length === 1 ? "is" : "are"} configured.`
          : `"${request.checkId}" is not an approved verification check — this project has no build/test/lint/typecheck commands configured at all.`,
      checkId: request.checkId,
      command: null,
      expectedBranch,
      actualBranch: null,
      commitSha: null,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      exitCode: null,
      logExcerpt: null,
    };
  }

  // Real state binding (item 4) — captured immediately before running, from the workspace itself,
  // never assumed to still equal whatever the orchestrator last recorded.
  const actualBranch = await getCurrentBranch(workspacePath, signal);
  const commitSha = await getHeadCommit(workspacePath, signal);

  const result = await runCheck(workspacePath, request.checkId, command, signal, checkTimeoutMsOverride);

  return {
    requested: request,
    outcome: CHECK_OUTCOME_TO_VERIFICATION_OUTCOME[result.outcome] ?? "failed",
    rejectionReason: null,
    checkId: request.checkId,
    command,
    expectedBranch,
    actualBranch,
    commitSha,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    logExcerpt: result.logExcerpt,
  };
}
