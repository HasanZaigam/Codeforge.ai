import type { ContextBundle, HumanReviewFeedback, ReviewResult } from "../domain/types.js";

/**
 * Turns a ContextBundle into the text handed to a coding engine's CLI.
 * Deliberately small: the bundle itself is already the token-efficiency
 * boundary (see CONTEXT_ARCHITECTURE.md) — this just renders it as text
 * instead of re-summarizing the repository.
 */
export function buildImplementerPrompt(context: ContextBundle): string {
  const parts: string[] = [
    `Task: ${context.taskGoal}`,
    context.taskPlan ? `Existing plan (from a prior invocation on this same task):\n${context.taskPlan}` : "",
    context.priorDecisions.length
      ? `Known decisions/constraints so far:\n${context.priorDecisions.map((d) => `- (${d.source}) ${d.summary}`).join("\n")}`
      : "",
    context.lastFailure
      ? `The previous attempt failed validation. Diagnose and fix:\n${summarizeFailure(context)}`
      : "",
    context.reviewerFeedback ? buildReviewerFeedbackBlock(context.reviewerFeedback) : "",
    context.humanReviewFeedback ? buildHumanReviewFeedbackBlock(context.humanReviewFeedback) : "",
    `Project conventions: ${context.projectConventionPointer}`,
    context.reviewerFeedback || context.humanReviewFeedback
      ? "Work in the existing task workspace and branch — do not start over. Address the feedback above, then run the project's declared checks yourself before finishing."
      : "Investigate the repository at the current working directory, implement the change, and run the project's declared checks yourself before finishing. If you hit a decision only a human can make, stop and clearly state what you discovered, what you tried, and the specific question.",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Renders a human reviewer's GitHub PR "changes requested" review as
 * actionable feedback for the Implementer's fix pass — see
 * /docs/TASK_LIFECYCLE.md "Human review feedback loop". Uses the exact
 * "Human reviewer feedback" template so the Implementer can tell this apart
 * from the original task requirements, the AI Reviewer's own feedback, and
 * any previous validation failure — never buried in generic prior decisions.
 */
function buildHumanReviewFeedbackBlock(feedback: HumanReviewFeedback): string {
  return [
    "Human reviewer feedback",
    "",
    `Reviewer: ${feedback.reviewerLogin}`,
    "Review: Changes requested",
    `Comments: ${feedback.comments}`,
    "Requested changes: Address the feedback above before continuing. Do not undo valid existing work. Work in the existing task workspace and branch. Run the existing validation requirements after making the fixes.",
  ].join("\n");
}

/**
 * Renders an independent Reviewer's rejection as actionable feedback for the
 * Implementer's fix pass — see /docs/TASK_LIFECYCLE.md "Review/fix cycle".
 * Structured findings are itemized directly; when the Reviewer didn't
 * itemize (real models often respond in prose rather than a findings array
 * — see /docs/CODING_ENGINE.md), the Reviewer's own summary is included
 * instead so nothing the Reviewer actually said is silently dropped.
 */
function buildReviewerFeedbackBlock(review: ReviewResult): string {
  const findingsText = review.findings.length
    ? review.findings.map((f) => `- [${f.severity}/${f.category}] ${f.summary}${f.location ? ` (${f.location})` : ""}`).join("\n")
    : `(no itemized findings — the reviewer's own assessment: ${review.summary})`;
  return [
    "Reviewer verdict: Changes requested",
    `Reviewer findings:\n${findingsText}`,
    "Instructions: Address every reviewer finding above. Do not undo valid existing work.",
  ].join("\n\n");
}

export function buildReviewerPrompt(context: ContextBundle): string {
  const evidence = context.reviewEvidence;
  const parts: string[] = [
    `Task requirements: ${context.taskGoal}`,
    context.taskPlan ? `Plan that was executed:\n${context.taskPlan}` : "",
    evidence ? `Implementer's own summary: ${evidence.implementerSummary}` : "",
    evidence ? `Files changed: ${evidence.filesChanged.join(", ") || "(none reported)"}` : "",
    evidence
      ? `Validation results: ${evidence.validation.status} (${evidence.validation.checks
          .map((c) => `${c.name}: ${c.passed ? "pass" : "fail"}`)
          .join(", ")})`
      : "",
    "You did not write this change. Review it independently: identify correctness concerns, missing requirements, regressions, risky changes, test gaps, and security concerns where applicable. Do not simply say it looks good — return specific findings or explicitly state you found none.",
    // Deriving a verdict purely from structured findings undercounts real review content: most
    // model responses are prose, not a findings array (see /docs/CODING_ENGINE.md "Output
    // handling"). This explicit, easy-to-parse closing line is what makes "changes requested"
    // reachable at all for a real model, not just for a test double that fabricates findings — see
    // deriveReviewResult() in review/reviewer.ts, which looks for this exact line.
    'End your response with a line starting exactly with "VERDICT:" followed by either APPROVED or CHANGES_REQUESTED — nothing else on that line. If CHANGES_REQUESTED, list each issue on its own line directly above, starting with "FINDING:", in the form "FINDING: <severity: blocker|concern|note> | <category: correctness|missing_requirement|regression|risky_change|test_gap|security> | <description>".',
  ];
  return parts.filter(Boolean).join("\n\n");
}

function summarizeFailure(context: ContextBundle): string {
  if (!context.lastFailure) return "";
  return context.lastFailure.checks
    .filter((c) => !c.passed)
    .map((c) => `[${c.name}] exit ${c.exitCode}: ${c.logExcerpt}`)
    .join("\n");
}
