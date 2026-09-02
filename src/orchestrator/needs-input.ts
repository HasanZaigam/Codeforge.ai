import type { CheckResult, HumanInputRequest, InputOption, NeedsInputDraft, ReviewResult } from "../domain/types.js";

/**
 * Enforces TD-10 (/docs/TECHNICAL_DECISIONS.md): a NEEDS_INPUT episode must
 * always carry real evidence of investigation, never just "I'm stuck."
 */
export interface NeedsInputRecordInput {
  discovered: string;
  attempted: string[];
  blocker: string;
  question: string;
  options: InputOption[];
}

export function assertNonTrivial(record: NeedsInputRecordInput): void {
  if (!record.discovered.trim() || !record.attempted.length || !record.blocker.trim() || !record.question.trim()) {
    throw new Error(
      "Refusing to raise NEEDS_INPUT without evidence of investigation (discovered/attempted/blocker/question required).",
    );
  }
}

export function fromImplementerDraft(draft: NeedsInputDraft): NeedsInputRecordInput {
  return {
    discovered: draft.discovered,
    attempted: draft.attempted,
    blocker: draft.blocker,
    question: draft.question,
    options: draft.options,
  };
}

/** Built when the self-fix loop exhausts its attempt budget without a passing validation run. */
export function fromExhaustedSelfFix(failedChecks: CheckResult[], attempts: number): NeedsInputRecordInput {
  const failing = failedChecks.filter((c) => !c.passed);
  return {
    discovered: `After ${attempts} implement-and-validate attempt(s), the following checks still fail: ${failing
      .map((c) => c.name)
      .join(", ")}.`,
    attempted: failing.map((c) => `Ran "${c.command}" — exit ${c.exitCode}. Last output: ${c.logExcerpt.slice(-300)}`),
    blocker: "The self-fix loop reached its configured attempt limit without a passing validation run.",
    question: "How should this task proceed — adjust the approach, provide missing information, or accept partial progress?",
    options: [
      { label: "Provide missing context", description: "Give the specific fact or constraint the implementer is missing." },
      { label: "Narrow the task", description: "Reduce scope so remaining work is achievable within limits." },
      { label: "Abandon this attempt", description: "Stop here; no further automated attempts will be made." },
    ],
  };
}

/**
 * Built when the review/fix cycle exhausts its configured budget (see
 * `OrchestratorConfig.maxReviewerRejections`) without the Reviewer ever
 * approving. Unlike an exhausted self-fix loop or an Implementer-signaled
 * ambiguity, this is NOT routed to NEEDS_INPUT — a Reviewer that keeps
 * finding new issues after repeated fix attempts is a bounded failure the
 * task fails cleanly out of, with the evidence preserved, rather than an
 * open-ended question for a human to answer. See
 * /docs/TASK_LIFECYCLE.md "Review/fix cycle" and TECHNICAL_DECISIONS.md.
 */
export function describeReviewCycleExhaustion(lastReview: ReviewResult, cycles: number): string {
  const findingsText = lastReview.findings.length
    ? lastReview.findings.map((f) => `[${f.severity}/${f.category}] ${f.summary}`).join("; ")
    : lastReview.summary;
  return `Independent review rejected the implementation after ${cycles} fix attempt${cycles === 1 ? "" : "s"}, reaching the configured review/fix cycle limit. Latest findings: ${findingsText}`;
}

export function toHumanInputRequest(
  id: string,
  taskId: string,
  record: NeedsInputRecordInput,
  now: string,
): HumanInputRequest {
  return {
    id,
    taskId,
    status: "open",
    discovered: record.discovered,
    attempted: record.attempted,
    blocker: record.blocker,
    question: record.question,
    options: record.options,
    answer: null,
    askedAt: now,
    answeredAt: null,
    answeredBy: null,
  };
}
