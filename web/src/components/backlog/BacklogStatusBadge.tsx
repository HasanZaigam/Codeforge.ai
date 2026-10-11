import type { BacklogItemStatus, ReviewSummary, TaskProposalStatus } from "../../api/index.js";
import { BACKLOG_STATUS_META, BEHAVIOR_LABELS, IMPLEMENTATION_LABELS, PROPOSAL_STATUS_META, REVIEW_STATE_LABELS } from "../../lib/backlogLabels.js";

export function BacklogStatusBadge({ status }: { status: BacklogItemStatus }) {
  const meta = BACKLOG_STATUS_META[status];
  return <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>;
}

export function ProposalStatusBadge({ status }: { status: TaskProposalStatus }) {
  const meta = PROPOSAL_STATUS_META[status];
  return <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>;
}

/**
 * The review state plus its two underlying facts. Implementation and behaviour are shown as SEPARATE chips on purpose:
 * "implementation appears present" must never read as "fixed". Renders nothing without a review summary (older backend).
 */
export function ReviewBadges({ review }: { review: ReviewSummary | undefined }) {
  if (!review) return null;
  const meta = review.state ? REVIEW_STATE_LABELS[review.state] : null;
  const showFacts = review.implementation !== "unknown" || review.behavior === "CHECK_VERIFIED";
  return (
    <span className="review-badges">
      {meta && <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>}
      {showFacts && (
        <>
          <span className="review-chip" data-fact="implementation">{IMPLEMENTATION_LABELS[review.implementation]}</span>
          <span className="review-chip" data-fact="behavior">{BEHAVIOR_LABELS[review.behavior]}</span>
        </>
      )}
    </span>
  );
}
