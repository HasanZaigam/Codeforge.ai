import { useState } from "react";
import { adjudicationApi, adjudicationBaselineApi, backlogApi, type AdjudicationImportSummaryDTO, type AdjudicationMetricsDTO, type BacklogItemDetailDTO, type BaselineDTO, type ClarificationLabel, type DuplicateSampleDTO, type ItemSampleDTO, type ProposalReadinessLabel, type RelationshipJudgmentLabel, type ReviewCategoryStatus } from "../../api/index.js";
import { AiClaimsList, ReconciliationSection } from "./EvidencePanel.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";

const STATUS_TEXT: Record<ReviewCategoryStatus, string> = { NOT_REVIEWED: "Not measured", IN_PROGRESS: "In progress", REVIEWED: "Reviewed" };

const REL_LABELS: RelationshipJudgmentLabel[] = ["CONFIRMED_DUPLICATE", "RELATED_NOT_DUPLICATE", "REJECTED"];
const CLARIFICATION_LABELS: ClarificationLabel[] = ["CORRECT_CLARIFICATION", "SHOULD_BE_PROPOSAL_READY", "INSUFFICIENT_ANALYSIS", "OTHER"];
const PROPOSAL_READY_LABELS: ProposalReadinessLabel[] = ["CORRECT_PROPOSAL_READY", "NEEDS_CLARIFICATION", "INSUFFICIENT_ANALYSIS", "OTHER"];
const LABEL_TEXT: Record<string, string> = {
  CONFIRMED_DUPLICATE: "Confirmed duplicate", RELATED_NOT_DUPLICATE: "Related, not a duplicate", REJECTED: "Rejected",
  CORRECT_CLARIFICATION: "Correct — clarification genuinely needed", SHOULD_BE_PROPOSAL_READY: "Should be proposal-ready", INSUFFICIENT_ANALYSIS: "Insufficient analysis", OTHER: "Other",
  CORRECT_PROPOSAL_READY: "Correct — proposal-ready", NEEDS_CLARIFICATION: "Should need clarification",
};

/** Inline "why did CodeForge reach this" context, fetched lazily per item — the reviewer never has to leave the queue to judge. */
function ItemContext({ itemId }: { itemId: string }) {
  const [detail, setDetail] = useState<BacklogItemDetailDTO>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (detail) return;
    setLoading(true);
    backlogApi.get(itemId).then(setDetail).finally(() => setLoading(false));
  };
  const assessment = detail?.latestAnalysis?.status === "succeeded" ? detail.latestAnalysis.platformChecks?.assessment : undefined;
  return (
    <div>
      <button type="button" className="btn btn-secondary" onClick={load}>{open ? "Hide evidence" : "Show AI analysis & evidence"}</button>
      {open && (loading ? <LoadingState label="Loading…" /> : detail?.latestAnalysis?.status === "succeeded" ? (
        <div className="field-hint">
          <AiClaimsList analysis={detail.latestAnalysis} />
          <ReconciliationSection assessment={assessment} />
        </div>
      ) : <p className="field-hint">No successful analysis to show.</p>)}
    </div>
  );
}

function SamplingControls({ seed, setSeed, size, setSize, onSample, busy }: { seed: string; setSeed: (s: string) => void; size: number; setSize: (n: number) => void; onSample: () => void; busy: boolean }) {
  return (
    <div className="field-hint" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <label>Seed <input value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: 100 }} /></label>
      <label>Sample size <input type="number" min={1} max={500} value={size} onChange={(e) => setSize(Number(e.target.value) || 1)} style={{ width: 60 }} /></label>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onSample}>Sample</button>
      <span>The same seed + size always selects the same items — the sample is reproducible.</span>
    </div>
  );
}

function DuplicateReview({ projectId }: { projectId: string }) {
  const [seed, setSeed] = useState("baseline-1");
  const [size, setSize] = useState(8);
  const [data, setData] = useState<DuplicateSampleDTO>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const sample = () => { setBusy(true); setError(undefined); adjudicationApi.sampleDuplicates(projectId, seed, size).then(setData).catch((e) => setError(e.message)).finally(() => setBusy(false)); };
  const judge = async (relationshipId: string, label: RelationshipJudgmentLabel) => {
    await adjudicationApi.judgeRelationship(relationshipId, label);
    sample();
  };

  return (
    <section aria-label="Duplicate review">
      <h3>Duplicate review</h3>
      <p className="field-hint">Judge each EDGE independently — confirming A↔B says nothing about A↔C in the same group.</p>
      <SamplingControls seed={seed} setSeed={setSeed} size={size} setSize={setSize} onSample={sample} busy={busy} />
      {error && <ErrorState message={error} />}
      {data && (
        <>
          <p className="field-hint">{data.groups.length} of {data.totalGroups} duplicate group(s) sampled.</p>
          {data.groups.map((g) => (
            <div key={g.groupKey} className="card">
              <strong>Group:</strong> {g.items.map((i) => i.ref ?? i.title).join(" · ")}
              <ul className="backlog-bullets">
                {g.edges.map((e) => {
                  const a = g.items.find((i) => i.id === e.fromItemId);
                  const b = g.items.find((i) => i.id === e.toItemId);
                  return (
                    <li key={e.relationshipId}>
                      {a?.ref ?? a?.title} ↔ {b?.ref ?? b?.title} — AI confidence {e.confidence}, {e.status.toLowerCase()} — {e.rationale}
                      {e.current && <div className="field-hint">Human judgment (current): <strong>{LABEL_TEXT[e.current.label]}</strong>{e.current.note ? ` — "${e.current.note}"` : ""}{e.history.length > 1 ? ` (${e.history.length} judgments recorded)` : ""}</div>}
                      <div>
                        {REL_LABELS.map((l) => (
                          <button key={l} type="button" className="btn btn-secondary" onClick={() => void judge(e.relationshipId, l)}>{LABEL_TEXT[l]}</button>
                        ))}
                      </div>
                      <ItemContext itemId={e.fromItemId} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function ItemReview({ projectId, category, sampler, labels }: { projectId: string; category: "CLARIFICATION" | "PROPOSAL_READINESS"; sampler: (projectId: string, seed: string, size: number) => Promise<ItemSampleDTO>; labels: string[] }) {
  const [seed, setSeed] = useState("baseline-1");
  const [size, setSize] = useState(10);
  const [data, setData] = useState<ItemSampleDTO>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const sample = () => { setBusy(true); setError(undefined); sampler(projectId, seed, size).then(setData).catch((e) => setError(e.message)).finally(() => setBusy(false)); };
  const judge = async (itemId: string, label: string) => {
    await adjudicationApi.judgeItem(itemId, category, label as ClarificationLabel | ProposalReadinessLabel);
    sample();
  };

  return (
    <section aria-label={category === "CLARIFICATION" ? "Clarification review" : "Proposal readiness review"}>
      <h3>{category === "CLARIFICATION" ? "Clarification review" : "Proposal readiness review"}</h3>
      <p className="field-hint">{category === "CLARIFICATION" ? "Was clarification genuinely required?" : "Is this item genuinely ready for a task proposal?"}</p>
      <SamplingControls seed={seed} setSeed={setSeed} size={size} setSize={setSize} onSample={sample} busy={busy} />
      {error && <ErrorState message={error} />}
      {data && (
        <>
          <p className="field-hint">{data.sampled.length} of {data.totalCandidates} candidate(s) sampled.</p>
          <ul className="backlog-bullets">
            {data.sampled.map((s) => (
              <li key={s.row.itemId}>
                <strong>{s.row.ref ?? s.row.title}</strong> — {s.row.title}
                <div className="field-hint">AI review state: {s.row.review.state ?? "—"}; implementation {s.row.review.implementation}; behavior {s.row.review.behavior}.</div>
                {s.current && (
                  <div className="field-hint">
                    Human judgment (current): <strong>{LABEL_TEXT[s.current.label]}</strong>{s.current.note ? ` — "${s.current.note}"` : ""}
                    {s.stale && " — the item has since been re-analyzed; this judgment is historical, not a verdict on the new analysis."}
                  </div>
                )}
                <div>
                  {labels.map((l) => (
                    <button key={l} type="button" className="btn btn-secondary" onClick={() => void judge(s.row.itemId, l)}>{LABEL_TEXT[l]}</button>
                  ))}
                </div>
                <ItemContext itemId={s.row.itemId} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function MetricsSummary({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [metrics, setMetrics] = useState<AdjudicationMetricsDTO>();
  useState(() => { adjudicationApi.metrics(projectId).then(setMetrics).catch(() => setMetrics(undefined)); });
  if (!metrics) return null;
  void refreshKey;
  return (
    <section aria-label="Descriptive adjudication metrics" className="section">
      <h3>Descriptive metrics (not a quality score)</h3>
      <p className="field-hint">
        Duplicates: {metrics.duplicates.relationshipsReviewed} edge(s) reviewed across {metrics.duplicates.groupsReviewed}/{metrics.duplicates.totalGroups} group(s) —{" "}
        {metrics.duplicates.confirmedDuplicate} confirmed, {metrics.duplicates.relatedNotDuplicate} related-not-duplicate, {metrics.duplicates.rejected} rejected
        {metrics.duplicates.confirmationRate !== null ? ` (${Math.round(metrics.duplicates.confirmationRate * 100)}% confirmation rate)` : ""}.
      </p>
      <p className="field-hint">
        Clarification: {metrics.clarification.reviewed} reviewed — {metrics.clarification.correctClarification} correct, {metrics.clarification.shouldBeProposalReady} should be proposal-ready,{" "}
        {metrics.clarification.insufficientAnalysis} insufficient analysis, {metrics.clarification.other} other.
      </p>
      <p className="field-hint">
        Proposal readiness: {metrics.proposalReadiness.reviewed} reviewed — {metrics.proposalReadiness.correctProposalReady} correct, {metrics.proposalReadiness.needsClarification} should need clarification,{" "}
        {metrics.proposalReadiness.insufficientAnalysis} insufficient analysis, {metrics.proposalReadiness.other} other.
      </p>
    </section>
  );
}

function CsvImportPanel({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const [csvText, setCsvText] = useState("");
  const [summary, setSummary] = useState<AdjudicationImportSummaryDTO>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await adjudicationBaselineApi.importCsv(projectId, csvText);
      setSummary(result);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Import human-filled labels" className="section">
      <h3>Import a human-filled ground-truth CSV</h3>
      <p className="field-hint">
        Export a template below, have a reviewer fill in its <code>label</code> column, then paste the filled file here. The AI columns
        (context, confidence/state) are reference only — the server never trusts them, and a target that does not belong to this project
        is rejected row by row rather than failing the whole file.
      </p>
      <div className="field">
        <label htmlFor="adj-csv-file">CSV file</label>
        <input id="adj-csv-file" type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0]?.text().then(setCsvText)} />
      </div>
      <div className="field">
        <label htmlFor="adj-csv-text">…or paste CSV</label>
        <textarea id="adj-csv-text" rows={4} value={csvText} onChange={(e) => setCsvText(e.target.value)} />
      </div>
      {error && <ErrorState message={error} />}
      <button type="button" className="btn btn-primary" disabled={busy || csvText.trim() === ""} onClick={() => void submit()}>
        {busy ? "Importing…" : "Import labels"}
      </button>
      {summary && (
        <p role="status" className="field-hint">
          {summary.totalRows} rows: {summary.imported} imported, {summary.blank} not yet filled in, {summary.invalidLabel} invalid label,{" "}
          {summary.wrongProject} wrong project, {summary.notFound} not found, {summary.malformedRow} other error.
        </p>
      )}
    </section>
  );
}

function BaselinePanel({ projectId }: { projectId: string }) {
  const [seed, setSeed] = useState("baseline-1");
  const [dupSize, setDupSize] = useState(8);
  const [clarSize, setClarSize] = useState(15);
  const [propSize, setPropSize] = useState(10);
  const [runId, setRunId] = useState("");
  const [baseline, setBaseline] = useState<BaselineDTO>();
  const [history, setHistory] = useState<BaselineDTO[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const b = await adjudicationBaselineApi.createBaseline(projectId, { seed, duplicateSize: dupSize, clarificationSize: clarSize, proposalReadySize: propSize, ...(runId.trim() ? { runId: runId.trim() } : {}) });
      setBaseline(b);
      setHistory(await adjudicationBaselineApi.listBaselines(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the baseline.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Baseline snapshot" className="section">
      <h3>Baseline snapshot</h3>
      <p className="field-hint">
        Freezes exactly which groups/items were sampled and the metrics computed from whatever has been judged so far. It never changes
        afterward — a later review creates a NEW, separately versioned snapshot, never rewriting this one.
      </p>
      <div className="field">
        <label htmlFor="baseline-run-id">Bulk analysis run id (optional — scopes the sample to ONE specific run, so it can never mix with a different run)</label>
        <input id="baseline-run-id" value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="leave blank for project-wide sampling" />
      </div>
      <SamplingControls seed={seed} setSeed={setSeed} size={dupSize} setSize={setDupSize} onSample={() => void create()} busy={busy} />
      <div className="field-hint">Clarification size <input type="number" min={1} max={500} value={clarSize} onChange={(e) => setClarSize(Number(e.target.value) || 1)} style={{ width: 60 }} /> Proposal-ready size <input type="number" min={1} max={500} value={propSize} onChange={(e) => setPropSize(Number(e.target.value) || 1)} style={{ width: 60 }} /></div>
      {error && <ErrorState message={error} />}
      {baseline && (
        <div className="card">
          {baseline.sample.runId && (
            <div role="status" className="error-banner" style={{ background: "var(--tone-info-bg, #eef)" }}>
              <strong>CORRECTED REPOSITORY-AWARE RUN</strong>
              <div className="field-hint">
                run {baseline.sample.runId.slice(0, 8)} · revision {baseline.repositoryRevisions.map((r) => r.slice(0, 7)).join(", ") || "—"} · model(s) {baseline.models.join(", ") || "—"} ·{" "}
                {baseline.sample.actualSampleSizes.duplicateEdges + baseline.sample.actualSampleSizes.clarificationItems + baseline.sample.actualSampleSizes.proposalReadyItems} sampled ·{" "}
                {baseline.sample.infrastructureFailures.length} infrastructure failure(s) excluded
              </div>
            </div>
          )}
          <p>
            <strong>Baseline v{baseline.version}</strong> — {baseline.established ? "ESTABLISHED" : "NOT ESTABLISHED — no human labels collected yet"}. Seed <code>{baseline.seed}</code>,
            revision(s) {baseline.repositoryRevisions.map((r) => r.slice(0, 7)).join(", ") || "—"}, model(s) {baseline.models.join(", ") || "—"}.
          </p>
          {baseline.sample.infrastructureFailures.length > 0 && (
            <details>
              <summary>{baseline.sample.infrastructureFailures.length} infrastructure failure(s) excluded from every sample</summary>
              <ul className="backlog-bullets">
                {baseline.sample.infrastructureFailures.map((f) => (
                  <li key={f.itemId}>{f.ref ?? f.itemId} — {f.title} — <span className="field-hint">{f.failureCategory ?? "unknown"}: {f.failureReason ?? "no reason recorded"}</span></li>
                ))}
              </ul>
            </details>
          )}
          <ul className="backlog-bullets">
            <li>
              Duplicates: {baseline.metrics.duplicates.reviewedEdges}/{baseline.metrics.duplicates.sampledEdges} edges reviewed ({baseline.metrics.duplicates.sampledGroups}/{baseline.metrics.duplicates.candidateGroups} groups sampled) —{" "}
              <strong>{STATUS_TEXT[baseline.metrics.duplicates.status]}</strong>
              {baseline.metrics.duplicates.confirmationRate !== null ? ` — ${baseline.metrics.duplicates.labelDistribution.CONFIRMED_DUPLICATE ?? 0}/${baseline.metrics.duplicates.reviewedEdges} confirmed (${Math.round(baseline.metrics.duplicates.confirmationRate * 100)}%)` : ""}
              {baseline.metrics.duplicates.staleEdges > 0 ? ` (${baseline.metrics.duplicates.staleEdges} stale — excluded)` : ""}
              <span className="field-hint"> — {baseline.metrics.duplicates.unreviewedEdges} not yet reviewed.</span>
            </li>
            <li>
              Clarification: {baseline.metrics.clarification.reviewedCount}/{baseline.metrics.clarification.sampledCount} reviewed — <strong>{STATUS_TEXT[baseline.metrics.clarification.status]}</strong>
              {baseline.metrics.clarification.staleCount > 0 ? ` (${baseline.metrics.clarification.staleCount} stale — excluded)` : ""}
              <span className="field-hint"> — {baseline.metrics.clarification.unreviewedCount} not yet reviewed.</span>
            </li>
            <li>
              Proposal readiness: {baseline.metrics.proposalReadiness.reviewedCount}/{baseline.metrics.proposalReadiness.sampledCount} reviewed — <strong>{STATUS_TEXT[baseline.metrics.proposalReadiness.status]}</strong>
              {baseline.metrics.proposalReadiness.staleCount > 0 ? ` (${baseline.metrics.proposalReadiness.staleCount} stale — excluded)` : ""}
              <span className="field-hint"> — {baseline.metrics.proposalReadiness.unreviewedCount} not yet reviewed.</span>
            </li>
          </ul>
          {!baseline.established && (
            <p role="status" className="error-banner">
              NO HUMAN LABELS AVAILABLE — BASELINE NOT ESTABLISHED. Import a human-filled CSV or judge items above, then create a new baseline.
            </p>
          )}
          <details>
            <summary>Limitations</summary>
            <ul className="backlog-bullets">{baseline.metrics.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
          </details>
        </div>
      )}
      {history && history.length > 1 && (
        <p className="field-hint">{history.length} baseline snapshot(s) recorded for this project, newest first: v{history.map((h) => h.version).join(", v")}.</p>
      )}
    </section>
  );
}

/** Phase 4B.1/4B.2 — the human ground-truth review queue and baseline. AI output is never overwritten here; every judgment is a separate, auditable record. */
export function AdjudicationPanel({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  return (
    <div>
      <p className="field-hint">
        These labels are ground truth for measuring CodeForge, not instructions that change any AI output, review state, duplicate proposal or task.
      </p>
      <a className="btn btn-secondary" href={adjudicationApi.exportUrl(projectId)} target="_blank" rel="noreferrer">
        Export ground truth (CSV)
      </a>
      <CsvImportPanel projectId={projectId} onImported={() => setRefresh((n) => n + 1)} />
      <DuplicateReview projectId={projectId} />
      <ItemReview projectId={projectId} category="CLARIFICATION" sampler={adjudicationApi.sampleClarification} labels={CLARIFICATION_LABELS} />
      <ItemReview projectId={projectId} category="PROPOSAL_READINESS" sampler={adjudicationApi.sampleProposalReady} labels={PROPOSAL_READY_LABELS} />
      <MetricsSummary projectId={projectId} refreshKey={refresh} />
      <BaselinePanel projectId={projectId} />
    </div>
  );
}
