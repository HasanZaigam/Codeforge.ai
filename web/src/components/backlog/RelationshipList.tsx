import { Link } from "react-router-dom";
import type { BacklogRelationshipDTO } from "../../api/index.js";
import { CONFIDENCE_LABELS } from "../../lib/backlogLabels.js";
import { EmptyState } from "../common/EmptyState.js";
import { ToneBadge } from "../common/ToneBadge.js";

/** Duplicate / dependency PROPOSALS from the analysis. Purely informational — nothing here merges items or affects execution. */
export function RelationshipList({
  relationships,
  emptyMessage,
  projectId,
}: {
  relationships: BacklogRelationshipDTO[];
  emptyMessage: string;
  projectId: string;
}) {
  if (relationships.length === 0) return <EmptyState message={emptyMessage} />;
  return (
    <ul className="space-y-2">
      {relationships.map((r) => {
        const otherName = r.other.ref ?? r.other.title;
        return (
          <li key={r.id} className="space-y-1.5 rounded-2xl border p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link className="font-medium hover:text-primary hover:underline" to={`/projects/${projectId}/backlog/${r.other.id}`}>
                {r.other.ref ? `${r.other.ref} — ` : ""}
                {r.other.title}
              </Link>
              <ToneBadge tone="neutral">{r.status === "PROPOSED" ? "Proposed" : r.status}</ToneBadge>
            </div>
            <p className="text-xs text-muted-foreground">
              {r.direction === "outgoing" ? "Flagged by this item's analysis" : `Flagged by ${otherName}'s analysis`} ·{" "}
              {CONFIDENCE_LABELS[r.confidence]}
            </p>
            <p>{r.rationale}</p>
          </li>
        );
      })}
    </ul>
  );
}
