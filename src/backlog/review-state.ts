import type { Project } from "../domain/types.js";
import type { BacklogAnalysis, BacklogItem, ClaimVerificationRecord, ReviewState, ReviewSummary } from "./backlog-types.js";
import { reconcile } from "./reconciliation.js";
import { applyVerificationRecords, planVerification, verificationCandidates } from "./verification.js";

/**
 * Review semantics for bulk backlog review (Phase 4A.5 — /docs/BACKLOG_INTELLIGENCE.md §4h). One small, explicit
 * vocabulary derived by the PLATFORM from the item's lifecycle status and its latest analysis; nothing a model returns can
 * set it. Two facts stay separate everywhere they are shown:
 *
 *     implementation:  present | possible | none_found | unknown        (does the repository contain the mechanism?)
 *     behavior:        BEHAVIOR_UNVERIFIED | CHECK_VERIFIED              (did a platform-run bound check establish it works?)
 *
 * "Implementation appears present" is therefore never a synonym for "fixed": an item can be POSSIBLY_ALREADY_IMPLEMENTED
 * with behavior still unverified, which is the normal case. Only VERIFIED_CONFLICT means behaviour was actually verified
 * against a reported absence.
 *
 * Precedence: VERIFIED_CONFLICT > POSSIBLY_ALREADY_IMPLEMENTED > NEEDS_CLARIFICATION > READY_FOR_PROPOSAL.
 */
export function deriveReview(item: Pick<BacklogItem, "status">, analysis: BacklogAnalysis | null): ReviewSummary {
  const assessment = analysis?.status === "succeeded" ? analysis.platformChecks?.assessment : undefined;
  const rec = assessment?.reconciliation;
  const inv = assessment?.investigation;
  const implementation: ReviewSummary["implementation"] = !rec
    ? "unknown"
    : rec.implementation === "present"
      ? "present"
      : rec.implementation === "possible"
        ? "possible"
        : inv?.signal === "NO_CONFLICTING_IMPLEMENTATION_EVIDENCE"
          ? "none_found"
          : "unknown";
  const behavior = rec?.behavior ?? "BEHAVIOR_UNVERIFIED";

  const leftReview = item.status === "CONVERTED" || item.status === "REJECTED" || item.status === "READY_FOR_TASK";
  let state: ReviewState | null;
  if (leftReview) state = null;
  else if (item.status === "NEW" || item.status === "ANALYZING" || !assessment) state = item.status === "NEEDS_CLARIFICATION" ? "NEEDS_CLARIFICATION" : "NEEDS_ANALYSIS";
  else if (rec?.findings.some((f) => f.outcome === "CHECK_CONTRADICTED")) state = "VERIFIED_CONFLICT";
  else if (implementation === "present" || implementation === "possible") state = "POSSIBLY_ALREADY_IMPLEMENTED";
  else if (item.status === "NEEDS_CLARIFICATION") state = "NEEDS_CLARIFICATION";
  else state = "READY_FOR_PROPOSAL";
  return { state, implementation, behavior };
}

/**
 * The analysis as it should be READ today: the stored assessment plus every recorded verification, with the requirement
 * rows and the reconciliation recomputed against the project's CURRENT approved checks. Stale or foreign records are ignored
 * by `reconcile` (and listed in `ignoredVerifications`). Pure; never writes.
 */
export function withVerification(analysis: BacklogAnalysis, records: ClaimVerificationRecord[], project: Pick<Project, "commands"> | null): BacklogAnalysis {
  const assessment = analysis.platformChecks?.assessment;
  const result = analysis.result;
  if (!analysis.platformChecks || !assessment || !result || !assessment.reconciliation) return analysis;
  const planned = { ...assessment, verification: planVerification(result.claims, project ?? { commands: null }), verificationCandidates: verificationCandidates(result.claims, project?.commands?.claimChecks) };
  const own = records.filter((r) => r.analysisId === analysis.id);
  const applied = applyVerificationRecords(planned, own, assessment.reconciliation.revision ?? "");
  const reconciliation = reconcile(result.claims, applied, assessment.reconciliation.revision, {
    investigation: assessment.investigation,
    verifications: own,
    checks: project?.commands?.claimChecks,
    analysisId: analysis.id,
  });
  return { ...analysis, platformChecks: { ...analysis.platformChecks, assessment: { ...applied, reconciliation } } };
}
