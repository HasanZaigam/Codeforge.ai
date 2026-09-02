import type { HumanReviewFeedback, HumanReviewFeedbackItem } from "../domain/types.js";

/**
 * Pure decision logic for one poll of a task's PR feedback — mirrors
 * review/reviewer.ts's role (deriving a verdict from raw evidence) but for
 * human, not AI, review. See /docs/TASK_LIFECYCLE.md "Human review feedback
 * loop".
 */
export interface HumanReviewOutcome {
  /** Items not yet in TaskRecord.processedHumanFeedbackIds — always mark these processed, whatever else happens. */
  newItems: HumanReviewFeedbackItem[];
  /** The most recent unprocessed "changes requested" review, if any — the one and only actionable trigger. */
  changesRequested: HumanReviewFeedbackItem | null;
  /** Unprocessed approvals — informational only (see requirement: never auto-merge, stay in REVIEW). */
  approvals: HumanReviewFeedbackItem[];
}

export function deriveHumanReviewOutcome(items: HumanReviewFeedbackItem[], alreadyProcessed: ReadonlySet<string>): HumanReviewOutcome {
  const newItems = items.filter((i) => !alreadyProcessed.has(i.id));
  const changesRequestedCandidates = newItems.filter((i) => i.kind === "review" && i.verdict === "changes_requested");
  const changesRequested = changesRequestedCandidates.length
    ? changesRequestedCandidates.reduce((latest, i) => (i.updatedAt > latest.updatedAt ? i : latest))
    : null;
  const approvals = newItems.filter((i) => i.kind === "review" && i.verdict === "approved");
  return { newItems, changesRequested, approvals };
}

/**
 * Builds the Implementer-facing feedback from the actionable review, folding
 * in any other new comment bodies as supplementary context (a human often
 * explains a "changes requested" review in a follow-up comment) — see the
 * "Human reviewer feedback" template in prompt-builder.ts.
 */
export function buildHumanReviewFeedback(changesRequested: HumanReviewFeedbackItem, allNewItems: HumanReviewFeedbackItem[]): HumanReviewFeedback {
  const supplementary = allNewItems
    .filter((i) => i.id !== changesRequested.id && i.body.trim().length > 0)
    .map((i) => i.body.trim());
  const comments = [changesRequested.body.trim(), ...supplementary].filter(Boolean).join("\n\n");
  return { reviewerLogin: changesRequested.authorLogin, comments: comments || "(no written comments)" };
}
