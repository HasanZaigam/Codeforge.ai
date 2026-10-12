import { useState, type FormEvent } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import type { ProjectRepoDTO } from "../api/index.js";
import { NativeSelect } from "@/components/ui/native-select";
import { useBacklogItem } from "../hooks/useBacklogItem.js";
import { backlogApi, ApiError, type BacklogItemDetailDTO, type TaskDTO } from "../api/index.js";
import { EDITABLE_STATUSES } from "../lib/backlogLabels.js";
import { BacklogStatusBadge, ReviewBadges } from "../components/backlog/BacklogStatusBadge.js";
import { AnalysisJobPanel } from "../components/backlog/AnalysisJobPanel.js";
import { AnalysisPanel } from "../components/backlog/AnalysisPanel.js";
import { RelationshipList } from "../components/backlog/RelationshipList.js";
import { ProposalPanel } from "../components/backlog/ProposalPanel.js";
import { BacklogActivity } from "../components/backlog/BacklogActivity.js";
import { DESCRIPTION_MAX, REF_MAX, TITLE_MAX } from "../components/backlog/CreateBacklogItemDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { Button, buttonVariants } from "@/components/ui/button";
import { Section } from "../components/common/Section.js";
import { Spinner } from "@/components/ui/spinner";
import { ChevronDownIcon, ChevronLeftIcon, CoinsIcon, FolderGit2Icon, PencilIcon, SparklesIcon } from "lucide-react";
import { tokenLabel } from "../lib/tokens.js";
import { cn } from "@/lib/utils";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
  // Rendered inside ProjectLayout, which provides the project (and so its repositories).
  const repositories = useOutletContext<ProjectOutletContext | undefined>()?.project.repositories ?? [];
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
  const handleRunVerification = () =>
    run(async () => {
      // Only enqueues worker jobs for the approved checks bound to this analysis; the result arrives by polling.
      const out = await backlogApi.requestVerification(item.id);
      adopt((d) => ({ ...d, verificationJobs: [...out.jobs, ...(d.verificationJobs ?? []).filter((j) => !out.jobs.some((n) => n.id === j.id))] }));
      refetch();
    });
  const handleCancelVerification = (jobId: string) =>
    run(async () => {
      const job = await backlogApi.cancelVerification(item.id, jobId);
      adopt((d) => ({ ...d, verificationJobs: (d.verificationJobs ?? []).map((j) => (j.id === job.id ? job : j)) }));
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
    <div className="space-y-6">
      <Link
        to={`/projects/${item.projectId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Overview
      </Link>

      {/* a. Header */}
      <div className="space-y-4 rounded-4xl bg-card p-6 ring-1 ring-foreground/10">
        <div className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              {item.externalRef && <span className="font-mono text-xs text-muted-foreground">{item.externalRef}</span>}
              <h1 className="text-2xl font-semibold">{item.title}</h1>
            </div>
            <BacklogStatusBadge status={status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {repositories.length > 1 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <FolderGit2Icon className="size-3" aria-hidden="true" />
                {repositories.find((r) => r.id === item.repositoryId)?.name ?? "unknown repository"}
              </span>
            )}
            <ReviewBadges review={detail.review} />
            <span className="text-xs text-muted-foreground">Backlog item — not an executable task</span>
          </div>
        </div>

        {editing && canEdit ? (
          <EditForm
            item={item}
            repositories={repositories}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              setEditing(false);
              adopt((d) => withItem(d, updated));
              refetch(); // editing an analyzed item resets it to NEW — show the server's state
            }}
          />
        ) : (
          <div className="space-y-3">
            <p className="max-w-3xl text-sm whitespace-pre-wrap text-muted-foreground">{item.description}</p>
            {canEdit ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" type="button" onClick={() => setEditing(true)}>
                  <PencilIcon data-icon="inline-start" />
                  Edit
                </Button>
                {status === "ANALYZED" && (
                  <p className="text-xs text-muted-foreground">Editing an analyzed item resets it to New so it can be analyzed again.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{READ_ONLY_REASONS[status]}</p>
            )}
          </div>
        )}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* What CodeForge understood / conclusion / next step — the plain-language summary of the technical Analysis section below */}
          {latestAnalysis?.status === "succeeded" && latestAnalysis.result && (
            <Section
              title="What CodeForge understood"
              actions={
                latestAnalysis.tokenCount ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CoinsIcon className="size-3.5" aria-hidden="true" />
                    Analysis used {tokenLabel(latestAnalysis.tokenCount.tokens, latestAnalysis.tokenCount.estimated)}
                  </span>
                ) : undefined
              }
            >
              <p className="text-sm whitespace-pre-wrap">{latestAnalysis.result.summary}</p>
            </Section>
          )}

          <Section title="AI conclusion">
            <div className="space-y-2 text-sm">
              {status === "NEEDS_CLARIFICATION" && (
                <>
                  <p>
                    <strong>Needs clarification.</strong> CodeForge needs more information before it can prepare this issue for
                    implementation.
                  </p>
                  <p className="text-muted-foreground">What happens next: edit the issue with the missing details, then re-analyze.</p>
                  <Button type="button" className="mt-1" onClick={() => setEditing(true)}>
                    Add clarification
                  </Button>
                </>
              )}
              {(status === "READY_FOR_TASK" || hasLiveProposal) && (
                <>
                  <p>
                    <strong>Ready to build.</strong> CodeForge found enough evidence to propose a task.
                  </p>
                  <p className="text-muted-foreground">What happens next: review the proposal below and approve it to create a task.</p>
                  <a className={cn(buttonVariants(), "mt-1")} href="#task-proposal">
                    Review proposal
                  </a>
                </>
              )}
              {status === "ANALYZED" && !hasLiveProposal && (
                <>
                  <p>
                    <strong>Analyzed.</strong> CodeForge has reviewed this issue but hasn't proposed a task yet.
                  </p>
                  <p className="text-muted-foreground">
                    What happens next: generate a task proposal below, or edit the issue if something needs correcting.
                  </p>
                </>
              )}
              {(status === "NEW" || status === "ANALYZING") && (
                <p className="text-muted-foreground">
                  {status === "ANALYZING" ? "CodeForge is analyzing this issue now." : "This issue hasn't been analyzed yet."}
                </p>
              )}
              {(status === "CONVERTED" || status === "REJECTED") && (
                <p className="text-muted-foreground">{READ_ONLY_REASONS[status]}</p>
              )}
            </div>
          </Section>

          {/* b. Actions */}
          <Section title="Actions">
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {analyzing && (
                  <Button type="button" disabled>
                    {/* A QUEUED job is not running anything yet — say so, instead of a spinner that implies work in progress. */}
                    {analysisJob?.status === "QUEUED" ? (
                      "Queued…"
                    ) : (
                      <>
                        <Spinner data-icon="inline-start" /> Analyzing…
                      </>
                    )}
                  </Button>
                )}
                {canAnalyze && (
                  <Button type="button" disabled={busy} onClick={handleAnalyze}>
                    <SparklesIcon data-icon="inline-start" />
                    {latestAnalysis ? "Re-analyze" : "Analyze"}
                  </Button>
                )}
                {canCancel && (
                  <Button variant="outline" type="button" disabled={busy} onClick={handleCancelAnalysis}>
                    Cancel analysis
                  </Button>
                )}
                {canGenerate && (
                  <Button variant="outline" type="button" disabled={busy} onClick={handleGenerate}>
                    Generate task proposal
                  </Button>
                )}
                {canReject && !confirmingReject && (
                  <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingReject(true)}>
                    Reject item
                  </Button>
                )}
              </div>
              {confirmingReject && (
                <div
                  className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center"
                  role="alertdialog"
                  aria-label="Confirm rejection"
                >
                  <span className="flex-1">Reject this backlog item? It becomes read-only and can't be analyzed or converted.</span>
                  <div className="flex gap-2">
                    <Button variant="outline" type="button" disabled={busy} onClick={() => setConfirmingReject(false)}>
                      Keep item
                    </Button>
                    <Button variant="destructive" type="button" disabled={busy} onClick={handleReject}>
                      Confirm rejection
                    </Button>
                  </div>
                </div>
              )}
              <div aria-live="polite" className="text-muted-foreground empty:hidden">
                <AnalysisJobPanel job={analysisJob} />
                {analyzing && !analysisJob && <p>Analysis is queued or running in the background — this page updates automatically.</p>}
              </div>
              <div aria-live="assertive" className="empty:hidden">
                {actionError && <ErrorState message={actionError} />}
              </div>
              {convertedTask && (
                <p role="status" className="text-tone-success">
                  Task created:{" "}
                  <Link className="font-medium underline underline-offset-4" to={`/tasks/${convertedTask.id}`}>
                    {convertedTask.title}
                  </Link>
                  . It is in Backlog on the Tasks tab — start it there when you're ready.
                </p>
              )}
            </div>
          </Section>

          {/* e. Proposal */}
          <div className="scroll-mt-6 space-y-3" id="task-proposal">
            <h2 className="text-lg font-semibold">Task proposal</h2>
            <ProposalPanel
              proposal={proposal}
              projectId={item.projectId}
              busy={busy}
              onApprove={handleApprove}
              onReject={handleRejectProposal}
              onConvert={handleConvert}
            />
          </div>

          {/* c. Analysis — the full technical breakdown (claims, evidence, verification) stays available, just not front-and-center */}
          <details className="group rounded-3xl bg-card ring-1 ring-foreground/10">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 text-sm font-medium [&::-webkit-details-marker]:hidden">
              View technical details
              <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="px-5 pb-5">
              <AnalysisPanel
                analysis={latestAnalysis}
                itemStatus={status}
                jobStatus={analysisJob?.status ?? null}
                verifications={detail.claimVerifications ?? []}
                controls={{ jobs: detail.verificationJobs ?? [], busy, onRun: handleRunVerification, onCancel: handleCancelVerification }}
              />
            </div>
          </details>
        </div>

        <aside className="space-y-4">
          {/* d. Relationships */}
          <Section title="Possible duplicates" description="Proposals only — CodeForge never merges items or changes execution order automatically.">
            <RelationshipList relationships={duplicates} projectId={item.projectId} emptyMessage="No possible duplicates were flagged." />
          </Section>
          <Section title="Dependency candidates" description="Proposals only — CodeForge never merges items or changes execution order automatically.">
            <RelationshipList relationships={dependencies} projectId={item.projectId} emptyMessage="No dependency candidates were flagged." />
          </Section>

          {/* f. Activity */}
          <Section title="Activity">
            <BacklogActivity events={events} />
          </Section>
        </aside>
      </div>
    </div>
  );
}

function EditForm({
  item,
  repositories,
  onCancel,
  onSaved,
}: {
  item: BacklogItemDetailDTO["item"];
  repositories: ProjectRepoDTO[];
  onCancel: () => void;
  onSaved: (item: BacklogItemDetailDTO["item"]) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [externalRef, setExternalRef] = useState(item.externalRef ?? "");
  const [repositoryId, setRepositoryId] = useState(item.repositoryId ?? "");
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
          ...(repositoryId && repositoryId !== item.repositoryId ? { repositoryId } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your changes. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-1" onSubmit={handleSubmit}>
      {repositories.length > 1 && (
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="edit-backlog-repository">Repository</Label>
          <NativeSelect className="w-full" id="edit-backlog-repository" value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
          <p className="text-sm text-muted-foreground">Analysis looks at this repository, and a task created from this item works in it.</p>
        </div>
      )}
      <div className="mb-4 flex flex-col gap-2">
        <Label htmlFor="edit-backlog-title">Title</Label>
        <Input id="edit-backlog-title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="mb-4 flex flex-col gap-2">
        <Label htmlFor="edit-backlog-description">Description</Label>
        <Textarea id="edit-backlog-description" rows={6} value={description} maxLength={DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="mb-4 flex flex-col gap-2">
        <Label htmlFor="edit-backlog-ref">Reference</Label>
        <Input id="edit-backlog-ref" value={externalRef} maxLength={REF_MAX} onChange={(e) => setExternalRef(e.target.value)} />
      </div>
      {error && <ErrorState message={error} />}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button variant="outline" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !title.trim() || !description.trim()}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
