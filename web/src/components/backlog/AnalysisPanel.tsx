import type { BacklogAnalysisDTO, BacklogItemStatus, ClaimVerificationDTO } from "../../api/index.js";
import { CONFIDENCE_LABELS, FAILURE_CATEGORY_LABELS, ISSUE_TYPE_LABELS } from "../../lib/backlogLabels.js";
import { ToneBadge } from "../common/ToneBadge.js";
import { formatAbsolute, formatDurationMs } from "../../lib/time.js";
import { EmptyState } from "../common/EmptyState.js";
import { CandidateFileList } from "./CandidateFileList.js";
import { AiClaimsList, AssessmentSection, InvestigationSection, PlatformEvidenceSection, SelectionLine, UsageBlock, type VerificationControls } from "./EvidencePanel.js";

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

function ContextSummary({ analysis }: { analysis: BacklogAnalysisDTO }) {
  const ctx = analysis.platformChecks?.context;
  if (!ctx) return null;
  const repo =
    ctx.repositoryStructure === "unavailable"
      ? "repository listing not available"
      : `repository listing ${ctx.repositoryStructure === "truncated" ? "included (truncated)" : "included"}${
          ctx.repositoryFileCount !== null ? `, ${ctx.repositoryFileCount} files` : ""
        }`;
  return (
    <p className="text-sm text-muted-foreground">
      Context given to the model: project context {ctx.projectContextIncluded ? "included" : "not included"}; {repo};{" "}
      {ctx.siblingItemsIncluded} other backlog item{ctx.siblingItemsIncluded === 1 ? "" : "s"} included
      {ctx.siblingItemsOmitted > 0 ? ` (${ctx.siblingItemsOmitted} omitted)` : ""}.
    </p>
  );
}

/**
 * The latest analysis attempt. A succeeded analysis is an AI PROPOSAL — every claim is labelled as such,
 * and the only facts shown are the platform's own checks (`platformChecks`). A failed analysis shows
 * the failure plainly; nothing from it was accepted.
 */
export function AnalysisPanel({ analysis, itemStatus, jobStatus = null, verifications = [], controls }: { analysis: BacklogAnalysisDTO | null; itemStatus: BacklogItemStatus; jobStatus?: string | null; verifications?: ClaimVerificationDTO[]; controls?: VerificationControls }) {
  if (!analysis) {
    if (itemStatus === "ANALYZING") return <p>{jobStatus === "QUEUED" ? "Waiting for a worker to start the analysis…" : "Analysis in progress…"}</p>;
    return <EmptyState message="This item has not been analyzed yet. Run “Analyze” to have CodeForge investigate it." />;
  }

  const producedBy = [analysis.providerId, analysis.modelId].filter(Boolean).join(" / ");
  const duration = formatDurationMs(analysis.durationMs);

  if (analysis.status === "failed") {
    return (
      <div className="space-y-2 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm" role="alert">
        <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Analysis failed</h3>
        <p>
          <strong>{analysis.failureCategory ? FAILURE_CATEGORY_LABELS[analysis.failureCategory] : "Unknown failure"}</strong>
        </p>
        {analysis.failureReason && <p>{analysis.failureReason}</p>}
        <p className="text-sm text-muted-foreground">
          Nothing from this attempt was accepted, and no task can be created from it. You can re-analyze
          {analysis.failureCategory === "malformed_output" ? " — the item is marked “Needs clarification” until you do" : ""}.
        </p>
        {analysis.diagnostics && (
          <details>
            <summary>Diagnostics</summary>
            <pre className="overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(analysis.diagnostics, null, 2)}</pre>
          </details>
        )}
        <p className="text-sm text-muted-foreground">
          {[producedBy && `Attempted with ${producedBy}`, duration && `after ${duration}`, formatAbsolute(analysis.completedAt)].filter(Boolean).join(" · ")}
        </p>
      </div>
    );
  }

  const result = analysis.result;
  if (!result) return <p>This analysis has no stored result.</p>;
  const assessment = analysis.platformChecks?.assessment;
  const fileChecks = new Map((analysis.platformChecks?.candidateFiles ?? []).map((c) => [c.path, c.existsInRepository]));

  return (
    <div className="space-y-1">
      <section className="mb-4 border-l-2 pl-3" aria-labelledby="trust-ai">
        <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0" id="trust-ai">AI analysis — what the model believes (a proposal, not verified)</h3>
      <p className="text-sm text-muted-foreground">
        AI-proposed analysis — a suggestion for you to review, not a verified fact. Only the “repository” labels on files are checked by
        CodeForge itself.
      </p>
      <p className="text-sm">{result.summary}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Issue type</dt>
        <dd>{ISSUE_TYPE_LABELS[result.issueType]}</dd>
        <dt>Affected application</dt>
        <dd>{result.affectedApplication ?? "Not identified"}</dd>
        <dt>Suspected area</dt>
        <dd>{result.suspectedArea ?? "Not identified"}</dd>
        <dt>Confidence</dt>
        <dd>{CONFIDENCE_LABELS[result.confidence.overall]}</dd>
        <dt>Produced by</dt>
        <dd>
          {producedBy || "Unknown model"}
          {duration ? ` · ${duration}` : ""}
          {analysis.engineKey ? ` · engine ${analysis.engineKey}` : ""}
        </dd>
      </dl>
      <ContextSummary analysis={analysis} />
      <SelectionLine analysis={analysis} />

      <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Uncertainties</h3>
      <StringList items={result.confidence.uncertainties} />

      <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Missing information</h3>
      {result.missingInformation.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {result.missingInformation.map((m, i) => (
            <li key={i}>
              {m.blocking && <ToneBadge tone="danger">BLOCKING</ToneBadge>} {m.question}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Suggested acceptance criteria</h3>
      <StringList items={result.suggestedAcceptanceCriteria} />
      <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Suggested validation</h3>
      <StringList items={result.suggestedValidation} />

      <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0">Candidate files</h3>
      <CandidateFileList files={result.candidateFiles.map((f) => ({ ...f, existsInRepository: fileChecks.get(f.path) ?? null }))} />

      <AiClaimsList analysis={analysis} />
      </section>

      <section className="mb-4 border-l-2 pl-3 border-tone-info/50" aria-labelledby="trust-platform">
        <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0" id="trust-platform">Platform evidence — what CodeForge actually checked</h3>
        <InvestigationSection assessment={assessment} />
        <PlatformEvidenceSection assessment={assessment} />
      </section>

      <section className="mb-4 border-l-2 pl-3 border-tone-active/50" aria-labelledby="trust-assessment">
        <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0" id="trust-assessment">Evidence assessment — claim vs evidence</h3>
        <AssessmentSection assessment={assessment} itemStatus={itemStatus} verifications={verifications} controls={controls} />
      </section>

      {(analysis.usage || analysis.estimatedCost) && (
        <section className="mb-4 border-l-2 pl-3" aria-labelledby="trust-usage">
          <h3 className="mt-5 mb-2 text-sm font-semibold first:mt-0" id="trust-usage">Model usage</h3>
          <UsageBlock analysis={analysis} />
        </section>
      )}
    </div>
  );
}
