import type { ReviewResult, StepResult } from "../domain/types.js";

/**
 * Turns the Reviewer invocation's StepResult into the platform's explicit
 * approve/reject decision. A "blocker"-severity finding always rejects; the
 * Orchestrator — not the model — is what acts on this verdict. See
 * /docs/TASK_LIFECYCLE.md "Evidence-based completion".
 */
export function deriveReviewResult(step: StepResult): ReviewResult {
  const hasBlocker = step.findings.some((f) => f.severity === "blocker");
  const verdict: ReviewResult["verdict"] = step.status === "completed" && !hasBlocker ? "approved" : "rejected";
  return {
    verdict,
    findings: step.findings,
    confidence: step.confidence ?? "low",
    summary: step.summary,
  };
}
