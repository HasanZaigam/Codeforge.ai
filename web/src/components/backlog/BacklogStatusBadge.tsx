import type { BacklogItemStatus, ReviewSummary, TaskProposalStatus } from "../../api/index.js";
import { ToneBadge } from "../common/ToneBadge.js";
import { Badge } from "@/components/ui/badge";
import { BACKLOG_STATUS_META, BEHAVIOR_LABELS, IMPLEMENTATION_LABELS, PROPOSAL_STATUS_META, REVIEW_STATE_LABELS } from "../../lib/backlogLabels.js";

export function BacklogStatusBadge({ status }: { status: BacklogItemStatus }) {
  const meta = BACKLOG_STATUS_META[status];
  return <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>;
}

export function ProposalStatusBadge({ status }: { status: TaskProposalStatus }) {
  const meta = PROPOSAL_STATUS_META[status];
  return <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>;
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
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {meta && <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>}
      {showFacts && (
        <>
          <Badge variant="outline" data-fact="implementation">{IMPLEMENTATION_LABELS[review.implementation]}</Badge>
          <Badge variant="outline" data-fact="behavior">{BEHAVIOR_LABELS[review.behavior]}</Badge>
        </>
      )}
    </span>
  );
}
