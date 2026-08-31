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

/** Built when the Reviewer rejects the change more times than the configured budget allows. */
export function fromExhaustedReview(lastReview: ReviewResult, rejections: number): NeedsInputRecordInput {
  return {
    discovered: `The independent Reviewer rejected the implementation ${rejections} time(s). Latest findings: ${lastReview.findings
      .map((f) => `[${f.severity}/${f.category}] ${f.summary}`)
      .join("; ") || "(none itemized)"}.`,
    attempted: [lastReview.summary],
    blocker: "The self-fix loop could not produce a change the independent Reviewer approves within the configured retry budget.",
    question: "Should the implementer keep trying with different guidance, or does this need a human decision on the approach?",
    options: [
      { label: "Give more specific guidance", description: "Answer with the missing requirement or preferred approach." },
      { label: "Accept current state with caveats", description: "Move forward despite open Reviewer findings, noted in the report." },
    ],
  };
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
