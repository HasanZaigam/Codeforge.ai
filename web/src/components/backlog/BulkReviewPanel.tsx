import { useState } from "react";
import { Link } from "react-router-dom";
import { bulkBacklogApi, type BulkActionKey, type ReviewFilterKey, type ReviewRowDTO } from "../../api/index.js";
import { useBulkReview } from "../../hooks/useBulkReview.js";
import { BEHAVIOR_LABELS, FLOW_LABELS, IMPLEMENTATION_LABELS, REVIEW_FILTER_LABELS, REVIEW_STATE_LABELS } from "../../lib/backlogLabels.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";
import { EmptyState } from "../common/EmptyState.js";
import { DuplicateGroupsPanel } from "./DuplicateGroupsPanel.js";
import { Button } from "@/components/ui/button";

const FILTERS = Object.keys(REVIEW_FILTER_LABELS) as ReviewFilterKey[];
const ANALYSIS_LABELS: Record<ReviewRowDTO["analysis"]["state"], string> = { NONE: "Not analyzed", QUEUED: "Queued", RUNNING: "Analyzing…", SUCCEEDED: "Analyzed", FAILED: "Failed", CANCELLED: "Cancelled" };

/**
 * "Which backlog items need my attention?" One row per item; the three facts — implementation, flow, behavior — stay separate, and
 * "Verified" appears ONLY when a semantically sufficient approved check passed and reconciliation accepted it (row.verification.verified).
 * Every action here is per-item and none of them starts a task.
 */
export function BulkReviewPanel({ projectId, onOpenImport }: { projectId: string; onOpenImport: () => void }) {
  const [filter, setFilter] = useState<ReviewFilterKey>("all");
  const { data, error, loading, refetch } = useBulkReview(projectId, filter);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [bulkId, setBulkId] = useState<string>();

  const rows = data?.rows ?? [];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const ids = [...selected];

  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setMessage(undefined);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "That failed.");
    } finally {
      setBusy(false);
      refetch();
    }
  }

  const runAction = (action: BulkActionKey, label: string) =>
    act(async () => {
      const r = await bulkBacklogApi.action(projectId, action, ids);
      return `${label}: ${r.ok} succeeded, ${r.failed} failed${r.failed ? ` — ${r.results.filter((x) => !x.ok).slice(0, 3).map((x) => x.detail).join("; ")}` : ""}.`;
    });

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant="outline" type="button" onClick={onOpenImport}>Import bugs</Button>
        <Button type="button"
          disabled={busy || ids.length === 0}
          onClick={() => act(async () => {
            const { bulk, created } = await bulkBacklogApi.startAnalysis(projectId, { itemIds: ids });
            setBulkId(bulk.job.id);
            return `${created ? "Queued" : "Already queued"}: ${bulk.counts.queued + bulk.counts.running} to analyze, ${bulk.counts.skipped} skipped. Nothing else runs until you approve proposals and start tasks.`;
          })}
        >
          Analyze selected ({ids.length})
        </Button>
        {bulkId && (
          <Button variant="outline" type="button" disabled={busy} onClick={() => act(async () => { const b = await bulkBacklogApi.cancelBulk(bulkId); return `Cancel requested — ${b.counts.cancelled} cancelled so far; completed analyses are kept.`; })}>
            Cancel bulk analysis
          </Button>
        )}
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-full bg-muted p-1" role="tablist" aria-label="Review filter">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className="shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm" onClick={() => { setFilter(f); setSelected(new Set()); }}>
            {REVIEW_FILTER_LABELS[f]} {data ? `(${data.counts[f]})` : ""}
          </button>
        ))}
      </div>

      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      {loading && <LoadingState label="Loading review…" />}
      {error && !loading && <ErrorState message="Couldn't load the bulk review." onRetry={refetch} />}
      {!loading && !error && rows.length === 0 && <EmptyState message={filter === "all" ? "No backlog items yet. Import a bug sheet to get started." : "No items match this filter."} />}

      {rows.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border bg-muted/30 p-3" aria-label="Actions for selected items">
            <span className="w-full text-sm text-muted-foreground">{ids.length} selected — actions apply to each item independently and never start a task:</span>{" "}
            <Button variant="outline" type="button" disabled={busy || ids.length === 0} onClick={() => runAction("generate_proposals", "Proposals")}>Generate proposals</Button>{" "}
            <Button variant="outline" type="button" disabled={busy || ids.length === 0} onClick={() => runAction("approve_proposals", "Approve")}>Approve proposals</Button>{" "}
            <Button variant="outline" type="button" disabled={busy || ids.length === 0} onClick={() => runAction("reject_proposals", "Reject")}>Reject proposals</Button>{" "}
            <Button variant="outline" type="button" disabled={busy || ids.length === 0} onClick={() => runAction("convert_proposals", "Convert")}>Convert approved to tasks</Button>{" "}
            <Button variant="outline" type="button" disabled={busy || ids.length === 0} onClick={() => runAction("dismiss_duplicates", "Dismiss duplicates")}>Dismiss duplicate proposals</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Select all" checked={selected.size === rows.length} onChange={() => setSelected(selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.itemId)))} /></th>
                  <th>Bug</th><th>Module</th><th>Analysis</th><th>Review state</th><th>Implementation / Flow / Behavior</th><th>Evidence</th><th>Duplicates</th><th>Dependencies</th><th>Verification</th><th>Proposal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemId}>
                    <td><input type="checkbox" aria-label={`Select ${r.ref ?? r.title}`} checked={selected.has(r.itemId)} onChange={() => toggle(r.itemId)} /></td>
                    <td>
                      <Link className="font-medium hover:text-primary hover:underline" to={r.itemId}>{r.title}</Link>
                      <div className="text-sm text-muted-foreground">{r.ref}</div>
                    </td>
                    <td>{r.module ?? "—"}</td>
                    <td>
                      {ANALYSIS_LABELS[r.analysis.state]}
                      {r.analysis.state === "FAILED" && <div className="text-xs text-destructive">{r.analysis.failureCategory ?? "failed"}</div>}
                    </td>
                    <td>{r.review.state ? REVIEW_STATE_LABELS[r.review.state].label : "—"}</td>
                    <td>
                      {r.analysis.state === "SUCCEEDED" ? (
                        <>
                          <div data-fact="implementation">{IMPLEMENTATION_LABELS[r.review.implementation]}</div>
                          <div data-fact="flow" className="text-sm text-muted-foreground">{r.flow ? FLOW_LABELS[r.flow].split(" (")[0] : "Flow: not analysed"}</div>
                          <div data-fact="behavior" className="text-sm text-muted-foreground">{BEHAVIOR_LABELS[r.review.behavior]}</div>
                        </>
                      ) : "—"}
                    </td>
                    <td>{r.analysis.state === "SUCCEEDED" ? `${r.evidenceCount} item${r.evidenceCount === 1 ? "" : "s"}` : "—"}</td>
                    <td>{r.duplicates.proposed + r.duplicates.confirmed > 0 ? `${r.duplicates.proposed} proposed, ${r.duplicates.confirmed} confirmed` : "—"}</td>
                    <td>{r.dependencies.proposed + r.dependencies.confirmed > 0 ? `${r.dependencies.proposed} proposed, ${r.dependencies.confirmed} confirmed` : "—"}</td>
                    <td>
                      {r.verification.verified ? <strong>Verified by a platform check</strong> : r.analysis.state === "SUCCEEDED" ? (r.verification.checksAvailable > 0 ? `Unverified (${r.verification.sufficientChecks} sufficient / ${r.verification.checksAvailable} relevant checks)` : "Unverified") : "—"}
                    </td>
                    <td>{r.proposal ? `${r.proposal.status}${r.proposal.taskId ? " · task linked" : ""}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && (
            <p className="text-sm text-muted-foreground">
              Usage across {data.usage.analyses} analyses: {data.usage.withReportedUsage} reported ({data.usage.inputTokens} in / {data.usage.outputTokens} out tokens), {data.usage.unavailable} unavailable
              {data.usage.estimatedCost.length > 0 ? `; provider-reported estimate ${data.usage.estimatedCost.map((c) => `${c.amount.toFixed(4)} ${c.currency} (${c.analysesWithEstimate} analyses)`).join(", ")}` : "; no cost estimate was supplied"}.
            </p>
          )}
        </>
      )}
      <DuplicateGroupsPanel projectId={projectId} refreshKey={rows.length} />
    </div>
  );
}
