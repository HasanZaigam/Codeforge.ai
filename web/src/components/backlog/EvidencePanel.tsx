import type {
  BacklogAnalysisDTO,
  BacklogItemStatus,
  ClaimEstablishes,
  ClaimStatus,
  EvidenceAssessment,
  PlatformEvidence,
} from "../../api/index.js";
import { RECONCILIATION_LABELS, CLAIM_KIND_LABELS, ESTABLISHES_LABELS, CLAIM_STATUS_LABELS, CONFIDENCE_LABELS, INDEX_STATE_LABELS, LISTING_LABELS, SKIP_REASON_LABELS, VERIFICATION_STATE_LABELS } from "../../lib/backlogLabels.js";

/** The status always carries its word — colour is only reinforcement. */
export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return <span className={`claim-badge claim-${status.toLowerCase().replace(/_/g, "-")}`}>{CLAIM_STATUS_LABELS[status]}</span>;
}

/** Muted line saying what a status actually establishes (defaults to "nothing" on older records). */
export function EstablishesLine({ establishes }: { establishes: ClaimEstablishes | undefined }) {
  return <div className="field-hint">{ESTABLISHES_LABELS[establishes ?? "nothing"]}</div>;
}

/** One platform-obtained fact, e.g. "FILE_EXISTS backend/x.ts". CONTENT_MATCH carries a code excerpt. */
export function EvidenceLine({ evidence }: { evidence: PlatformEvidence }) {
  return (
    <>
      <span className="evidence-type">{evidence.type}</span> {evidence.path && <code>{evidence.path}</code>}
      {evidence.detail &&
        (evidence.type === "CONTENT_MATCH" ? (
          <pre className="backlog-pre evidence-excerpt">
            <code>{evidence.detail}</code>
          </pre>
        ) : (
          <span className="field-hint"> {evidence.detail}</span>
        ))}
    </>
  );
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** How the platform chose which files to show the model — the index (and its state) or file names only. Platform output, not AI. */
export function SelectionLine({ analysis }: { analysis: BacklogAnalysisDTO }) {
  const ctx = analysis.platformChecks?.context;
  const sel = ctx?.selection;
  const idx = ctx?.index;
  if (!sel || !idx) return null;
  const rev = idx.revision ? ` @ ${idx.revision.slice(0, 7)}` : "";
  const text =
    sel.method === "index"
      ? `Files chosen using the repository index${rev} (names, declared symbols, routes and imports) — ${sel.rankedFiles} ranked, ${sel.excerptPaths.length} read.`
      : `Files chosen by file name only — ${INDEX_STATE_LABELS[idx.state]}.`;
  return (
    <>
      <p className="field-hint">
        {text}
        {idx.state === "used" && idx.complete === false ? " The index is partial (a build limit was reached)." : ""}
      </p>
      {sel.method === "index" && sel.top.length > 0 && (
        <details>
          <summary>Why these files</summary>
          <ul className="backlog-file-list">
            {sel.top.slice(0, 8).map((t) => (
              <li key={t.path}>
                <code>{t.path}</code> <span className="field-hint">{t.reasons.join(", ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The platform's reconciliation of each AI claim with its own evidence, plus what is still NOT verified. Kept separate
 * from both the claim and the evidence lines. Never says "fixed": the strongest wording is a conflict with a reported
 * absence, and behaviour is stated as unverified unless a bound platform check passed.
 */
export function ReconciliationSection({ assessment }: { assessment: EvidenceAssessment | undefined }) {
  const r = assessment?.reconciliation;
  if (!r || r.findings.length === 0) return null;
  const relevant = r.findings.filter((f) => f.outcome === "IMPLEMENTATION_PRESENT" || f.outcome === "IMPLEMENTATION_POSSIBLE" || f.outcome === "CHECK_VERIFIED");
  return (
    <>
      <h4>Reconciliation</h4>
      {r.alreadyImplemented !== "none" && (
        <div className={r.alreadyImplemented === "strong" ? "error-banner" : "field-hint"} role="status">
          <p>
            <strong>Possibly already implemented ({r.alreadyImplemented}).</strong> Implementation evidence conflicts with a reported absence. This does not mean the item is fixed —{" "}
            behavior has not been verified.
          </p>
        </div>
      )}
      {relevant.length > 0 ? (
        <ul className="backlog-bullets">
          {relevant.map((f) => (
            <li key={f.claimIndex}>
              <strong>{RECONCILIATION_LABELS[f.outcome]}</strong>
              {f.strength ? ` (${f.strength})` : ""} — AI claim: “{f.statement}”
              <div className="field-hint">{f.explanation}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">No claim was found to conflict with repository evidence.</p>
      )}
      <p className="field-hint">
        Behavior verification: {r.behaviorVerified ? "a platform check bound to a claim passed at this revision." : "not verified — no platform check bound to a claim was run."}
        {r.revision ? ` Evidence reconciled at revision ${r.revision.slice(0, 7)}.` : ""}
        {r.ignoredEvidence.length > 0 ? ` ${r.ignoredEvidence.length} evidence item(s) for another revision were ignored.` : ""}
      </p>
    </>
  );
}

/** Checks the platform judged relevant to behaviour claims, and whether any ran. */
export function VerificationList({ assessment }: { assessment: EvidenceAssessment | undefined }) {
  const reqs = assessment?.verification ?? [];
  if (reqs.length === 0) return null;
  return (
    <>
      <h4>Verification</h4>
      <ul className="backlog-bullets">
        {reqs.map((r) => (
          <li key={`${r.claimIndex}-${r.checkId}`}>
            Claim {r.claimIndex + 1} — <code>{r.checkId}</code> check: <strong>{VERIFICATION_STATE_LABELS[r.state]}</strong>
            <div className="field-hint">{r.reason}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** What the model claimed — labelled as unverified, never as fact. */
export function AiClaimsList({ analysis }: { analysis: BacklogAnalysisDTO }) {
  const claims = analysis.result?.claims ?? [];
  if (claims.length === 0) return <p className="field-hint">The model made no structured claims about the repository.</p>;
  return (
    <>
      <h4>Claims the AI made (unverified)</h4>
      <ul className="backlog-bullets">
        {claims.map((c, i) => (
          <li key={i}>
            {c.statement} <span className="field-hint">({CLAIM_KIND_LABELS[c.kind]} · AI confidence: {CONFIDENCE_LABELS[c.confidence].replace(" confidence", "").toLowerCase()})</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** What CodeForge itself checked: inspection scope, declined files, and the raw evidence. */
export function PlatformEvidenceSection({ assessment }: { assessment: EvidenceAssessment | undefined }) {
  if (!assessment) return <p className="field-hint">No platform evidence was recorded for this analysis.</p>;
  const { inspection, evidence } = assessment;
  const skippedByReason = new Map<string, string[]>();
  for (const s of inspection.filesSkipped) skippedByReason.set(s.reason, [...(skippedByReason.get(s.reason) ?? []), s.path]);
  return (
    <>
      <p>
        Repository listing: {LISTING_LABELS[inspection.listing]} — {inspection.filesRead} file{inspection.filesRead === 1 ? "" : "s"} read, {kb(inspection.bytesRead)}
      </p>
      {skippedByReason.size > 0 && (
        <details>
          <summary>{inspection.filesSkipped.length} file{inspection.filesSkipped.length === 1 ? "" : "s"} CodeForge declined to read</summary>
          {[...skippedByReason].map(([reason, paths]) => (
            <div key={reason}>
              <strong>{SKIP_REASON_LABELS[reason] ?? reason}</strong> ({paths.length})
              <ul className="backlog-file-list">
                {paths.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
      {evidence.length === 0 ? (
        <p className="field-hint">No evidence was gathered for any claim.</p>
      ) : (
        <ul className="backlog-file-list">
          {evidence.map((e) => (
            <li key={e.id}>
              <EvidenceLine evidence={e} />
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Evidence comes from the repository listing and bounded file reads — nothing here was written by the model.
      </p>
    </>
  );
}

/** Claim vs evidence, side by side (stacked on mobile), with the platform's deterministic verdict. */
export function AssessmentSection({ assessment, itemStatus }: { assessment: EvidenceAssessment | undefined; itemStatus: BacklogItemStatus }) {
  if (!assessment || assessment.claims.length === 0) {
    return <p className="field-hint">No claim assessment is available for this analysis.</p>;
  }
  const byId = new Map(assessment.evidence.map((e) => [e.id, e]));
  return (
    <>
      <p className="field-hint">
        Existence is not correctness: SUPPORTED/CONTRADICTED speak about what exists in the repository, never about whether it works.
      </p>
      <ReconciliationSection assessment={assessment} />
      <VerificationList assessment={assessment} />
      {assessment.confidenceOverridden && (
        <div className="error-banner" role="alert">
          <p>The AI stated high confidence, but CodeForge's own evidence contradicts a claim. Confidence does not override evidence.</p>
        </div>
      )}
      {itemStatus === "NEEDS_CLARIFICATION" && assessment.summary.contradicted > 0 && (
        <p role="status">A human should review the contradiction before a task proposal can be made.</p>
      )}
      <ul className="claim-assessments">
        {assessment.claims.map((c) => {
          const lines = c.evidenceIds.map((id) => byId.get(id)).filter((e): e is PlatformEvidence => !!e);
          return (
            <li key={c.claimIndex} className={`claim-row claim-row-${c.status.toLowerCase().replace(/_/g, "-")}`}>
              <div className="claim-cell">
                <strong>AI says:</strong> {c.statement}{" "}
                <span className="field-hint">(AI confidence: {CONFIDENCE_LABELS[c.aiConfidence].replace(" confidence", "").toLowerCase()})</span>
              </div>
              <div className="claim-cell">
                <strong>Platform checked:</strong>{" "}
                {lines.length > 0 ? (
                  <ul className="backlog-file-list">
                    {lines.map((e) => (
                      <li key={e.id}>
                        <EvidenceLine evidence={e} />
                      </li>
                    ))}
                  </ul>
                ) : c.status === "NOT_CHECKED" ? (
                  "not checked"
                ) : (
                  "nothing found"
                )}
              </div>
              <div className="claim-cell">
                <ClaimStatusBadge status={c.status} />
                <EstablishesLine establishes={c.establishes} />
                <div>{c.reason}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Reported usage (only non-null counts) and, separately, the estimated cost. Never renders 0 for "not reported". */
export function UsageBlock({ analysis }: { analysis: BacklogAnalysisDTO }) {
  const { usage, estimatedCost } = analysis;
  if (!usage && !estimatedCost) return <p className="field-hint">Usage not reported by the engine.</p>;
  const rows: Array<[string, number | null]> = usage
    ? [
        ["Input tokens", usage.inputTokens],
        ["Output tokens", usage.outputTokens],
        ["Reasoning tokens", usage.reasoningTokens],
        ["Cache read tokens", usage.cacheReadTokens],
        ["Cache write tokens", usage.cacheWriteTokens],
      ]
    : [];
  const producedBy = [analysis.providerId, analysis.modelId].filter(Boolean).join(" / ");
  return (
    <>
      <dl className="backlog-facts">
        {producedBy && (
          <>
            <dt>Model</dt>
            <dd>{producedBy}</dd>
          </>
        )}
        {rows.map(([label, n]) =>
          n === null ? null : (
            <div key={label} className="usage-row">
              <dt>{label}</dt>
              <dd>{n.toLocaleString("en-US")}</dd>
            </div>
          ),
        )}
      </dl>
      {estimatedCost && (
        <p>
          Estimated cost: {formatCost(estimatedCost.amount, estimatedCost.currency)} — estimate reported by {estimatedCost.pricingSource} (not provider-billed)
        </p>
      )}
    </>
  );
}

function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
