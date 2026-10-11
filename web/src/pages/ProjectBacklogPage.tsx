import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectBacklog } from "../hooks/useProjectBacklog.js";
import { BACKLOG_STATUS_META } from "../lib/backlogLabels.js";
import { formatRelative } from "../lib/time.js";
import type { BacklogItemSummaryDTO } from "../api/index.js";
import { BulkReviewPanel } from "../components/backlog/BulkReviewPanel.js";
import { ImportBugsDialog } from "../components/backlog/ImportBugsDialog.js";
import { CreateBacklogItemDialog } from "../components/backlog/CreateBacklogItemDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { EmptyState } from "../components/common/EmptyState.js";

type QuickFilter = "ALL" | "NEEDS_CLARIFICATION" | "READY_FOR_TASK" | "ANALYZED";

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "NEEDS_CLARIFICATION", label: "Needs clarification" },
  { key: "READY_FOR_TASK", label: "Ready to build" },
  { key: "ANALYZED", label: "Analyzed" },
];

/** What CodeForge understood, in one short phrase — the "AI understanding" column never shows a raw enum. */
function understanding(item: BacklogItemSummaryDTO): string {
  if (item.status === "ANALYZING") return "Analyzing…";
  if (item.status === "NEW") return "Not analyzed yet";
  if (item.review?.state === "READY_FOR_PROPOSAL" || item.status === "READY_FOR_TASK") return "Ready to build";
  if (item.review?.state === "NEEDS_CLARIFICATION" || item.status === "NEEDS_CLARIFICATION") return "Needs clarification";
  if (item.review?.state === "POSSIBLY_ALREADY_IMPLEMENTED") return "Possibly already implemented";
  if (item.status === "CONVERTED") return "Converted to a task";
  if (item.status === "REJECTED") return "Rejected";
  if (item.latestAnalysis?.status === "failed") return "Analysis failed";
  return BACKLOG_STATUS_META[item.status].label;
}

function actionLabel(item: BacklogItemSummaryDTO): string {
  if (item.status === "READY_FOR_TASK" || item.proposal) return "Review proposal";
  if (item.status === "NEEDS_CLARIFICATION") return "Add clarification";
  return "View";
}

/**
 * "Issues & Requests" — the normal engineering workflow for backlog items. Internal evaluation/QA tooling
 * (ground-truth sampling, baselines) lives at a separate /evaluation route, never here — see
 * ProjectEvaluationPage.tsx and docs/UI_ARCHITECTURE.md.
 */
export function ProjectBacklogPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { items, error, loading, refetch } = useProjectBacklog(project.id);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reviewingMultiple, setReviewingMultiple] = useState(false);
  const [filter, setFilter] = useState<QuickFilter>("ALL");
  const [search, setSearch] = useState("");

  const all = items ?? [];
  const counts: Record<QuickFilter, number> = {
    ALL: all.length,
    NEEDS_CLARIFICATION: all.filter((i) => i.status === "NEEDS_CLARIFICATION").length,
    READY_FOR_TASK: all.filter((i) => i.status === "READY_FOR_TASK").length,
    ANALYZED: all.filter((i) => i.status === "ANALYZED").length,
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all
      .filter((i) => filter === "ALL" || i.status === filter)
      .filter((i) => !q || i.title.toLowerCase().includes(q) || (i.externalRef ?? "").toLowerCase().includes(q));
  }, [all, filter, search]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Issues &amp; Requests</h2>
          <p className="page-subtitle">Give CodeForge issues, bugs, or requests to understand and prepare for implementation.</p>
        </div>
        <div>
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>
            Import
          </button>{" "}
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + Add issue
          </button>
        </div>
      </div>

      <div className="backlog-filter" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div role="tablist" aria-label="Filter issues">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`btn ${filter === f.key ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({counts[f.key]})
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="search"
            placeholder="Search issues…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search issues"
          />
          <button className="btn btn-secondary" onClick={() => setReviewingMultiple((v) => !v)}>
            {reviewingMultiple ? "Hide bulk review" : "Review multiple"}
          </button>
        </div>
      </div>

      {reviewingMultiple && (
        <div className="section">
          <BulkReviewPanel projectId={project.id} onOpenImport={() => setImporting(true)} />
        </div>
      )}

      {importing && (
        <ImportBugsDialog
          projectId={project.id}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            refetch();
          }}
        />
      )}

      {loading && <LoadingState label="Loading issues…" />}
      {error && !loading && <ErrorState message="Couldn't load Issues & Requests for this project." onRetry={refetch} />}
      {!loading && !error && all.length === 0 && (
        <EmptyState message="No issues or requests yet. Add one, or import a CSV, to have CodeForge analyze it." />
      )}
      {!loading && !error && all.length > 0 && visible.length === 0 && <EmptyState message="No issues match this filter." />}
      {!loading && !error && visible.length > 0 && (
        <div className="table-scroll">
          <table className="bulk-table issues-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Source</th>
                <th>Status</th>
                <th>AI understanding</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id} className="issues-table-row">
                  <td data-label="Issue">
                    {item.externalRef && <span className="backlog-ref">{item.externalRef}</span>}
                    <div>{item.title}</div>
                  </td>
                  <td data-label="Source">{item.source === "import" ? "Imported" : "Manual"}</td>
                  <td data-label="Status">{BACKLOG_STATUS_META[item.status].label}</td>
                  <td data-label="AI understanding">{understanding(item)}</td>
                  <td data-label="Updated">{formatRelative(item.updatedAt)}</td>
                  <td data-label="Action">
                    <Link className="btn btn-secondary" to={item.id}>
                      {actionLabel(item)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
