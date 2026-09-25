import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useBacklogItem } from "../hooks/useBacklogItem.js";
import { backlogApi, ApiError, type BacklogItemDetailDTO, type TaskDTO } from "../api/index.js";
import { EDITABLE_STATUSES } from "../lib/backlogLabels.js";
import { BacklogStatusBadge } from "../components/backlog/BacklogStatusBadge.js";
import { AnalysisJobPanel } from "../components/backlog/AnalysisJobPanel.js";
import { AnalysisPanel } from "../components/backlog/AnalysisPanel.js";
import { RelationshipList } from "../components/backlog/RelationshipList.js";
import { ProposalPanel } from "../components/backlog/ProposalPanel.js";
import { BacklogActivity } from "../components/backlog/BacklogActivity.js";
import { DESCRIPTION_MAX, REF_MAX, TITLE_MAX } from "../components/backlog/CreateBacklogItemDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";

const READ_ONLY_REASONS: Record<string, string> = {
  ANALYZING: "This item is being analyzed and can't be edited until the analysis finishes.",
  READY_FOR_TASK: "This item has an approved proposal and is locked while it is converted.",
  CONVERTED: "This item has been converted to a task and is read-only.",
  REJECTED: "This item was rejected and is read-only.",
};

/**
 * The backlog item detail screen. Every button here is driven strictly by the status the server
 * returned — the client never decides a transition, it only requests one and then adopts/refetches
 * the server's answer. A backlog item is NOT an executable task; converting a proposal creates an
 * ordinary Backlog task that must still be started from the Tasks tab.
 */
export function BacklogItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { detail, error, loading, refetch, adopt } = useBacklogItem(itemId!);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [editing, setEditing] = useState(false);
  const [convertedTask, setConvertedTask] = useState<TaskDTO>();

  if (loading && !detail) return <LoadingState label="Loading backlog item…" />;
  if (error && !detail) return <ErrorState message="Couldn't load this backlog item." onRetry={refetch} />;
  if (!detail) return <LoadingState label="Loading backlog item…" />;

  const { item, latestAnalysis, analysisJob, relationships, proposal, events } = detail;
  const status = item.status;
  const analyzing = status === "ANALYZING";
  const canCancel = (analysisJob?.status === "QUEUED" || analysisJob?.status === "RUNNING") && !analysisJob.cancelRequested;
  const canEdit = EDITABLE_STATUSES.includes(status);
  const canAnalyze = status === "NEW" || status === "NEEDS_CLARIFICATION" || status === "ANALYZED";
  const hasLiveProposal = proposal !== null && proposal.status !== "REJECTED";
  const canGenerate = status === "ANALYZED" && !hasLiveProposal;
  const canReject = status === "NEW" || status === "NEEDS_CLARIFICATION" || status === "ANALYZED" || status === "READY_FOR_TASK";
  const duplicates = relationships.filter((r) => r.kind === "POSSIBLE_DUPLICATE");
  const dependencies = relationships.filter((r) => r.kind === "DEPENDS_ON");

  /** Runs one action; a failure (including a 409) shows the server's message and refetches so the page matches the server. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof ApiError && err.code === "CONVERSION_IN_PROGRESS"
        ? `${err.message} Please retry in a moment.`
        : err instanceof Error
          ? err.message
          : "That action failed. Please try again.");
      refetch();
    } finally {
      setBusy(false);
    }
  }

  const withItem = (d: BacklogItemDetailDTO, i: BacklogItemDetailDTO["item"]): BacklogItemDetailDTO => ({ ...d, item: i });

  const handleAnalyze = () =>
    run(async () => {
      // Only enqueues (idempotent — enqueued:false means one is already live); show the job's queued state at once.
      const { item: updated, job } = await backlogApi.analyze(item.id);
      adopt((d) => ({ ...withItem(d, updated), analysisJob: job }));
      refetch(); // starts polling while ANALYZING
    });
  const handleCancelAnalysis = () =>
    run(async () => {
      const { item: updated, job } = await backlogApi.cancelAnalysis(item.id);
      adopt((d) => ({ ...withItem(d, updated), analysisJob: job }));
      refetch();
    });
  const handleReject = () =>
    run(async () => {
      const updated = await backlogApi.reject(item.id);
      setConfirmingReject(false);
      adopt((d) => withItem(d, updated));
      refetch();
    });
  const handleGenerate = () =>
    run(async () => {
      const { proposal: p } = await backlogApi.generateProposal(item.id);
      adopt((d) => ({ ...d, proposal: p }));
      refetch();
    });
  const handleApprove = () =>
    run(async () => {
      const p = await backlogApi.approveProposal(proposal!.id);
      adopt((d) => ({ ...d, proposal: p }));
      refetch();
    });
  const handleRejectProposal = () =>
    run(async () => {
      const p = await backlogApi.rejectProposal(proposal!.id);
      adopt((d) => ({ ...d, proposal: p }));
      refetch();
    });
  const handleConvert = () =>
    run(async () => {
      const result = await backlogApi.convertProposal(proposal!.id);
      setConvertedTask(result.task);
      adopt((d) => ({ ...d, proposal: result.proposal }));
      refetch();
    });

  return (
    <div>
      <Link to={`/projects/${item.projectId}/backlog`} className="breadcrumb">
        ← Back to backlog
      </Link>

      {/* a. Header */}
      <div className="task-detail-header">
        <div className="title-row">
          {item.externalRef && <span className="backlog-ref">{item.externalRef}</span>}
          <h1>{item.title}</h1>
          <BacklogStatusBadge status={status} />
        </div>
        <span className="backlog-not-task">Backlog item — not an executable task</span>
      </div>

      {editing && canEdit ? (
        <EditForm
          item={item}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            adopt((d) => withItem(d, updated));
            refetch(); // editing an analyzed item resets it to NEW — show the server's state
          }}
        />
      ) : (
        <div className="section">
          <p className="backlog-description">{item.description}</p>
          {canEdit ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                Edit
              </button>
              {status === "ANALYZED" && <p className="field-hint">Editing an analyzed item resets it to New so it can be analyzed again.</p>}
            </>
          ) : (
            <p className="field-hint">{READ_ONLY_REASONS[status]}</p>
          )}
        </div>
      )}

      {/* b. Actions */}
      <div className="section">
        <h2>Actions</h2>
        <div className="backlog-actions">
          {analyzing && (
            <button type="button" className="btn btn-primary" disabled>
              {/* A QUEUED job is not running anything yet — say so, instead of a spinner that implies work in progress. */}
              {analysisJob?.status === "QUEUED" ? (
                "Queued…"
              ) : (
                <>
                  <span className="spinner" aria-hidden="true" /> Analyzing…
                </>
              )}
            </button>
          )}
          {canAnalyze && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={handleAnalyze}>
              {latestAnalysis ? "Re-analyze" : "Analyze"}
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleCancelAnalysis}>
              Cancel analysis
            </button>
          )}
          {canGenerate && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleGenerate}>
              Generate task proposal
            </button>
          )}
          {canReject && !confirmingReject && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmingReject(true)}>
              Reject item
            </button>
          )}
        </div>
        {confirmingReject && (
          <div className="field-warning" role="alertdialog" aria-label="Confirm rejection">
            <span>Reject this backlog item? It becomes read-only and can't be analyzed or converted.</span>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={handleReject}>
              Confirm rejection
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmingReject(false)}>
              Keep item
            </button>
          </div>
        )}
        <div aria-live="polite">
          <AnalysisJobPanel job={analysisJob} />
          {analyzing && !analysisJob && <p className="field-hint">Analysis is queued or running in the background — this page updates automatically.</p>}
        </div>
        <div aria-live="assertive">{actionError && <ErrorState message={actionError} />}</div>
        {convertedTask && (
          <p role="status" className="backlog-success">
            Task created: <Link to={`/tasks/${convertedTask.id}`}>{convertedTask.title}</Link>. It is in Backlog on the Tasks tab — start it there
            when you're ready.
          </p>
        )}
      </div>

      {/* c. Analysis */}
      <div className="section">
        <h2>Analysis</h2>
        <AnalysisPanel analysis={latestAnalysis} itemStatus={status} jobStatus={analysisJob?.status ?? null} />
      </div>

      {/* d. Relationships */}
      <div className="section">
        <h2>Possible duplicates</h2>
        <p className="field-hint">Proposals only — CodeForge never merges items or changes execution order automatically.</p>
        <RelationshipList relationships={duplicates} projectId={item.projectId} emptyMessage="No possible duplicates were flagged." />
      </div>
      <div className="section">
        <h2>Dependency candidates</h2>
        <p className="field-hint">Proposals only — CodeForge never merges items or changes execution order automatically.</p>
        <RelationshipList relationships={dependencies} projectId={item.projectId} emptyMessage="No dependency candidates were flagged." />
      </div>

      {/* e. Proposal */}
      <div className="section">
        <h2>Task proposal</h2>
        <ProposalPanel
          proposal={proposal}
          projectId={item.projectId}
          busy={busy}
          onApprove={handleApprove}
          onReject={handleRejectProposal}
          onConvert={handleConvert}
        />
      </div>

      {/* f. Activity */}
      <div className="section">
        <h2>Activity</h2>
        <BacklogActivity events={events} />
      </div>
    </div>
  );
}

function EditForm({
  item,
  onCancel,
  onSaved,
}: {
  item: BacklogItemDetailDTO["item"];
  onCancel: () => void;
  onSaved: (item: BacklogItemDetailDTO["item"]) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [externalRef, setExternalRef] = useState(item.externalRef ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      onSaved(
        await backlogApi.update(item.id, {
          title: title.trim(),
          description: description.trim(),
          externalRef: externalRef.trim() || null,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your changes. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form className="section" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="edit-backlog-title">Title</label>
        <input id="edit-backlog-title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-backlog-description">Description</label>
        <textarea id="edit-backlog-description" rows={6} value={description} maxLength={DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-backlog-ref">Reference</label>
        <input id="edit-backlog-ref" value={externalRef} maxLength={REF_MAX} onChange={(e) => setExternalRef(e.target.value)} />
      </div>
      {error && <ErrorState message={error} />}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting || !title.trim() || !description.trim()}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
