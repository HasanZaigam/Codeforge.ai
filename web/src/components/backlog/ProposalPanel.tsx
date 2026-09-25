import { Link } from "react-router-dom";
import type { TaskProposalDependency, TaskProposalDTO } from "../../api/index.js";
import { CONFIDENCE_LABELS, ISSUE_TYPE_LABELS } from "../../lib/backlogLabels.js";
import { ProposalStatusBadge } from "./BacklogStatusBadge.js";
import { CandidateFileList } from "./CandidateFileList.js";
import { ClaimStatusBadge, EstablishesLine } from "./EvidencePanel.js";
import { EmptyState } from "../common/EmptyState.js";

function StringList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="field-hint">None.</p>;
  return (
    <ul className="backlog-bullets">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

function ItemRefList({ items, projectId }: { items: TaskProposalDependency[]; projectId: string }) {
  if (items.length === 0) return <p className="field-hint">None.</p>;
  return (
    <ul className="backlog-bullets">
      {items.map((d) => (
        <li key={d.backlogItemId}>
          <Link to={`/projects/${projectId}/backlog/${d.backlogItemId}`}>
            {d.ref ? `${d.ref} — ` : ""}
            {d.title}
          </Link>{" "}
          <span className="field-hint">({CONFIDENCE_LABELS[d.confidence]}) {d.rationale}</span>
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
    <div className="backlog-proposal">
      <div className="backlog-row-top">
        <strong>{c ? c.title : "Task proposal"}</strong>
        <ProposalStatusBadge status={status} />
      </div>
      <p className="field-hint">
        A proposal is a draft. Nothing becomes a task until you approve it and then convert it, and the task still has to be started
        separately.
      </p>

      {c ? (
        <>
          {c.implementationConflict && c.implementationConflict !== "none" && (
            <div className="error-banner" role="status">
              <p>
                <strong>Implementation evidence conflicts with the reported absence ({c.implementationConflict}) — this may already be implemented.</strong> Behavior is not verified, so this
                is not a claim that it works or is fixed. The task goal is written as an investigation.
              </p>
            </div>
          )}
          {c.investigateFirst && (!c.implementationConflict || c.implementationConflict === "none") && (
            <div className="error-banner" role="alert">
              <p>
                <strong>Investigate first — CodeForge's evidence contradicts an AI claim this proposal would otherwise rest on</strong>
              </p>
            </div>
          )}
          <p>
            <span className="field-hint">AI-stated summary: </span>
            {c.summary}
          </p>
          <p className="field-hint">
            {ISSUE_TYPE_LABELS[c.issueType]}
            {c.affectedApplication ? ` · ${c.affectedApplication}` : ""}
            {c.suspectedArea ? ` · ${c.suspectedArea}` : ""}
          </p>
          <details>
            <summary>Task description that would be created</summary>
            <pre className="backlog-pre">{c.goal}</pre>
          </details>
          <h3>Acceptance criteria</h3>
          <StringList items={c.acceptanceCriteria} />
          <h3>Validation</h3>
          <StringList items={c.validation} />
          <h3>Dependencies (informational — not enforced)</h3>
          <ItemRefList items={c.dependencies} projectId={projectId} />
          <h3>Duplicate warnings</h3>
          <ItemRefList items={c.duplicateWarnings} projectId={projectId} />
          <h3>Uncertainty ({CONFIDENCE_LABELS[c.uncertainty.overall].toLowerCase()})</h3>
          <StringList items={c.uncertainty.uncertainties} />
          {c.uncertainty.missingInformation.length > 0 && (
            <ul className="backlog-bullets">
              {c.uncertainty.missingInformation.map((m, i) => (
                <li key={i}>
                  {m.blocking && <span className="backlog-blocking">BLOCKING</span>} {m.question}
                </li>
              ))}
            </ul>
          )}
          <h3>Candidate files</h3>
          <CandidateFileList files={c.candidateFiles} />
          {(c.claimAssessments ?? []).length > 0 && (
            <>
              <h3>Claim assessments (platform evidence vs AI claims)</h3>
              <ul className="claim-assessments">
                {(c.claimAssessments ?? []).map((a, i) => (
                  <li key={i} className={`claim-row claim-row-${a.status.toLowerCase().replace(/_/g, "-")}`}>
                    <div className="claim-cell">
                      <ClaimStatusBadge status={a.status} /> {a.statement}
                      <EstablishesLine establishes={a.establishes} />
                    </div>
                    <div className="claim-cell">
                      {a.reason}
                      {a.evidence.map((e, j) => (
                        <div key={j} className="field-hint">
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
        <div className="error-banner" role="alert">
          <p>This proposal's stored content is invalid. It can only be rejected.</p>
        </div>
      )}

      <div className="backlog-actions">
        {status === "PENDING" && c && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onApprove}>
            Approve proposal
          </button>
        )}
        {status === "APPROVED" && c && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onConvert}>
            Convert to task
          </button>
        )}
        {status === "CONVERTING" && (
          <button type="button" className="btn btn-primary" disabled>
            Converting…
          </button>
        )}
        {(status === "PENDING" || status === "APPROVED") && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onReject}>
            Reject proposal
          </button>
        )}
      </div>

      {status === "CONVERTED" && (
        <p role="status">
          {proposal.taskId && <Link to={`/tasks/${proposal.taskId}`}>Open task</Link>} The task is in Backlog on the Tasks tab — start it there when
          you're ready.
        </p>
      )}
      {status === "REJECTED" && <p className="field-hint">This proposal was rejected. You can generate a new one if the item is still analyzed.</p>}
    </div>
  );
}
