import type { BugReproductionResult, FixVerificationResult, ReviewResult, Task, ValidationResult, VerificationEvidence } from "../domain/types.js";

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
  // V1.1 Slice 1 — the platform's own git evidence (CommitResult.changedFiles), never the coding
  // engine's self-reported file list. `null` only for a caller that genuinely has none to show.
  changedFiles: string[] | null = null,
): string {
  const checksSection = validation.checks.length
    ? validation.checks.map((c) => `- ${c.name}: ${c.passed ? "passed" : "failed"}`).join("\n")
    : validation.outcome === "no_checks_configured"
      ? "No checks are declared for this project — nothing was run, and this is not the same as validation passing."
      : "No checks were declared for this project.";

  const findingsSection = review.findings.length
    ? review.findings.map((f) => `- **${f.severity}** (${f.category}): ${f.summary}`).join("\n")
    : "None";

  // The Reviewer's own prose (StepResult.summary, now real Markdown — see opencode-adapter.ts
  // "Output handling") is real analysis and shouldn't be silently discarded just because it isn't
  // structured findings — but only shown when there ARE no structured findings, so the two never
  // say the same thing twice.
  const reviewerNotes = !review.findings.length && review.summary.trim() ? `\n\n${review.summary.trim()}` : "";

  // See PLATFORM_GAPS.md GAP-016: never let "static review" read as "independently verified" to
  // whoever merges this. Always shown, not just when the reviewer is silent about it, since
  // "unknown" (the reviewer never said) needs to be visible too, not defaulted to looking verified.
  const verificationLabel =
    review.verificationMethod === "executed"
      ? "Executed — the reviewer ran a real command/check and reported its actual output above."
      : review.verificationMethod === "static"
        ? "Static — the reviewer read the diff; nothing was actually run to confirm it."
        : "Not stated — treat this review as static (read-only) unless the notes above show real command output.";

  const filesChangedSection = changedFiles !== null ? `\n\n## Files changed\n${changedFiles.length} file(s), per \`git status\` at commit time:\n${changedFiles.length ? changedFiles.map((f) => `- ${f}`).join("\n") : "(none)"}` : "";

  // V1.1 Slice 3 — see PLATFORM_GAPS.md GAP-016 item 12: "make it obvious that these are
  // PLATFORM-CAPTURED VERIFICATION EVIDENCE, not AI-generated claims." Only present for a task
  // created with a BugFixVerificationContract.
  const bugFixSection = task.taskRecord.bugFixVerification?.contract
    ? `\n\n## Bug-fix verification\n${renderBugFixVerification(task.taskRecord.bugFixVerification.reproduction, task.taskRecord.bugFixVerification.fixVerification)}`
    : "";

  // V1.1 Slice 2 — see PLATFORM_GAPS.md GAP-016, "AI may request verification. CodeForge owns
  // verification evidence." Only present when the Reviewer actually requested one this cycle;
  // renders the platform's own captured record, never the Reviewer's prose about it.
  const verificationEvidenceSection = review.verification ? `\n\n${renderVerificationEvidence(review.verification)}` : "";

  return [
    "# Task",
    task.goal,
    "",
    "## Implementation summary",
    implementerSummary,
    filesChangedSection,
    bugFixSection,
    "",
    "## Validation",
    checksSection,
    "",
    "## Independent review",
    `**Verdict:** ${review.verdict === "approved" ? "Approved" : "Changes requested"}`,
    `**Verification:** ${verificationLabel}`,
    "",
    `**Findings:** ${findingsSection}${reviewerNotes}${verificationEvidenceSection}`,
    "",
    "---",
    `_Opened automatically by AI Developer for this task. A human review and merge decision is still required — nothing here is merged automatically._`,
  ].join("\n");
}

/**
 * Renders reproduction/fix verification — real, platform-captured evidence,
 * never an AI's claim (see PLATFORM_GAPS.md GAP-016 items 8/12). `null`
 * for a step that hasn't run yet (e.g. the task just started, or the fix
 * has no post-implementation evidence recorded).
 */
function renderBugFixVerification(reproduction: BugReproductionResult | null, fixVerification: FixVerificationResult | null): string {
  const lines: string[] = [];
  if (reproduction) {
    lines.push(
      `**Reproduction (before implementation):** ${reproduction.status}`,
      `  Check: ${reproduction.evidence.checkId ?? "(none)"} — Commit: ${reproduction.evidence.commitSha ?? "(none)"} — Outcome: ${reproduction.evidence.outcome}`,
    );
  } else {
    lines.push("**Reproduction (before implementation):** not run yet");
  }
  if (fixVerification) {
    lines.push(
      `**Fix verification (after implementation):** ${fixVerification.status}`,
      `  Check: ${fixVerification.evidence.checkId ?? "(none)"} — Commit: ${fixVerification.evidence.commitSha ?? "(none)"} — Outcome: ${fixVerification.evidence.outcome}`,
    );
  } else {
    lines.push("**Fix verification (after implementation):** not run yet");
  }
  return lines.join("\n");
}

/** Renders the platform's own VerificationEvidence — see item 12's example format. */
function renderVerificationEvidence(v: VerificationEvidence): string {
  if (v.outcome === "rejected") {
    return ["**Verification request:**", `  Method: NOT_RUN`, `  Check requested: ${v.requested.checkId}`, `  Reason: ${v.rejectionReason}`].join("\n");
  }
  return [
    "**Verification request:**",
    `  Method: EXECUTED`,
    `  Check: ${v.checkId}`,
    v.commitSha ? `  Commit: ${v.commitSha}` : "",
    `  Outcome: ${v.outcome.toUpperCase()}`,
    v.exitCode !== null ? `  Exit code: ${v.exitCode}` : "",
    v.durationMs !== null ? `  Duration: ${(v.durationMs / 1000).toFixed(1)}s` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
