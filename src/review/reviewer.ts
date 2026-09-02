import type { Finding, ReviewResult, StepResult } from "../domain/types.js";

const VERDICT_LINE = /^VERDICT:\s*(APPROVED|CHANGES_REQUESTED)\s*$/im;
const FINDING_LINE = /^FINDING:\s*(blocker|concern|note)\s*\|\s*(correctness|missing_requirement|regression|risky_change|test_gap|security)\s*\|\s*(.+)$/gim;

/**
 * Turns the Reviewer invocation's StepResult into the platform's explicit
 * approve/reject decision. A "blocker"-severity finding always rejects; the
 * Orchestrator — not the model — is what acts on this verdict. See
 * /docs/TASK_LIFECYCLE.md "Evidence-based completion".
 *
 * Real models overwhelmingly respond in prose, not a structured `findings`
 * array (see /docs/CODING_ENGINE.md "Output handling") — `buildReviewerPrompt`
 * asks for an explicit `VERDICT:`/`FINDING:` line specifically so "changes
 * requested" is reachable at all outside of a test double that fabricates
 * findings. When `step.findings` already has structured entries (e.g.
 * FixtureCodingEngine-style test doubles, or a future engine that emits
 * them natively), those take priority and the text is not re-parsed for
 * findings — but an explicit `VERDICT:` line, if present, always wins over
 * the original completed-status heuristic below.
 */
export function deriveReviewResult(step: StepResult): ReviewResult {
  const { verdictFromText, findingsFromText } = parseReviewerText(step.summary);
  const findings = step.findings.length > 0 ? step.findings : findingsFromText;
  const hasBlocker = findings.some((f) => f.severity === "blocker");

  let verdict: ReviewResult["verdict"];
  if (verdictFromText === "rejected") {
    verdict = "rejected"; // an explicit model signal always wins
  } else if (verdictFromText === "approved") {
    verdict = hasBlocker ? "rejected" : "approved"; // a real blocker finding overrides a contradictory APPROVED line
  } else {
    // No explicit verdict line — original heuristic, unchanged for backward compatibility with
    // any engine/test double that predates this convention.
    verdict = step.status === "completed" && !hasBlocker ? "approved" : "rejected";
  }

  return {
    verdict,
    findings,
    confidence: step.confidence ?? "low",
    summary: step.summary,
  };
}

function parseReviewerText(summary: string): { verdictFromText: "approved" | "rejected" | null; findingsFromText: Finding[] } {
  const verdictMatch = summary.match(VERDICT_LINE);
  const verdictFromText = verdictMatch ? (verdictMatch[1]!.toUpperCase() === "APPROVED" ? "approved" : "rejected") : null;

  const findingsFromText: Finding[] = [];
  for (const m of summary.matchAll(FINDING_LINE)) {
    findingsFromText.push({ severity: m[1] as Finding["severity"], category: m[2] as Finding["category"], summary: m[3]!.trim() });
  }
  return { verdictFromText, findingsFromText };
}
