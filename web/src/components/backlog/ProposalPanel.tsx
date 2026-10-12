import { Link } from "react-router-dom";
import type { TaskProposalDependency, TaskProposalDTO } from "../../api/index.js";
import { CONFIDENCE_LABELS, ISSUE_TYPE_LABELS } from "../../lib/backlogLabels.js";
import { ToneBadge } from "../common/ToneBadge.js";
import { ProposalStatusBadge } from "./BacklogStatusBadge.js";
import { CandidateFileList } from "./CandidateFileList.js";
import { ClaimStatusBadge, EstablishesLine } from "./EvidencePanel.js";
import { EmptyState } from "../common/EmptyState.js";
import { Button } from "@/components/ui/button";

function StringList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

function ItemRefList({ items, projectId }: { items: TaskProposalDependency[]; projectId: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((d) => (
        <li key={d.backlogItemId}>
          <Link to={`/projects/${projectId}/backlog/${d.backlogItemId}`}>
            {d.ref ? `${d.ref} — ` : ""}
            {d.title}
          </Link>{" "}
          <span className="text-sm text-muted-foreground">({CONFIDENCE_LABELS[d.confidence]}) {d.rationale}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The task PROPOSAL and its human decision controls. Approve and Convert are deliberately separate
 * buttons (never combined), and converting only creates an ordinary Backlog task — it is never started here.
 */
export function ProposalPanel({
  proposal,
  projectId,
  busy,
  onApprove,
  onReject,
  onConvert,
}: {
  proposal: TaskProposalDTO | null;
  projectId: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onConvert: () => void;
}) {
  if (!proposal) {
    return (
      <EmptyState message="No task proposal yet. Once the item is analyzed, use “Generate task proposal” to draft one for your review." />
    );
  }

  const c = proposal.content;
  const status = proposal.status;

  return (
    <div className="space-y-2 rounded-3xl bg-card p-5 text-sm ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{c ? c.title : "Task proposal"}</strong>
        <ProposalStatusBadge status={status} />
      </div>
      <p className="text-sm text-muted-foreground">
        A proposal is a draft. Nothing becomes a task until you approve it and then convert it, and the task still has to be started
        separately.
      </p>

      {c ? (
        <>
          {c.implementationConflict && c.implementationConflict !== "none" && (
            <div className="error-banner rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="status">
              <p>
                <strong>Implementation evidence conflicts with the reported absence ({c.implementationConflict}) — this may already be implemented.</strong> Behavior is not verified, so this
                is not a claim that it works or is fixed. The task goal is written as an investigation.
              </p>
            </div>
          )}
          {c.investigateFirst && (!c.implementationConflict || c.implementationConflict === "none") && (
            <div className="error-banner rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
              <p>
                <strong>Investigate first — CodeForge's evidence contradicts an AI claim this proposal would otherwise rest on</strong>
              </p>
            </div>
          )}
          <p>
            <span className="text-sm text-muted-foreground">AI-stated summary: </span>
            {c.summary}
          </p>
          <p className="text-sm text-muted-foreground">
            {ISSUE_TYPE_LABELS[c.issueType]}
            {c.affectedApplication ? ` · ${c.affectedApplication}` : ""}
            {c.suspectedArea ? ` · ${c.suspectedArea}` : ""}
          </p>
          <details>
            <summary>Task description that would be created</summary>
            <pre className="overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{c.goal}</pre>
          </details>
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Acceptance criteria</h3>
          <StringList items={c.acceptanceCriteria} />
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Validation</h3>
          <StringList items={c.validation} />
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Dependencies (informational — not enforced)</h3>
          <ItemRefList items={c.dependencies} projectId={projectId} />
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Duplicate warnings</h3>
          <ItemRefList items={c.duplicateWarnings} projectId={projectId} />
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Uncertainty ({CONFIDENCE_LABELS[c.uncertainty.overall].toLowerCase()})</h3>
          <StringList items={c.uncertainty.uncertainties} />
          {c.uncertainty.missingInformation.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {c.uncertainty.missingInformation.map((m, i) => (
                <li key={i}>
                  {m.blocking && <ToneBadge tone="danger">BLOCKING</ToneBadge>} {m.question}
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Candidate files</h3>
          <CandidateFileList files={c.candidateFiles} />
          {(c.claimAssessments ?? []).length > 0 && (
            <>
              <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Claim assessments (platform evidence vs AI claims)</h3>
              <ul className="space-y-2">
                {(c.claimAssessments ?? []).map((a, i) => (
                  <li key={i} className="grid gap-3 rounded-2xl border p-3 text-sm md:grid-cols-3">
                    <div className="min-w-0 space-y-1">
                      <ClaimStatusBadge status={a.status} /> {a.statement}
                      <EstablishesLine establishes={a.establishes} />
                    </div>
                    <div className="min-w-0 space-y-1">
                      {a.reason}
                      {a.evidence.map((e, j) => (
                        <div key={j} className="text-sm text-muted-foreground">
                          {e}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <div className="error-banner rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
          <p>This proposal's stored content is invalid. It can only be rejected.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2">
        {status === "PENDING" && c && (
          <Button type="button" disabled={busy} onClick={onApprove}>
            Approve proposal
          </Button>
        )}
        {status === "APPROVED" && c && (
          <Button type="button" disabled={busy} onClick={onConvert}>
            Convert to task
          </Button>
        )}
        {status === "CONVERTING" && (
          <Button type="button" disabled>
            Converting…
          </Button>
        )}
        {(status === "PENDING" || status === "APPROVED") && (
          <Button variant="outline" type="button" disabled={busy} onClick={onReject}>
            Reject proposal
          </Button>
        )}
      </div>

      {status === "CONVERTED" && (
        <p role="status">
          {proposal.taskId && <Link to={`/tasks/${proposal.taskId}`}>Open task</Link>} The task is in Backlog on the Tasks tab — start it there when
          you're ready.
        </p>
      )}
      {status === "REJECTED" && <p className="text-sm text-muted-foreground">This proposal was rejected. You can generate a new one if the item is still analyzed.</p>}
    </div>
  );
}
