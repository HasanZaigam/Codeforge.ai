import type { Finding, ReviewResult, StepResult, VerificationEvidence, VerificationMethod, VerificationRequest } from "../domain/types.js";

const VERDICT_LINE = /^VERDICT:\s*(APPROVED|CHANGES_REQUESTED)\s*$/im;
const FINDING_LINE = /^FINDING:\s*(blocker|concern|note)\s*\|\s*(correctness|missing_requirement|regression|risky_change|test_gap|security)\s*\|\s*(.+)$/gim;
/**
 * V1.1 Slice 1 (see PLATFORM_GAPS.md GAP-016, "'Independently verified' means
 * read, not run"): mirrors the VERDICT: convention so a real model has an
 * explicit, easy-to-emit way to say which kind of review it just did.
 * `buildReviewerPrompt` asks for this line and forbids the phrase
 * "independently verified" unless it is "EXECUTED". Absence of the line
 * (any engine/test double that predates this convention) resolves to
 * `"unknown"` — never silently assumed to be `"executed"`. V1.1 Slice 2:
 * this text claim alone can no longer make `verificationMethod` become
 * `"executed"` — see deriveReviewResult below.
 */
const VERIFICATION_LINE = /^VERIFICATION:\s*(STATIC|EXECUTED)\s*$/im;
/**
 * V1.1 Slice 2 — see PLATFORM_GAPS.md GAP-016, "AI may request verification.
 * CodeForge owns verification evidence." A Reviewer that wants a concrete
 * behavioral claim confirmed rather than just read may respond with this
 * line instead of (or before) its final VERDICT — `buildReviewerPrompt`
 * explains the two-step protocol. The captured id is only ever a candidate:
 * whether it's actually approved/configured for this project is decided by
 * reviewer-verification.ts's resolveApprovedVerificationChecks, never here.
 */
const VERIFY_LINE = /^VERIFY:\s*(\S+)\s*$/im;
const PURPOSE_LINE = /^PURPOSE:\s*(.+)$/im;

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
/**
 * V1.1 Slice 2 — `verification` is the platform's own evidence of a
 * Reviewer-requested check (or `null` if the Reviewer never requested one
 * this cycle); see orchestrator.ts's review/fix cycle for how it's produced
 * before this function is ever called on the Reviewer's final response.
 */
export function deriveReviewResult(step: StepResult, verification: VerificationEvidence | null = null): ReviewResult {
  const { verdictFromText, findingsFromText, verificationMethodClaimed } = parseReviewerText(step.summary);
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

  // V1.1 Slice 2 (see PLATFORM_GAPS.md GAP-016, "AI may request verification. CodeForge owns
  // verification evidence."): "executed" can ONLY come from real platform evidence of an
  // actually-run check — never from the Reviewer's own text claim alone. A Reviewer that writes
  // "VERIFICATION: EXECUTED" with no backing evidence (it never requested one, or the request was
  // rejected) is downgraded to "static": it did at least read the diff, and nothing here can prove
  // it did anything more than that, so it is never presented as more thorough than it was.
  const platformExecuted = verification !== null && verification.outcome !== "rejected";
  const verificationMethod: VerificationMethod = platformExecuted ? "executed" : verificationMethodClaimed === "executed" ? "static" : verificationMethodClaimed;

  return {
    verdict,
    findings,
    confidence: step.confidence ?? "low",
    summary: step.summary,
    verificationMethod,
    verification,
  };
}

/**
 * V1.1 Slice 2 — parses a Reviewer's `VERIFY: <checkId>` (+ optional
 * `PURPOSE: <reason>`) request. Returns `null` for anything that doesn't
 * match the exact expected shape (no line, or a malformed one) — a
 * malformed/absent request is safely ignored, never a fallback to executing
 * something anyway. Whether the returned `checkId` is actually approved for
 * this project is decided later, by reviewer-verification.ts — this
 * function only extracts what the Reviewer asked for.
 */
export function parseVerificationRequest(summary: string): VerificationRequest | null {
  const match = summary.match(VERIFY_LINE);
  if (!match) return null;
  const purposeMatch = summary.match(PURPOSE_LINE);
  return { checkId: match[1]!, purpose: purposeMatch ? purposeMatch[1]!.trim() : null };
}

function parseReviewerText(summary: string): { verdictFromText: "approved" | "rejected" | null; findingsFromText: Finding[]; verificationMethodClaimed: VerificationMethod } {
  const verdictMatch = summary.match(VERDICT_LINE);
  const verdictFromText = verdictMatch ? (verdictMatch[1]!.toUpperCase() === "APPROVED" ? "approved" : "rejected") : null;

  const findingsFromText: Finding[] = [];
  for (const m of summary.matchAll(FINDING_LINE)) {
    findingsFromText.push({ severity: m[1] as Finding["severity"], category: m[2] as Finding["category"], summary: m[3]!.trim() });
  }

  const verificationMatch = summary.match(VERIFICATION_LINE);
  const verificationMethodClaimed: VerificationMethod = verificationMatch
    ? verificationMatch[1]!.toUpperCase() === "EXECUTED"
      ? "executed"
      : "static"
    : "unknown";

  return { verdictFromText, findingsFromText, verificationMethodClaimed };
}
