import { Link } from "react-router-dom";
import type { BacklogRelationshipDTO } from "../../api/index.js";
import { CONFIDENCE_LABELS } from "../../lib/backlogLabels.js";
import { EmptyState } from "../common/EmptyState.js";

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
    <ul className="backlog-list">
      {relationships.map((r) => {
        const otherName = r.other.ref ?? r.other.title;
        return (
          <li key={r.id} className="card card-padded backlog-relationship">
            <div className="backlog-row-top">
              <Link to={`/projects/${projectId}/backlog/${r.other.id}`}>
                {r.other.ref ? `${r.other.ref} — ` : ""}
                {r.other.title}
              </Link>
              <span className="status-badge tone-neutral">{r.status === "PROPOSED" ? "Proposed" : r.status}</span>
            </div>
            <p className="field-hint">
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
