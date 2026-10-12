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
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Issues &amp; Requests</h2>
          <p className="mt-1 text-sm text-muted-foreground">Give CodeForge issues, bugs, or requests to understand and prepare for implementation.</p>
        </div>
        <div>
          <Button variant="outline" type="submit" onClick={() => setImporting(true)}>
            Import
          </Button>{" "}
          <Button type="submit" onClick={() => setCreating(true)}>
            + Add issue
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 overflow-x-auto rounded-full bg-muted p-1" role="tablist" aria-label="Filter issues">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className="shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({counts[f.key]})
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Input
            type="search"
            placeholder="Search issues…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search issues"
          />
          <Button variant="outline" type="submit" onClick={() => setReviewingMultiple((v) => !v)}>
            {reviewingMultiple ? "Hide bulk review" : "Review multiple"}
          </Button>
        </div>
      </div>

      {reviewingMultiple && (
        <div className="mb-6">
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
        <div className="overflow-x-auto">
          <table className="data-table">
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
                <tr key={item.id}>
                  <td data-label="Issue">
                    {item.externalRef && <span className="font-mono text-xs text-muted-foreground">{item.externalRef}</span>}
                    <div>{item.title}</div>
                  </td>
                  <td data-label="Source">{item.source === "import" ? "Imported" : "Manual"}</td>
                  <td data-label="Status">{BACKLOG_STATUS_META[item.status].label}</td>
                  <td data-label="AI understanding">{understanding(item)}</td>
                  <td data-label="Updated">{formatRelative(item.updatedAt)}</td>
                  <td data-label="Action">
                    <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={item.id}>
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
