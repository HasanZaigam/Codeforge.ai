import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectBacklog } from "../hooks/useProjectBacklog.js";
import { BacklogStatusBadge, ProposalStatusBadge } from "../components/backlog/BacklogStatusBadge.js";
import { CreateBacklogItemDialog } from "../components/backlog/CreateBacklogItemDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { EmptyState } from "../components/common/EmptyState.js";

/**
 * Phase 4A backlog list. A backlog item is NOT a task — see /docs/UI_ARCHITECTURE.md. This page only
 * lists and creates items; understanding, proposals and conversion all live on the item's own page.
 */
export function ProjectBacklogPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { items, error, loading, refetch } = useProjectBacklog(project.id);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Backlog</h2>
          <p className="page-subtitle">
            Backlog items are things CodeForge should understand. They are not tasks — nothing runs until you approve a proposal and
            start the resulting task.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + New backlog item
        </button>
      </div>

      {loading && <LoadingState label="Loading backlog…" />}
      {error && !loading && <ErrorState message="Couldn't load the backlog for this project." onRetry={refetch} />}
      {!loading && !error && (items ?? []).length === 0 && (
        <EmptyState message="No backlog items yet. Add one to have CodeForge analyze it." />
      )}
      {!loading && !error && (items ?? []).length > 0 && (
        <ul className="backlog-list">
          {items!.map((item) => (
            <li key={item.id} className="card backlog-row">
              <Link to={item.id} className="backlog-row-link">
                <div className="backlog-row-top">
                  {item.externalRef && <span className="backlog-ref">{item.externalRef}</span>}
                  <span className="backlog-row-title">{item.title}</span>
                  <BacklogStatusBadge status={item.status} />
                </div>
                <div className="backlog-row-meta">
                  {item.latestAnalysis?.status === "failed" && <span className="backlog-indicator danger">Analysis failed</span>}
                  {item.proposal && (
                    <span className="backlog-indicator">
                      Proposal: <ProposalStatusBadge status={item.proposal.status} />
                    </span>
                  )}
                  {item.proposal?.taskId && <span className="backlog-indicator">Linked task</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateBacklogItemDialog
          projectId={project.id}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}
