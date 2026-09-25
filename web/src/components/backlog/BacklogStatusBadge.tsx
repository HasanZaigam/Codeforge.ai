import type { BacklogItemStatus, TaskProposalStatus } from "../../api/index.js";
import { BACKLOG_STATUS_META, PROPOSAL_STATUS_META } from "../../lib/backlogLabels.js";

export function BacklogStatusBadge({ status }: { status: BacklogItemStatus }) {
  const meta = BACKLOG_STATUS_META[status];
  return <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>;
}

export function ProposalStatusBadge({ status }: { status: TaskProposalStatus }) {
  const meta = PROPOSAL_STATUS_META[status];
  return <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>;
}
