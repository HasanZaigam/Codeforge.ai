import type { ContextBundle } from "../domain/types.js";

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
    `Project conventions: ${context.projectConventionPointer}`,
    "Investigate the repository at the current working directory, implement the change, and run the project's declared checks yourself before finishing. If you hit a decision only a human can make, stop and clearly state what you discovered, what you tried, and the specific question.",
  ];
  return parts.filter(Boolean).join("\n\n");
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
