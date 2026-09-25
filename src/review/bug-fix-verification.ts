import type { BugFixVerificationContract, FixVerificationStatus, Project, ReproductionStatus, VerificationEvidence } from "../domain/types.js";
import { executeApprovedVerification } from "./reviewer-verification.js";

export interface RunContractCheckParams {
  workspacePath: string;
  expectedBranch: string;
  project: Project;
  contract: BugFixVerificationContract;
  signal: AbortSignal;
  /** Test-only override — see validation-runner.ts runCheck's own equivalent parameter. */
  checkTimeoutMsOverride?: number;
}

/**
 * Runs a BugFixVerificationContract's check exactly once — reproduction and
 * fix verification are the SAME call, made twice against two different
 * repository states (see orchestrator.ts's runWorkingEpisode). Reuses
 * `executeApprovedVerification` (the same mechanism Reviewer-requested
 * `VERIFY:` checks use — see PLATFORM_GAPS.md GAP-016) rather than a third
 * execution path; the only thing specific to bug-fix verification is the
 * status-derivation layer below.
 */
export function runContractCheck(params: RunContractCheckParams): Promise<VerificationEvidence> {
  const { contract, checkTimeoutMsOverride, ...rest } = params;
  return executeApprovedVerification({
    ...rest,
    request: { checkId: contract.checkId, purpose: contract.purpose },
    checkTimeoutMsOverride,
  });
}

/**
 * Deterministic pre-implementation mapping from real platform evidence to a
 * reproduction status — see BugFixVerificationContract's own doc comment on
 * `bugPresentWhenCheckOutcome`. Pure data, never an LLM judgment call:
 *
 * - the check didn't run to a real pass/fail (rejected/timed_out/
 *   infrastructure_error) → that outcome, passed straight through — no
 *   claim about the bug's presence can be made at all.
 * - the check ran and its real outcome equals `bugPresentWhenCheckOutcome`
 *   → the bug behaved exactly as expected → BUG_REPRODUCED.
 * - otherwise → BUG_NOT_REPRODUCED.
 */
export function deriveReproductionStatus(evidence: VerificationEvidence, contract: BugFixVerificationContract): ReproductionStatus {
  switch (evidence.outcome) {
    case "rejected":
      return "rejected";
    case "timed_out":
      return "timed_out";
    case "infrastructure_error":
      return "infrastructure_error";
    case "passed":
    case "failed":
      return evidence.outcome === contract.bugPresentWhenCheckOutcome ? "bug_reproduced" : "bug_not_reproduced";
  }
}

/**
 * Deterministic post-implementation mapping — the mirror image of
 * deriveReproductionStatus: "fixed" means the SAME check no longer shows the
 * "bug present" outcome. See CASE A-D in the Slice 3 brief ("NO FALSE
 * GREEN"): a timeout or infrastructure error after implementation is never
 * silently treated as FIX_VERIFIED just because it isn't a clean FAIL.
 */
export function deriveFixVerificationStatus(evidence: VerificationEvidence, contract: BugFixVerificationContract): FixVerificationStatus {
  switch (evidence.outcome) {
    case "rejected":
      return "rejected";
    case "timed_out":
      return "timed_out";
    case "infrastructure_error":
      return "infrastructure_error";
    case "passed":
    case "failed":
      return evidence.outcome !== contract.bugPresentWhenCheckOutcome ? "fix_verified" : "fix_not_verified";
  }
}
