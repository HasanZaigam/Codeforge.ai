import { randomUUID } from "node:crypto";
import { CLARIFICATION_LABELS, PROPOSAL_READINESS_LABELS, RELATIONSHIP_JUDGMENT_LABELS, deterministicSample, labelsFor, parseAdjudicationImport, type ClarificationLabel, type ImportRowOutcome, type ProposalReadinessLabel, type ReviewJudgmentCategory } from "../backlog/adjudication.js";
import { csvEscape } from "../backlog/import-csv.js";
import type { BacklogAnalysisRepository } from "../persistence/repositories/backlog-analysis-repository.js";
import { BacklogAdjudicationBaselineRepository, type BaselineRecord } from "../persistence/repositories/backlog-adjudication-baseline-repository.js";
import { BacklogAdjudicationRepository, type ItemJudgmentRecord, type RelationshipJudgmentRecord } from "../persistence/repositories/backlog-adjudication-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { BacklogRelationshipRepository } from "../persistence/repositories/backlog-relationship-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import { assertProjectAccess } from "./authorization.js";
import type { BacklogBulkService, ReviewRow } from "./backlog-bulk-service.js";
import { InvalidOperationError, InvalidRequestError, NotFoundError } from "./errors.js";

export interface AdjudicationDeps {
  items: BacklogItemRepository;
  analyses: BacklogAnalysisRepository;
  relationships: BacklogRelationshipRepository;
  projects: ProjectRepository;
  judgments: BacklogAdjudicationRepository;
  baselines: BacklogAdjudicationBaselineRepository;
  bulk: BacklogBulkService;
}

const now = () => new Date().toISOString();
const MAX_NOTE = 2000;
const MAX_SAMPLE_SIZE = 500;
const MAX_IMPORT_BYTES = 300_000;
const MAX_IMPORT_ROWS = 2000;

export interface SampledEdge {
  relationshipId: string;
  fromItemId: string;
  toItemId: string;
  confidence: string;
  status: string;
  rationale: string;
  analysisId: string;
  revision: string | null;
  current: RelationshipJudgmentRecord | null;
  /** Every judgment ever recorded for this edge — nothing is hidden when a later one supersedes it. */
  history: RelationshipJudgmentRecord[];
  /** True once the relationship's own CURRENT analysisId (a re-analysis re-proposed it) differs from what `current` was judged against. */
  stale: boolean;
}

export interface SampledGroup {
  groupKey: string;
  items: Array<{ id: string; ref: string | null; title: string }>;
  edges: SampledEdge[];
}

export interface SampledItem {
  row: ReviewRow;
  current: ItemJudgmentRecord | null;
  history: ItemJudgmentRecord[];
  /** True once the item's analysis has moved on from the one this judgment was made against — the OLD judgment stays valid history, it is just no longer about the CURRENT analysis. */
  stale: boolean;
}

/** revision the platform recorded for an analysis, or null (legacy/failed analyses record none). */
function revisionOf(analysisId: string, analyses: BacklogAnalysisRepository): string | null {
  const a = analyses.findById(analysisId);
  return a?.status === "succeeded" ? (a.platformChecks?.assessment?.reconciliation?.revision ?? null) : null;
}

/**
 * Phase 4B.1 — human ground-truth adjudication. This is a SEPARATE layer: nothing here ever writes to `backlog_items`,
 * `backlog_analyses` or `backlog_relationships` — every judgment is its own append-only row bound to the exact
 * (analysis, revision) that was current when the human made it (never a client-supplied one, so a judgment cannot be
 * forged onto an analysis/revision it was never made against). No judgment ever changes what the platform's own
 * analysis/reconciliation says.
 */
export interface ImportRowResult {
  rowNumber: number;
  outcome: ImportRowOutcome | "WRONG_PROJECT" | "NOT_FOUND";
  detail: string | null;
}

export interface ImportSummary {
  totalRows: number;
  imported: number;
  blank: number;
  invalidLabel: number;
  malformedRow: number;
  wrongProject: number;
  notFound: number;
  results: ImportRowResult[];
}

export interface CreateBaselineInput {
  seed: string;
  duplicateSize: number;
  clarificationSize: number;
  proposalReadySize: number;
  sourceName?: string;
  /**
   * Phase 4B.4 — ties the baseline to ONE specific bulk analysis run (`BulkJobRecord.id`), so a "corrected, repository-aware"
   * run can never be silently mixed with an earlier (e.g. text-only) one over the same items. When given, every sample is
   * restricted to that run's own member items; a member the run itself marked FAILED/SKIPPED is reported as an
   * `infrastructureFailure`, never as a duplicate/clarification/proposal-ready candidate. When given and the run produced
   * real analyses, `repositoryRevisions` must be non-empty — an empty result is reported as a discrepancy, never silently
   * accepted as "no revision" (Objective 14/15).
   */
  runId?: string;
}

export interface InfrastructureFailure {
  itemId: string;
  ref: string | null;
  title: string | null;
  failureCategory: string | null;
  failureReason: string | null;
}

export class BacklogAdjudicationService {
  constructor(private readonly d: AdjudicationDeps) {}

  // ===========================================================================
  // Deterministic sampling
  // ===========================================================================

  /** The successfully-analyzed member item ids of a bulk run, and its failed/skipped members reported as infrastructure failures — never as review candidates (Objective 2). `null` runId means "no run scoping" (the pre-4B.4 behavior). */
  private runScope(projectId: string, actorId: string, runId: string | undefined): { memberIds: Set<string> | null; infrastructureFailures: InfrastructureFailure[] } {
    if (!runId) return { memberIds: null, infrastructureFailures: [] };
    const view = this.d.bulk.getBulk(runId, actorId);
    if (view.job.projectId !== projectId) throw new InvalidRequestError("This run does not belong to the given project.");
    const memberIds = new Set(view.members.filter((m) => m.jobStatus === "SUCCEEDED").map((m) => m.backlogItemId));
    const infrastructureFailures: InfrastructureFailure[] = view.members
      .filter((m) => m.disposition === "SKIPPED" || m.jobStatus === "FAILED" || m.jobStatus === "CANCELLED")
      .map((m) => {
        const item = this.d.items.findById(m.backlogItemId);
        const analysis = this.d.analyses.findLatestForItem(m.backlogItemId);
        return { itemId: m.backlogItemId, ref: item?.externalRef ?? null, title: item?.title ?? null, failureCategory: analysis?.status === "failed" ? analysis.failureCategory : null, failureReason: (analysis?.status === "failed" ? analysis.failureReason : null) ?? m.reason };
      });
    return { memberIds, infrastructureFailures };
  }

  sampleDuplicateGroups(projectId: string, actorId: string, seed: string, size: number, runId?: string): { seed: string; size: number; totalGroups: number; groups: SampledGroup[]; infrastructureFailures: InfrastructureFailure[] } {
    assertProjectAccess(this.d.projects, projectId, actorId);
    const { memberIds, infrastructureFailures } = this.runScope(projectId, actorId, runId);
    const { duplicateGroups: allGroups } = this.d.bulk.groups(projectId, actorId);
    const duplicateGroups = memberIds ? allGroups.filter((g) => g.items.every((i) => memberIds.has(i.id))) : allGroups;
    const withKey = duplicateGroups.map((g) => ({ ...g, groupKey: [...g.items.map((i) => i.id)].sort().join(",") }));
    const sampled = deterministicSample(withKey, seed, Math.min(size, MAX_SAMPLE_SIZE), (g) => g.groupKey);
    const groups: SampledGroup[] = sampled.map((g) => ({
      groupKey: g.groupKey,
      items: g.items,
      edges: g.edges.map((e) => {
        const rel = this.d.relationships.findById(e.id)!;
        const current = this.d.judgments.currentRelationshipJudgment(e.id);
        return {
          relationshipId: e.id, fromItemId: e.fromItemId, toItemId: e.toItemId, confidence: e.confidence, status: e.status, rationale: e.rationale,
          analysisId: rel.analysisId, revision: revisionOf(rel.analysisId, this.d.analyses),
          current, history: this.d.judgments.listRelationshipJudgments(e.id),
          stale: current !== null && current.analysisId !== rel.analysisId,
        };
      }),
    }));
    return { seed, size, totalGroups: duplicateGroups.length, groups, infrastructureFailures };
  }

  private sampleItems(projectId: string, actorId: string, seed: string, size: number, filter: (r: ReviewRow) => boolean, category: ReviewJudgmentCategory, runId?: string): { seed: string; size: number; totalCandidates: number; sampled: SampledItem[]; infrastructureFailures: InfrastructureFailure[] } {
    assertProjectAccess(this.d.projects, projectId, actorId);
    const { memberIds, infrastructureFailures } = this.runScope(projectId, actorId, runId);
    const { rows } = this.d.bulk.reviewRows(projectId, { filter: "all" }, actorId);
    const candidates = rows.filter((r) => (memberIds ? memberIds.has(r.itemId) : true) && filter(r));
    const chosen = deterministicSample(candidates, seed, Math.min(size, MAX_SAMPLE_SIZE), (r) => r.itemId);
    const sampled: SampledItem[] = chosen.map((row) => {
      const current = this.d.judgments.currentItemJudgment(row.itemId, category);
      const latestAnalysisId = this.d.analyses.findLatestSucceededForItem(row.itemId)?.id ?? null;
      return { row, current, history: this.d.judgments.listItemJudgments(row.itemId, category), stale: current !== null && current.analysisId !== latestAnalysisId };
    });
    return { seed, size, totalCandidates: candidates.length, sampled, infrastructureFailures };
  }

  sampleClarification(projectId: string, actorId: string, seed: string, size: number, runId?: string) {
    return this.sampleItems(projectId, actorId, seed, size, (r) => r.review.state === "NEEDS_CLARIFICATION" || (r.analysis.state === "SUCCEEDED" && r.status === "NEEDS_CLARIFICATION"), "CLARIFICATION", runId);
  }

  sampleProposalReady(projectId: string, actorId: string, seed: string, size: number, runId?: string) {
    return this.sampleItems(projectId, actorId, seed, size, (r) => r.review.state === "READY_FOR_PROPOSAL", "PROPOSAL_READINESS", runId);
  }

  // ===========================================================================
  // Judging (append-only; AI state is never touched)
  // ===========================================================================

  /** Edge-level: judging A↔B never asserts anything about a different edge in the same group (Objective 11) — callers judge each edge they were shown. */
  judgeRelationship(relationshipId: string, actorId: string, label: RelationshipJudgmentRecord["label"], note: string | undefined): RelationshipJudgmentRecord {
    const rel = this.d.relationships.findById(relationshipId);
    if (!rel) throw new NotFoundError("BacklogItem", relationshipId);
    assertProjectAccess(this.d.projects, rel.projectId, actorId);
    if (note !== undefined && note.length > MAX_NOTE) throw new InvalidRequestError(`note must be at most ${MAX_NOTE} characters`);
    const record: RelationshipJudgmentRecord = {
      id: randomUUID(), relationshipId: rel.id, projectId: rel.projectId, fromItemId: rel.fromItemId, toItemId: rel.toItemId,
      analysisId: rel.analysisId, revision: revisionOf(rel.analysisId, this.d.analyses), aiConfidence: rel.confidence, label,
      reviewerId: actorId, note: note?.trim() || null, createdAt: now(),
    };
    this.d.judgments.insertRelationshipJudgment(record);
    return record;
  }

  judgeItem(itemId: string, actorId: string, category: ReviewJudgmentCategory, label: string, note: string | undefined): ItemJudgmentRecord {
    if (!labelsFor(category).includes(label)) throw new InvalidRequestError(`"${label}" is not a valid label for ${category}`);
    if (note !== undefined && note.length > MAX_NOTE) throw new InvalidRequestError(`note must be at most ${MAX_NOTE} characters`);
    const row = this.d.bulk.reviewRowFor(itemId, actorId); // owner-checked; also the current AI state we bind against
    const analysis = this.d.analyses.findLatestSucceededForItem(itemId);
    if (!analysis) throw new InvalidOperationError("This item has no successful analysis to judge yet.");
    const record: ItemJudgmentRecord = {
      id: randomUUID(), projectId: analysis.projectId, backlogItemId: itemId, analysisId: analysis.id, revision: revisionOf(analysis.id, this.d.analyses),
      category, aiReviewState: row.review.state, label: label as ClarificationLabel | ProposalReadinessLabel, reviewerId: actorId, note: note?.trim() || null, createdAt: now(),
    };
    this.d.judgments.insertItemJudgment(record);
    return record;
  }

  /**
   * The live relationship may be GONE (a later re-analysis dropped it — see migration 021's own note) while its judgment
   * history remains valid: every judgment denormalizes `projectId`, so ownership is still checkable without the live row.
   */
  listRelationshipJudgments(relationshipId: string, actorId: string): RelationshipJudgmentRecord[] {
    const rel = this.d.relationships.findById(relationshipId);
    const history = this.d.judgments.listRelationshipJudgments(relationshipId);
    const projectId = rel?.projectId ?? history[0]?.projectId;
    if (!projectId) throw new NotFoundError("BacklogItem", relationshipId);
    assertProjectAccess(this.d.projects, projectId, actorId);
    return history;
  }

  listItemJudgments(itemId: string, actorId: string, category: ReviewJudgmentCategory): ItemJudgmentRecord[] {
    this.d.bulk.reviewRowFor(itemId, actorId); // owner check
    return this.d.judgments.listItemJudgments(itemId, category);
  }

  // ===========================================================================
  // Human-filled CSV import (Objective 16). The AI/context columns in the template are read-only reference; the SERVER
  // resolves every target and its current project/analysis/revision itself — nothing here trusts the file for identity.
  // ===========================================================================

  importCsv(projectId: string, actorId: string, csv: string): ImportSummary {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const { rows, errors } = parseAdjudicationImport(csv, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS);
    if (errors.length > 0) throw new InvalidRequestError(errors.join(" "));

    const results: ImportRowResult[] = [];
    let imported = 0, blank = 0, invalidLabel = 0, malformedRow = 0, wrongProject = 0, notFound = 0;
    for (const row of rows) {
      if (row.outcome === "BLANK") { blank++; results.push({ rowNumber: row.rowNumber, outcome: "BLANK", detail: row.detail }); continue; }
      if (row.outcome === "INVALID_LABEL") { invalidLabel++; results.push({ rowNumber: row.rowNumber, outcome: "INVALID_LABEL", detail: row.detail }); continue; }
      if (row.outcome === "MALFORMED_ROW" || row.outcome === "UNKNOWN_KIND") { malformedRow++; results.push({ rowNumber: row.rowNumber, outcome: row.outcome, detail: row.detail }); continue; }
      try {
        if (row.kind === "relationship") {
          const rel = this.d.relationships.findById(row.targetId!);
          if (!rel) { notFound++; results.push({ rowNumber: row.rowNumber, outcome: "NOT_FOUND", detail: `No such relationship: ${row.targetId}` }); continue; }
          if (rel.projectId !== project.id) { wrongProject++; results.push({ rowNumber: row.rowNumber, outcome: "WRONG_PROJECT", detail: "This relationship belongs to a different project." }); continue; }
          this.judgeRelationship(rel.id, actorId, row.label as RelationshipJudgmentRecord["label"], row.note ?? undefined);
        } else {
          const item = this.d.items.findById(row.targetId!);
          if (!item) { notFound++; results.push({ rowNumber: row.rowNumber, outcome: "NOT_FOUND", detail: `No such backlog item: ${row.targetId}` }); continue; }
          if (item.projectId !== project.id) { wrongProject++; results.push({ rowNumber: row.rowNumber, outcome: "WRONG_PROJECT", detail: "This backlog item belongs to a different project." }); continue; }
          this.judgeItem(item.id, actorId, row.category!, row.label!, row.note ?? undefined);
        }
        imported++;
        results.push({ rowNumber: row.rowNumber, outcome: "IMPORTED", detail: null });
      } catch (err) {
        // A domain refusal (e.g. "no successful analysis yet") is reported per-row — it never fails the whole import.
        malformedRow++;
        results.push({ rowNumber: row.rowNumber, outcome: "MALFORMED_ROW", detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return { totalRows: rows.length, imported, blank, invalidLabel, malformedRow, wrongProject, notFound, results };
  }

  // ===========================================================================
  // Baseline freeze (Objectives 8, 14, 15). Immutable: every call INSERTS a new versioned row; nothing already written is
  // ever recomputed or edited. Metrics are computed against the SAMPLE this call freezes, not the live project-wide state,
  // so a baseline reads the same forever regardless of what is judged or re-analysed afterwards.
  // ===========================================================================

  createBaseline(projectId: string, actorId: string, input: CreateBaselineInput): BaselineRecord {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    // Validate the run BEFORE sampling anything, so a forged/foreign/cross-project run id is refused up front (Objective 17).
    if (input.runId) this.d.bulk.getBulk(input.runId, actorId);
    const dup = this.sampleDuplicateGroups(projectId, actorId, input.seed, input.duplicateSize, input.runId);
    const clar = this.sampleClarification(projectId, actorId, input.seed, input.clarificationSize, input.runId);
    const prop = this.sampleProposalReady(projectId, actorId, input.seed, input.proposalReadySize, input.runId);
    const infrastructureFailures = [...new Map([...dup.infrastructureFailures, ...clar.infrastructureFailures, ...prop.infrastructureFailures].map((f) => [f.itemId, f])).values()];

    const dupEdges = dup.groups.flatMap((g) => g.edges);
    const revisions = new Set<string>();
    for (const e of dupEdges) if (e.revision) revisions.add(e.revision);
    const models = new Set<string>();
    const analysisSummary = (analysisId: string) => {
      const a = this.d.analyses.findById(analysisId);
      if (a?.status === "succeeded") {
        const rev = a.platformChecks?.assessment?.reconciliation?.revision;
        if (rev) revisions.add(rev);
        models.add(a.modelId || a.providerId ? `${a.providerId ?? "?"}/${a.modelId ?? "?"}` : a.engineKey ?? "?");
      }
    };
    for (const e of dupEdges) analysisSummary(e.analysisId);
    for (const s of [...clar.sampled, ...prop.sampled]) {
      const latest = this.d.analyses.findLatestSucceededForItem(s.row.itemId);
      if (latest) analysisSummary(latest.id);
    }

    const dist = <T extends string>(recs: Array<{ label: T } | null>, labels: readonly T[]): Record<string, number> => Object.fromEntries(labels.map((l) => [l, recs.filter((r) => r?.label === l).length]));
    // "Reviewed" = a VALID (non-stale) current judgment. A stale one (the target moved on since it was judged) is reported
    // separately and never counted toward reviewed/label-distribution/confirmation-rate (Objective 4).
    const dupValidCurrent = dupEdges.map((e) => (e.current && !e.stale ? e.current : null));
    const dupStaleCount = dupEdges.filter((e) => e.current !== null && e.stale).length;
    const dupReviewed = dupValidCurrent.filter((c) => c !== null).length;
    const dupConfirmed = dupValidCurrent.filter((c) => c?.label === "CONFIRMED_DUPLICATE").length;
    const clarValidCurrent = clar.sampled.map((s) => (s.current && !s.stale ? s.current : null));
    const clarStaleCount = clar.sampled.filter((s) => s.current !== null && s.stale).length;
    const clarReviewed = clarValidCurrent.filter((c) => c !== null).length;
    const propValidCurrent = prop.sampled.map((s) => (s.current && !s.stale ? s.current : null));
    const propStaleCount = prop.sampled.filter((s) => s.current !== null && s.stale).length;
    const propReviewed = propValidCurrent.filter((c) => c !== null).length;
    const totalLabels = dupReviewed + clarReviewed + propReviewed;
    const totalStale = dupStaleCount + clarStaleCount + propStaleCount;
    const analysisIds = [...new Set([...dupEdges.map((e) => e.analysisId), ...[...clar.sampled, ...prop.sampled].map((s) => this.d.analyses.findLatestSucceededForItem(s.row.itemId)?.id).filter((x): x is string => !!x)])].sort();

    const metrics = {
      duplicates: {
        candidateGroups: dup.totalGroups, sampledGroups: dup.groups.length, sampledEdges: dupEdges.length, reviewedEdges: dupReviewed,
        unreviewedEdges: dupEdges.length - dupReviewed - dupStaleCount, staleEdges: dupStaleCount,
        labelDistribution: dist(dupValidCurrent, RELATIONSHIP_JUDGMENT_LABELS),
        confirmationRate: dupReviewed > 0 ? dupConfirmed / dupReviewed : null,
        status: dupReviewed === 0 ? "NOT_REVIEWED" : dupReviewed < dupEdges.length ? "IN_PROGRESS" : "REVIEWED",
      },
      clarification: {
        candidateCount: clar.totalCandidates, sampledCount: clar.sampled.length, reviewedCount: clarReviewed,
        unreviewedCount: clar.sampled.length - clarReviewed - clarStaleCount, staleCount: clarStaleCount,
        labelDistribution: dist(clarValidCurrent, CLARIFICATION_LABELS),
        status: clarReviewed === 0 ? "NOT_REVIEWED" : clarReviewed < clar.sampled.length ? "IN_PROGRESS" : "REVIEWED",
      },
      proposalReadiness: {
        candidateCount: prop.totalCandidates, sampledCount: prop.sampled.length, reviewedCount: propReviewed,
        unreviewedCount: prop.sampled.length - propReviewed - propStaleCount, staleCount: propStaleCount,
        labelDistribution: dist(propValidCurrent, PROPOSAL_READINESS_LABELS),
        status: propReviewed === 0 ? "NOT_REVIEWED" : propReviewed < prop.sampled.length ? "IN_PROGRESS" : "REVIEWED",
      },
      coverage: {
        labelsCollected: totalLabels,
        staleLabels: totalStale,
        sampledTotal: dupEdges.length + clar.sampled.length + prop.sampled.length,
        notYetReviewed: dupEdges.length - dupReviewed - dupStaleCount + (clar.sampled.length - clarReviewed - clarStaleCount) + (prop.sampled.length - propReviewed - propStaleCount),
      },
      limitations: [
        "Sample sizes are small (see denominators above) — nothing here implies statistical significance.",
        "This project's MVP access model has exactly one authorized owner; every judgment recorded so far comes from that one identity, so no inter-rater agreement can be computed.",
        "No task execution or bug-fix outcome was checked — this measures classification/review usefulness only, never whether a bug was actually fixed.",
        "These metrics describe THIS sample of THIS backlog at THIS revision; they do not generalize to other backlogs or later re-analyses.",
      ],
    };

    const sampledTotal = dupEdges.length + clar.sampled.length + prop.sampled.length;
    // Objective 14/15: a run explicitly identified as THE experiment (runId given) that produced a non-empty sample must show
    // a real repository revision. An empty result here is never silently accepted as "no revision" — it means repository
    // access did not actually happen for this run (see the Phase 4B.3 root cause), and that must stop the freeze, not be faked.
    if (input.runId && sampledTotal > 0 && revisions.size === 0) {
      throw new InvalidOperationError(
        "Repository revision discrepancy: this run's sampled items recorded NO repository revision. This run cannot be frozen as a repository-aware baseline — verify the run actually had repository access before retrying.",
      );
    }

    const record: BaselineRecord = {
      id: randomUUID(),
      projectId: project.id,
      version: this.d.baselines.nextVersion(project.id),
      seed: input.seed,
      sourceName: input.sourceName ?? null,
      repositoryRevisions: [...revisions].sort(),
      models: [...models].sort(),
      sample: {
        runId: input.runId ?? null,
        duplicateGroups: dup.groups.map((g) => ({ groupKey: g.groupKey, edgeIds: g.edges.map((e) => e.relationshipId) })),
        clarificationItemIds: clar.sampled.map((s) => s.row.itemId),
        proposalReadyItemIds: prop.sampled.map((s) => s.row.itemId),
        analysisIds,
        infrastructureFailures,
        requestedSampleSizes: { duplicateSize: input.duplicateSize, clarificationSize: input.clarificationSize, proposalReadySize: input.proposalReadySize },
        actualSampleSizes: { duplicateGroups: dup.groups.length, duplicateEdges: dupEdges.length, clarificationItems: clar.sampled.length, proposalReadyItems: prop.sampled.length },
      },
      metrics,
      established: totalLabels > 0,
      createdBy: actorId,
      createdAt: now(),
    };
    this.d.baselines.insert(record);
    return record;
  }

  getBaseline(baselineId: string, actorId: string): BaselineRecord {
    const b = this.d.baselines.findById(baselineId);
    if (!b) throw new NotFoundError("BacklogItem", baselineId);
    assertProjectAccess(this.d.projects, b.projectId, actorId);
    return b;
  }

  listBaselines(projectId: string, actorId: string): BaselineRecord[] {
    assertProjectAccess(this.d.projects, projectId, actorId);
    return this.d.baselines.listForProject(projectId);
  }

  // ===========================================================================
  // Descriptive metrics (never an overall "quality score")
  // ===========================================================================

  /** True once a judgment's own `analysisId` no longer matches the target's LIVE current analysis — a re-analysis (or, for a
   *  relationship, a re-proposal) moved on. A stale judgment stays in history forever; it is simply excluded from "reviewed"
   *  counts (Objective 4) and reported separately. */
  private relationshipStale(j: RelationshipJudgmentRecord): boolean {
    return this.d.relationships.findById(j.relationshipId)?.analysisId !== j.analysisId;
  }
  private itemStale(j: ItemJudgmentRecord): boolean {
    return (this.d.analyses.findLatestSucceededForItem(j.backlogItemId)?.id ?? null) !== j.analysisId;
  }

  metrics(projectId: string, actorId: string) {
    assertProjectAccess(this.d.projects, projectId, actorId);
    const cur = this.d.judgments.allCurrentForProject(projectId);
    const { duplicateGroups } = this.d.bulk.groups(projectId, actorId);
    const judgedRelIds = new Set(cur.relationships.map((r) => r.relationshipId));
    const groupsReviewed = duplicateGroups.filter((g) => g.edges.some((e) => judgedRelIds.has(e.id))).length;
    const countLabel = <T extends string>(recs: Array<{ label: T }>, label: T) => recs.filter((r) => r.label === label).length;

    const relValid = cur.relationships.filter((r) => !this.relationshipStale(r));
    const relStale = cur.relationships.length - relValid.length;
    const relReviewed = relValid.length;
    const confirmed = countLabel(relValid, "CONFIRMED_DUPLICATE");

    const clarValid = cur.clarification.filter((r) => !this.itemStale(r));
    const clarStale = cur.clarification.length - clarValid.length;
    const propValid = cur.proposalReadiness.filter((r) => !this.itemStale(r));
    const propStale = cur.proposalReadiness.length - propValid.length;

    return {
      duplicates: {
        groupsReviewed, totalGroups: duplicateGroups.length, relationshipsReviewed: relReviewed, staleRelationships: relStale,
        confirmedDuplicate: confirmed, relatedNotDuplicate: countLabel(relValid, "RELATED_NOT_DUPLICATE"), rejected: countLabel(relValid, "REJECTED"),
        confirmationRate: relReviewed > 0 ? confirmed / relReviewed : null,
      },
      clarification: {
        reviewed: clarValid.length, stale: clarStale,
        correctClarification: countLabel(clarValid, "CORRECT_CLARIFICATION"),
        shouldBeProposalReady: countLabel(clarValid, "SHOULD_BE_PROPOSAL_READY"),
        insufficientAnalysis: countLabel(clarValid, "INSUFFICIENT_ANALYSIS"),
        other: countLabel(clarValid, "OTHER"),
      },
      proposalReadiness: {
        reviewed: propValid.length, stale: propStale,
        correctProposalReady: countLabel(propValid, "CORRECT_PROPOSAL_READY"),
        needsClarification: countLabel(propValid, "NEEDS_CLARIFICATION"),
        insufficientAnalysis: countLabel(propValid, "INSUFFICIENT_ANALYSIS"),
        other: countLabel(propValid, "OTHER"),
      },
    };
  }

  // ===========================================================================
  // Baseline gate (Objective 1) — the mandatory checkpoint before ANY tuning work. Counts are VALID (non-stale) current
  // judgments only; stale ones are reported separately and never count toward permission to tune.
  // ===========================================================================

  labelCounts(projectId: string, actorId: string): { duplicateLabelCount: number; clarificationLabelCount: number; proposalReadinessLabelCount: number; validLabelCount: number; staleLabelCount: number; humanLabelCount: number } {
    assertProjectAccess(this.d.projects, projectId, actorId);
    const cur = this.d.judgments.allCurrentForProject(projectId);
    const relStale = cur.relationships.filter((r) => this.relationshipStale(r)).length;
    const clarStale = cur.clarification.filter((r) => this.itemStale(r)).length;
    const propStale = cur.proposalReadiness.filter((r) => this.itemStale(r)).length;
    const duplicateLabelCount = cur.relationships.length - relStale;
    const clarificationLabelCount = cur.clarification.length - clarStale;
    const proposalReadinessLabelCount = cur.proposalReadiness.length - propStale;
    const staleLabelCount = relStale + clarStale + propStale;
    const validLabelCount = duplicateLabelCount + clarificationLabelCount + proposalReadinessLabelCount;
    return { duplicateLabelCount, clarificationLabelCount, proposalReadinessLabelCount, validLabelCount, staleLabelCount, humanLabelCount: validLabelCount + staleLabelCount };
  }

  /**
   * The mandatory gate (Objective 1/7): throws with the exact required message when no VALID human label exists anywhere in
   * the project. Any future tuning entry point MUST call this before evaluating or changing anything model/retrieval-side.
   */
  assertTuningPermitted(projectId: string, actorId: string): ReturnType<BacklogAdjudicationService["labelCounts"]> {
    const counts = this.labelCounts(projectId, actorId);
    if (counts.validLabelCount === 0) throw new InvalidOperationError("BASELINE NOT ESTABLISHED — HUMAN LABELS REQUIRED.");
    return counts;
  }

  // ===========================================================================
  // Export
  // ===========================================================================

  exportCsv(projectId: string, actorId: string): string {
    assertProjectAccess(this.d.projects, projectId, actorId);
    const cur = this.d.judgments.allCurrentForProject(projectId);
    const ref = (id: string) => this.d.items.findById(id);
    const head = ["kind", "projectId", "backlogItemId", "toItemId", "sourceBugIdA", "sourceBugIdB", "analysisId", "repositoryRevision", "aiClassification", "aiConfidenceOrState", "humanLabel", "reviewerId", "createdAt", "note"];
    const rows: string[][] = [];
    for (const j of cur.relationships) {
      const a = ref(j.fromItemId);
      const b = ref(j.toItemId);
      rows.push(["relationship", j.projectId, j.fromItemId, j.toItemId, a?.metadata?.bugId ?? a?.externalRef ?? "", b?.metadata?.bugId ?? b?.externalRef ?? "", j.analysisId, j.revision ?? "", "POSSIBLE_DUPLICATE", j.aiConfidence, j.label, j.reviewerId, j.createdAt, j.note ?? ""]);
    }
    for (const j of [...cur.clarification, ...cur.proposalReadiness]) {
      const it = ref(j.backlogItemId);
      rows.push(["item", j.projectId, j.backlogItemId, "", it?.metadata?.bugId ?? it?.externalRef ?? "", "", j.analysisId, j.revision ?? "", j.aiReviewState ?? "", "", j.label, j.reviewerId, j.createdAt, j.note ?? ""]);
    }
    return [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  }
}

export { CLARIFICATION_LABELS, PROPOSAL_READINESS_LABELS };
