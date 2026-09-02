import type { ReviewResult, Task, ValidationResult } from "../domain/types.js";

/**
 * Builds PR title/description strictly from evidence the platform already
 * produced — the task's own goal, the Implementer's own summary, real
 * validation check results, and the independent Reviewer's real findings.
 * Never invents information the platform doesn't actually have (no fake
 * test counts, no fabricated praise) — see /docs/GITHUB_INTEGRATION.md
 * "Pull Request content".
 */
export function buildPullRequestTitle(task: Task): string {
  return task.title;
}

export function buildPullRequestDescription(
  task: Task,
  implementerSummary: string,
  validation: ValidationResult,
  review: ReviewResult,
): string {
  const checksSection = validation.checks.length
    ? validation.checks.map((c) => `- ${c.name}: ${c.passed ? "passed" : "failed"}`).join("\n")
    : "No checks were declared for this project.";

  const findingsSection = review.findings.length
    ? review.findings.map((f) => `- **${f.severity}** (${f.category}): ${f.summary}`).join("\n")
    : "None";

  // The Reviewer's own prose (StepResult.summary, now real Markdown — see opencode-adapter.ts
  // "Output handling") is real analysis and shouldn't be silently discarded just because it isn't
  // structured findings — but only shown when there ARE no structured findings, so the two never
  // say the same thing twice.
  const reviewerNotes = !review.findings.length && review.summary.trim() ? `\n\n${review.summary.trim()}` : "";

  return [
    "# Task",
    task.goal,
    "",
    "## Implementation summary",
    implementerSummary,
    "",
    "## Validation",
    checksSection,
    "",
    "## Independent review",
    `**Verdict:** ${review.verdict === "approved" ? "Approved" : "Changes requested"}`,
    "",
    `**Findings:** ${findingsSection}${reviewerNotes}`,
    "",
    "---",
    `_Opened automatically by AI Developer for this task. A human review and merge decision is still required — nothing here is merged automatically._`,
  ].join("\n");
}
