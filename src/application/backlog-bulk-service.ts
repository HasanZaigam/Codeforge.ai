import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Project } from "../domain/types.js";
import type { BacklogAnalysis, BacklogAnalysisJob, BacklogItem, BacklogRelationship, ReviewSummary, TaskProposal } from "../backlog/backlog-types.js";
import { buildPreview, externalRefFor, sourceSlug, type CanonicalField, type ImportPreview } from "../backlog/import-csv.js";
import { deriveReview, withVerification } from "../backlog/review-state.js";
import { bindClaimsToChecks } from "../backlog/verification.js";
import { runInTransaction } from "../persistence/transaction.js";
import type { BacklogAnalysisJobRepository } from "../persistence/repositories/backlog-analysis-job-repository.js";
import type { BacklogAnalysisRepository } from "../persistence/repositories/backlog-analysis-repository.js";
import type { BacklogBulkRepository, BacklogImportRecord, BacklogImportRowRecord, BulkJobRecord, BulkMemberRecord } from "../persistence/repositories/backlog-bulk-repository.js";
import type { BacklogEventRepository } from "../persistence/repositories/backlog-event-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { BacklogRelationshipRepository } from "../persistence/repositories/backlog-relationship-repository.js";
import type { ClaimVerificationRepository } from "../persistence/repositories/claim-verification-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { TaskProposalRepository } from "../persistence/repositories/task-proposal-repository.js";
import { assertProjectAccess } from "./authorization.js";
import type { BacklogService } from "./backlog-service.js";
import { InvalidOperationError, NotFoundError, InvalidRequestError } from "./errors.js";

export interface BulkDeps {
  db: DatabaseSync;
  items: BacklogItemRepository;
  analyses: BacklogAnalysisRepository;
  jobs: BacklogAnalysisJobRepository;
  relationships: BacklogRelationshipRepository;
  proposals: TaskProposalRepository;
  events: BacklogEventRepository;
  bulk: BacklogBulkRepository;
  projects: ProjectRepository;
  claimVerifications?: ClaimVerificationRepository;
  backlog: BacklogService;
}

const now = () => new Date().toISOString();
const MAX_BULK_ITEMS = 500;
const MAX_ACTION_ITEMS = 100;
const REVIEW_LIMIT = 500;

export type BulkStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";

export interface BulkCounts {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface BulkView {
  job: BulkJobRecord;
  status: BulkStatus;
  counts: BulkCounts;
  members: Array<BulkMemberRecord & { ref: string | null; title: string | null; jobStatus: string | null }>;
}

export type ReviewFilter = "all" | "needs_analysis" | "analysis_ready" | "possibly_implemented" | "needs_clarification" | "duplicate" | "dependency" | "ready_for_proposal" | "verified" | "unverified" | "failed";
export const REVIEW_FILTERS: ReviewFilter[] = ["all", "needs_analysis", "analysis_ready", "possibly_implemented", "needs_clarification", "duplicate", "dependency", "ready_for_proposal", "verified", "unverified", "failed"];

export interface ReviewRow {
  itemId: string;
  ref: string | null;
  title: string;
  status: BacklogItem["status"];
  importId: string | null;
  sourceRow: number | null;
  module: string | null;
  priority: string | null;
  analysis: { state: "NONE" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"; failureCategory: string | null; failureReason: string | null; completedAt: string | null };
  review: ReviewSummary;
  /** The three facts kept apart: mechanism/implementation, flow, behaviour. */
  flow: "FLOW_REFERENCE_PRESENT" | "FLOW_NOT_ESTABLISHED" | "ENTRY_POINT_NOT_LOCATED" | null;
  evidenceCount: number;
  verification: { checksAvailable: number; sufficientChecks: number; verified: boolean };
  duplicates: { proposed: number; confirmed: number };
  dependencies: { proposed: number; confirmed: number };
  proposal: { id: string; status: TaskProposal["status"]; taskId: string | null } | null;
  usage: { inputTokens: number | null; outputTokens: number | null; estimatedCost: { amount: number; currency: string; pricingSource: string } | null; status: "reported" | "partial" | "unavailable" };
  durationMs: number | null;
}

export interface UsageAggregate {
  analyses: number;
  withReportedUsage: number;
  unavailable: number;
  partial: number;
  inputTokens: number;
  outputTokens: number;
  /** Provider/engine-reported estimates, per currency. Never CodeForge-calculated; unavailable is never counted as 0. */
  estimatedCost: Array<{ currency: string; amount: number; analysesWithEstimate: number; pricingSources: string[] }>;
}

export interface BulkAction {
  action: "generate_proposals" | "approve_proposals" | "reject_proposals" | "convert_proposals" | "dismiss_duplicates";
  itemIds: string[];
}

export interface ActionResult {
  itemId: string;
  ok: boolean;
  detail: string | null;
  taskId?: string | null;
}

export class BacklogBulkService {
  constructor(private readonly d: BulkDeps) {}

  // ===========================================================================
  // Import (deterministic; no model, no repository)
  // ===========================================================================

  /** Stateless preview: what a confirmed import WOULD do. Writes nothing. */
  preview(projectId: string, csv: string, opts: { sourceName: string; mapping?: Partial<Record<CanonicalField, string>> }, actorId: string): ImportPreview & { alreadyImported: number; rowsAlreadyImported: number[] } {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const preview = buildPreview(csv, { mapping: opts.mapping });
    const existing: number[] = [];
    for (const r of preview.rows) {
      if (r.status !== "ACCEPTED" || !r.sourceKey) continue;
      if (this.d.items.findByProjectAndRef(project.id, externalRefFor(opts.sourceName, r.sourceKey))) existing.push(r.rowNumber);
    }
    return { ...preview, alreadyImported: existing.length, rowsAlreadyImported: existing };
  }

  /**
   * Confirms an import. The server re-parses the CSV itself (a client-supplied preview is never trusted), then in ONE transaction records
   * the import, every row's outcome and one BacklogItem per newly accepted row. A source row already imported (same source name + bug id)
   * is linked, not duplicated — and never modified. Nothing is analysed: the user starts analysis explicitly.
   */
  confirmImport(projectId: string, csv: string, opts: { sourceName: string; mapping?: Partial<Record<CanonicalField, string>> }, actorId: string): { import: BacklogImportRecord; rows: BacklogImportRowRecord[] } {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const sourceName = opts.sourceName.trim();
    if (sourceName === "" || sourceName.length > 100) throw new InvalidRequestError("sourceName must be 1–100 characters");
    const preview = buildPreview(csv, { mapping: opts.mapping });
    if (preview.errors.length > 0) throw new InvalidRequestError(preview.errors.join(" "));
    if (preview.accepted === 0 && preview.rejected === 0) throw new InvalidRequestError("The file contains no data rows.");

    const importId = randomUUID();
    const ts = now();
    const rows: BacklogImportRowRecord[] = [];
    const result = runInTransaction(this.d.db, () => {
      let accepted = 0;
      let already = 0;
      this.d.bulk.insertImport({
        id: importId, projectId: project.id, sourceName, sourceType: "csv", createdBy: actorId, status: "COMPLETED", contentHash: createHash("sha256").update(csv).digest("hex"),
        totalRows: preview.totalRows, acceptedRows: 0, rejectedRows: preview.rejected, alreadyImportedRows: 0, mapping: preview.mapping, warnings: preview.warnings, createdAt: ts, completedAt: ts,
      });
      this.d.bulk.appendOp(project.id, "import", importId, "IMPORT_CREATED", { sourceName, totalRows: preview.totalRows }, ts);
      for (const r of preview.rows) {
        const base = { importId, rowNumber: r.rowNumber, sourceKey: r.sourceKey, warnings: r.warnings };
        if (r.status === "REJECTED") {
          const rec: BacklogImportRowRecord = { ...base, status: "REJECTED", reason: r.reason, detail: r.detail, backlogItemId: null };
          this.d.bulk.insertImportRow(rec);
          rows.push(rec);
          this.d.bulk.appendOp(project.id, "import", importId, "IMPORT_ROW_REJECTED", { rowNumber: r.rowNumber, reason: r.reason }, ts);
          continue;
        }
        const ref = externalRefFor(sourceName, r.sourceKey!);
        const existing = this.d.items.findByProjectAndRef(project.id, ref);
        if (existing) {
          already++;
          const changed = existing.title !== r.title || existing.description !== r.description;
          const rec: BacklogImportRowRecord = { ...base, status: "ALREADY_IMPORTED", reason: null, detail: changed ? "The source row differs from the item imported earlier; the existing item was left unchanged." : null, backlogItemId: existing.id, warnings: r.warnings };
          this.d.bulk.insertImportRow(rec);
          rows.push(rec);
          continue;
        }
        const itemId = randomUUID();
        const metadata: Record<string, string> = { ...r.metadata };
        for (const f of ["severity", "priority", "module", "platform", "environment", "reporter", "status"] as const) if (r.fields[f]) metadata[f] = r.fields[f]!;
        metadata.sourceName = sourceName;
        if (r.bugId) metadata.bugId = r.bugId;
        this.d.items.insert({
          id: itemId, projectId: project.id, externalRef: ref, title: r.title!, description: r.description!, source: "import", status: "NEW", createdBy: actorId, createdAt: ts, updatedAt: ts,
          importId, sourceRow: r.rowNumber, metadata,
        });
        this.d.events.append(project.id, itemId, "BACKLOG_ITEM_IMPORTED", { importId, rowNumber: r.rowNumber, sourceKey: r.sourceKey }, ts);
        const rec: BacklogImportRowRecord = { ...base, status: "ACCEPTED", reason: null, detail: null, backlogItemId: itemId };
        this.d.bulk.insertImportRow(rec);
        rows.push(rec);
        accepted++;
      }
      this.d.db.prepare("UPDATE backlog_imports SET accepted_rows = ?, already_imported_rows = ? WHERE id = ?").run(accepted, already, importId);
      this.d.bulk.appendOp(project.id, "import", importId, "IMPORT_COMPLETED", { accepted, rejected: preview.rejected, alreadyImported: already }, ts);
    });
    void result;
    return { import: this.d.bulk.findImport(importId)!, rows };
  }

  getImport(importId: string, actorId: string): { import: BacklogImportRecord; rows: BacklogImportRowRecord[]; events: ReturnType<BacklogBulkRepository["listOps"]> } {
    const imp = this.d.bulk.findImport(importId);
    if (!imp) throw new NotFoundError("Project", importId);
    assertProjectAccess(this.d.projects, imp.projectId, actorId);
    return { import: imp, rows: this.d.bulk.listImportRows(importId), events: this.d.bulk.listOps("import", importId) };
  }

  listImports(projectId: string, actorId: string): BacklogImportRecord[] {
    assertProjectAccess(this.d.projects, projectId, actorId);
    return this.d.bulk.listImports(projectId);
  }

  getItemsForImport(importId: string, actorId: string): BacklogItem[] {
    const imp = this.d.bulk.findImport(importId);
    if (!imp) throw new InvalidRequestError(`Import not found: ${importId}`);
    assertProjectAccess(this.d.projects, imp.projectId, actorId);
    return this.d.items.listByImport(importId);
  }

  // ===========================================================================
  // Bulk analysis = a durable grouping of the EXISTING per-item analysis jobs
  // ===========================================================================

  /**
   * Enqueues the existing per-item analysis job for each selected item and records the grouping. Nothing runs here: the existing worker
   * claims the jobs under the existing GLOBAL cap, so 60 items are never 60 model calls at once. An item that cannot be analysed now is
   * SKIPPED with the reason; an item that already has a live job REUSES it. One item's problem never affects another.
   */
  startAnalysis(projectId: string, sel: { importId?: string; itemIds?: string[] }, actorId: string): { bulk: BulkView; created: boolean } {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    let itemIds: string[];
    if (sel.importId) {
      const imp = this.d.bulk.findImport(sel.importId);
      if (!imp || imp.projectId !== project.id) throw new NotFoundError("Project", sel.importId);
      itemIds = this.d.bulk.itemIdsForImport(sel.importId);
    } else if (sel.itemIds && sel.itemIds.length > 0) {
      itemIds = [...new Set(sel.itemIds)];
      for (const id of itemIds) {
        const it = this.d.items.findById(id);
        if (!it || it.projectId !== project.id) throw new NotFoundError("BacklogItem", id); // foreign ids are indistinguishable from missing ones
      }
    } else {
      throw new InvalidRequestError("Select an import or at least one item.");
    }
    if (itemIds.length === 0) throw new InvalidOperationError("There are no items to analyze.");
    if (itemIds.length > MAX_BULK_ITEMS) throw new InvalidRequestError(`At most ${MAX_BULK_ITEMS} items per bulk analysis.`);

    // Duplicate start request: an identical, still-live bulk analysis is returned instead of creating a second.
    const signature = [...itemIds].sort().join(",");
    for (const existing of this.d.bulk.listBulk(project.id)) {
      const view = this.view(existing);
      if ((view.status === "QUEUED" || view.status === "RUNNING") && [...this.d.bulk.members(existing.id).map((m) => m.backlogItemId)].sort().join(",") === signature) return { bulk: view, created: false };
    }

    const bulkId = randomUUID();
    const ts = now();
    this.d.bulk.insertBulkJob({ id: bulkId, projectId: project.id, requestedBy: actorId, importId: sel.importId ?? null, totalItems: itemIds.length, cancelRequestedAt: null, createdAt: ts, updatedAt: ts });
    for (const itemId of itemIds) {
      if (this.d.bulk.findBulk(bulkId)!.cancelRequestedAt) {
        this.d.bulk.insertMember({ bulkJobId: bulkId, backlogItemId: itemId, analysisJobId: null, disposition: "SKIPPED", reason: "The bulk analysis was cancelled before this item started." });
        continue;
      }
      try {
        const { job, enqueued } = this.d.backlog.requestAnalysis(itemId, actorId);
        this.d.bulk.insertMember({ bulkJobId: bulkId, backlogItemId: itemId, analysisJobId: job.id, disposition: enqueued ? "QUEUED" : "REUSED", reason: null });
      } catch (err) {
        this.d.bulk.insertMember({ bulkJobId: bulkId, backlogItemId: itemId, analysisJobId: null, disposition: "SKIPPED", reason: err instanceof Error ? err.message.slice(0, 300) : "not analyzable" });
      }
    }
    const view = this.view(this.d.bulk.findBulk(bulkId)!);
    this.d.bulk.appendOp(project.id, "bulk_analysis", bulkId, "BULK_ANALYSIS_QUEUED", { total: itemIds.length, queued: view.members.filter((m) => m.disposition === "QUEUED").length, reused: view.members.filter((m) => m.disposition === "REUSED").length, skipped: view.counts.skipped }, ts);
    return { bulk: view, created: true };
  }

  getBulk(bulkId: string, actorId: string): BulkView {
    const job = this.d.bulk.findBulk(bulkId);
    if (!job) throw new NotFoundError("Project", bulkId);
    assertProjectAccess(this.d.projects, job.projectId, actorId);
    return this.view(job);
  }

  listBulk(projectId: string, actorId: string): BulkView[] {
    assertProjectAccess(this.d.projects, projectId, actorId);
    return this.d.bulk.listBulk(projectId).map((j) => this.view(j));
  }

  /**
   * Cancels: queued analyses of THIS bulk job stop at once, running ones stop at the worker's next heartbeat (existing semantics), completed
   * analyses are untouched, and a live job this bulk job merely REUSED (someone else's request) is left alone.
   */
  cancelBulk(bulkId: string, actorId: string): BulkView {
    const job = this.d.bulk.findBulk(bulkId);
    if (!job) throw new NotFoundError("Project", bulkId);
    assertProjectAccess(this.d.projects, job.projectId, actorId);
    const ts = now();
    this.d.bulk.requestCancel(bulkId, ts);
    let cancelled = 0;
    for (const m of this.d.bulk.members(bulkId)) {
      if (m.disposition !== "QUEUED" || !m.analysisJobId) continue;
      const aj = this.d.jobs.findById(m.analysisJobId);
      if (!aj || (aj.status !== "QUEUED" && aj.status !== "RUNNING")) continue;
      try {
        this.d.backlog.cancelAnalysis(m.backlogItemId, actorId);
        cancelled++;
      } catch {
        // finished between the check and the cancel — the completed result stands
      }
    }
    this.d.bulk.appendOp(job.projectId, "bulk_analysis", bulkId, "BULK_ANALYSIS_CANCELLED", { cancelRequested: cancelled }, ts);
    return this.view(this.d.bulk.findBulk(bulkId)!);
  }

  private view(job: BulkJobRecord): BulkView {
    const members = this.d.bulk.members(job.id).map((m) => {
      const aj = m.analysisJobId ? this.d.jobs.findById(m.analysisJobId) : null;
      const item = this.d.items.findById(m.backlogItemId);
      return { ...m, ref: item?.externalRef ?? null, title: item?.title ?? null, jobStatus: aj?.status ?? null };
    });
    const counts: BulkCounts = { total: job.totalItems, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
    for (const m of members) {
      if (m.disposition === "SKIPPED") counts.skipped++;
      else if (m.jobStatus === "QUEUED") counts.queued++;
      else if (m.jobStatus === "RUNNING") counts.running++;
      else if (m.jobStatus === "SUCCEEDED") counts.completed++;
      else if (m.jobStatus === "FAILED") counts.failed++;
      else if (m.jobStatus === "CANCELLED") counts.cancelled++;
    }
    const live = counts.queued + counts.running;
    let status: BulkStatus;
    if (live > 0) status = counts.running === 0 && counts.completed + counts.failed + counts.cancelled === 0 ? "QUEUED" : "RUNNING";
    else if (job.cancelRequestedAt) status = "CANCELLED";
    else if (counts.failed === 0 && counts.cancelled === 0 && counts.completed > 0) status = "COMPLETED";
    else if (counts.completed === 0 && counts.failed > 0) status = "FAILED";
    else status = "PARTIAL";
    return { job, status, counts, members };
  }

  // ===========================================================================
  // Bulk review
  // ===========================================================================

  private readable(analysis: BacklogAnalysis | null, project: Project): BacklogAnalysis | null {
    if (!analysis || !this.d.claimVerifications) return analysis;
    return withVerification(analysis, this.d.claimVerifications.listForAnalysis(analysis.id), project);
  }

  private row(item: BacklogItem, project: Project, rels: BacklogRelationship[]): ReviewRow {
    const latest = this.d.analyses.findLatestForItem(item.id);
    const succeeded = latest?.status === "succeeded" ? latest : this.d.analyses.findLatestSucceededForItem(item.id);
    const readable = this.readable(succeeded, project);
    const job: BacklogAnalysisJob | null = this.d.jobs.findLatestForItem(item.id);
    const review = deriveReview(item, readable);
    const asm = readable?.platformChecks?.assessment;
    const proposal = this.d.proposals.findLatestForItem(item.id);
    const claims = readable?.result?.claims ?? [];
    const checks = project.commands?.claimChecks;
    const sufficient = readable ? bindClaimsToChecks(claims, checks).length : 0;
    const candidates = asm?.verificationCandidates?.length ?? 0;
    const mine = rels.filter((r) => r.fromItemId === item.id || r.toItemId === item.id);
    const count = (kind: BacklogRelationship["kind"], status: BacklogRelationship["status"]) => mine.filter((r) => r.kind === kind && r.status === status).length;
    const state: ReviewRow["analysis"]["state"] =
      job && (job.status === "QUEUED" || job.status === "RUNNING") ? job.status : latest ? (latest.status === "succeeded" ? "SUCCEEDED" : job?.status === "CANCELLED" && latest.completedAt <= (job.completedAt ?? "") ? "CANCELLED" : "FAILED") : job?.status === "CANCELLED" ? "CANCELLED" : job?.status === "FAILED" ? "FAILED" : "NONE";
    const cost = latest?.cost ?? null;
    const anyUsage = cost && (cost.inputTokens !== undefined || cost.outputTokens !== undefined);
    return {
      itemId: item.id,
      ref: item.externalRef,
      title: item.title,
      status: item.status,
      importId: item.importId ?? null,
      sourceRow: item.sourceRow ?? null,
      module: item.metadata?.module ?? null,
      priority: item.metadata?.priority ?? null,
      analysis: { state, failureCategory: latest?.status === "failed" ? latest.failureCategory : job?.status === "FAILED" ? job.failureCategory : null, failureReason: latest?.status === "failed" ? latest.failureReason : job?.status === "FAILED" ? job.failureReason : null, completedAt: latest?.completedAt ?? null },
      review,
      flow: asm?.investigation?.flow?.status ?? null,
      evidenceCount: asm?.evidence.length ?? 0,
      verification: { checksAvailable: candidates, sufficientChecks: sufficient, verified: review.behavior === "CHECK_VERIFIED" },
      duplicates: { proposed: count("POSSIBLE_DUPLICATE", "PROPOSED"), confirmed: count("POSSIBLE_DUPLICATE", "CONFIRMED") },
      dependencies: { proposed: count("DEPENDS_ON", "PROPOSED"), confirmed: count("DEPENDS_ON", "CONFIRMED") },
      proposal: proposal ? { id: proposal.id, status: proposal.status, taskId: proposal.taskId } : null,
      usage: {
        inputTokens: cost?.inputTokens ?? null,
        outputTokens: cost?.outputTokens ?? null,
        estimatedCost: cost?.estimatedCost ? { amount: cost.estimatedCost.amount, currency: cost.estimatedCost.currency, pricingSource: cost.estimatedCost.pricingSource } : null,
        status: !latest || !anyUsage ? "unavailable" : cost?.usageStatus === "partial" ? "partial" : "reported",
      },
      durationMs: latest?.durationMs ?? null,
    };
  }

  static matches(row: ReviewRow, filter: ReviewFilter): boolean {
    switch (filter) {
      case "all": return true;
      case "needs_analysis": return row.analysis.state === "NONE" || row.status === "NEW";
      case "analysis_ready": return row.analysis.state === "SUCCEEDED" && (row.status === "ANALYZED" || row.status === "NEEDS_CLARIFICATION");
      case "possibly_implemented": return row.review.state === "POSSIBLY_ALREADY_IMPLEMENTED" || row.review.state === "VERIFIED_CONFLICT";
      case "needs_clarification": return row.review.state === "NEEDS_CLARIFICATION" || row.status === "NEEDS_CLARIFICATION";
      case "duplicate": return row.duplicates.proposed > 0 || row.duplicates.confirmed > 0;
      case "dependency": return row.dependencies.proposed > 0 || row.dependencies.confirmed > 0;
      case "ready_for_proposal": return row.review.state === "READY_FOR_PROPOSAL";
      case "verified": return row.review.behavior === "CHECK_VERIFIED";
      case "unverified": return row.analysis.state === "SUCCEEDED" && row.review.behavior !== "CHECK_VERIFIED";
      case "failed": return row.analysis.state === "FAILED";
    }
  }

  /** One review row, for the adjudication queue (Phase 4B.1) — same facts as `reviewRows`, for a single item, owner-checked via the item itself. */
  reviewRowFor(itemId: string, actorId: string): ReviewRow {
    const it = this.d.items.findById(itemId);
    if (!it) throw new NotFoundError("BacklogItem", itemId);
    const project = assertProjectAccess(this.d.projects, it.projectId, actorId);
    const rels = this.d.relationships.listOutgoing(it.id).concat(this.d.relationships.listIncoming(it.id));
    return this.row(it, project, rels);
  }

  reviewRows(projectId: string, opts: { filter?: ReviewFilter; importId?: string }, actorId: string): { rows: ReviewRow[]; counts: Record<ReviewFilter, number>; total: number } {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const rels = this.d.relationships.listForProject(project.id);
    let items = this.d.items.listByProject(project.id, REVIEW_LIMIT).reverse();
    if (opts.importId) items = items.filter((i) => i.importId === opts.importId);
    const all = items.map((i) => this.row(i, project, rels));
    const counts = Object.fromEntries(REVIEW_FILTERS.map((f) => [f, all.filter((r) => BacklogBulkService.matches(r, f)).length])) as Record<ReviewFilter, number>;
    const rows = all.filter((r) => BacklogBulkService.matches(r, opts.filter ?? "all"));
    return { rows, counts, total: all.length };
  }

  usageAggregate(rows: ReviewRow[]): UsageAggregate {
    const agg: UsageAggregate = { analyses: 0, withReportedUsage: 0, unavailable: 0, partial: 0, inputTokens: 0, outputTokens: 0, estimatedCost: [] };
    const byCurrency = new Map<string, { amount: number; n: number; sources: Set<string> }>();
    for (const r of rows) {
      if (r.analysis.state === "NONE" || r.analysis.completedAt === null) continue;
      agg.analyses++;
      if (r.usage.status === "unavailable") agg.unavailable++;
      else {
        agg.withReportedUsage++;
        if (r.usage.status === "partial") agg.partial++;
        agg.inputTokens += r.usage.inputTokens ?? 0;
        agg.outputTokens += r.usage.outputTokens ?? 0;
      }
      if (r.usage.estimatedCost) {
        const c = byCurrency.get(r.usage.estimatedCost.currency) ?? { amount: 0, n: 0, sources: new Set<string>() };
        c.amount += r.usage.estimatedCost.amount;
        c.n++;
        c.sources.add(r.usage.estimatedCost.pricingSource);
        byCurrency.set(r.usage.estimatedCost.currency, c);
      }
    }
    agg.estimatedCost = [...byCurrency].map(([currency, c]) => ({ currency, amount: c.amount, analysesWithEstimate: c.n, pricingSources: [...c.sources] }));
    return agg;
  }

  // ===========================================================================
  // Duplicate / dependency review (human decisions; nothing is merged or enforced)
  // ===========================================================================

  groups(projectId: string, actorId: string): { duplicateGroups: Array<{ items: Array<{ id: string; ref: string | null; title: string }>; edges: Array<{ id: string; fromItemId: string; toItemId: string; confidence: string; status: string; rationale: string }> }>; dependencies: Array<{ id: string; from: { id: string; ref: string | null; title: string }; to: { id: string; ref: string | null; title: string }; confidence: string; status: string; rationale: string }> } {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const rels = this.d.relationships.listForProject(project.id).filter((r) => r.status !== "DISMISSED");
    const ref = (id: string) => {
      const it = this.d.items.findById(id);
      return it && it.projectId === project.id ? { id: it.id, ref: it.externalRef, title: it.title } : null;
    };
    // connected components over duplicate edges
    const parent = new Map<string, string>();
    const find = (x: string): string => (parent.get(x) === undefined || parent.get(x) === x ? (parent.set(x, x), x) : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    const dups = rels.filter((r) => r.kind === "POSSIBLE_DUPLICATE");
    for (const r of dups) parent.set(find(r.fromItemId), find(r.toItemId));
    const groups = new Map<string, BacklogRelationship[]>();
    for (const r of dups) groups.set(find(r.fromItemId), [...(groups.get(find(r.fromItemId)) ?? []), r]);
    const duplicateGroups = [...groups.values()].map((edges) => {
      const ids = [...new Set(edges.flatMap((e) => [e.fromItemId, e.toItemId]))];
      return {
        items: ids.map(ref).filter((x): x is NonNullable<ReturnType<typeof ref>> => x !== null),
        edges: edges.map((e) => ({ id: e.id, fromItemId: e.fromItemId, toItemId: e.toItemId, confidence: e.confidence, status: e.status, rationale: e.rationale })),
      };
    });
    const dependencies = rels
      .filter((r) => r.kind === "DEPENDS_ON")
      .flatMap((r) => {
        const from = ref(r.fromItemId);
        const to = ref(r.toItemId);
        return from && to ? [{ id: r.id, from, to, confidence: r.confidence, status: r.status, rationale: r.rationale }] : [];
      });
    return { duplicateGroups, dependencies };
  }

  /** A human confirms or dismisses a duplicate/dependency PROPOSAL. It records the decision only — nothing is merged, deleted, ordered or blocked. */
  reviewRelationship(relationshipId: string, decision: "confirm" | "dismiss", actorId: string): BacklogRelationship {
    const rel = this.d.relationships.findById(relationshipId);
    if (!rel) throw new NotFoundError("BacklogItem", relationshipId);
    assertProjectAccess(this.d.projects, rel.projectId, actorId);
    const ts = now();
    this.d.relationships.setStatus(rel.id, decision === "confirm" ? "CONFIRMED" : "DISMISSED", ts);
    const type = decision === "confirm" ? "RELATIONSHIP_CONFIRMED" : "RELATIONSHIP_DISMISSED";
    for (const itemId of [rel.fromItemId, rel.toItemId]) this.d.events.append(rel.projectId, itemId, type, { relationshipId: rel.id, kind: rel.kind, decidedBy: actorId }, ts);
    return this.d.relationships.findById(rel.id)!;
  }

  // ===========================================================================
  // Low-risk bulk actions (each item independent; none starts anything)
  // ===========================================================================

  async bulkAction(projectId: string, req: BulkAction, actorId: string): Promise<{ results: ActionResult[]; ok: number; failed: number }> {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const ids = [...new Set(req.itemIds)];
    if (ids.length === 0 || ids.length > MAX_ACTION_ITEMS) throw new InvalidRequestError(`Select 1–${MAX_ACTION_ITEMS} items.`);
    const results: ActionResult[] = [];
    for (const itemId of ids) {
      try {
        const item = this.d.items.findById(itemId);
        if (!item || item.projectId !== project.id) throw new NotFoundError("BacklogItem", itemId);
        results.push(await this.applyAction(req.action, item, actorId));
      } catch (err) {
        results.push({ itemId, ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : "failed" });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    this.d.bulk.appendOp(project.id, "bulk_action", randomUUID(), `BULK_${req.action.toUpperCase()}`, { requested: ids.length, ok, failed: results.length - ok, by: actorId }, now());
    return { results, ok, failed: results.length - ok };
  }

  private async applyAction(action: BulkAction["action"], item: BacklogItem, actorId: string): Promise<ActionResult> {
    switch (action) {
      case "generate_proposals": {
        const { created } = this.d.backlog.generateProposal(item.id, actorId);
        return { itemId: item.id, ok: true, detail: created ? "proposal generated" : "proposal already exists" };
      }
      case "approve_proposals": {
        const p = this.d.proposals.findLiveForItem(item.id);
        if (!p) throw new InvalidOperationError("This item has no live proposal.");
        this.d.backlog.approveProposal(p.id, actorId);
        return { itemId: item.id, ok: true, detail: "proposal approved" };
      }
      case "reject_proposals": {
        const p = this.d.proposals.findLiveForItem(item.id);
        if (!p) throw new InvalidOperationError("This item has no live proposal.");
        this.d.backlog.rejectProposal(p.id, actorId);
        return { itemId: item.id, ok: true, detail: "proposal rejected" };
      }
      case "convert_proposals": {
        const p = this.d.proposals.findLiveForItem(item.id);
        if (!p) throw new InvalidOperationError("This item has no live proposal.");
        const { task, alreadyConverted } = await this.d.backlog.convertProposal(p.id, actorId); // the EXISTING TaskService path; creates a BACKLOG task, starts nothing
        return { itemId: item.id, ok: true, detail: alreadyConverted ? "already converted" : "task created (BACKLOG — not started)", taskId: task.id };
      }
      case "dismiss_duplicates": {
        const rels = this.d.relationships.listOutgoing(item.id).filter((r) => r.kind === "POSSIBLE_DUPLICATE" && r.status === "PROPOSED");
        for (const r of rels) this.reviewRelationship(r.id, "dismiss", actorId);
        return { itemId: item.id, ok: true, detail: `${rels.length} duplicate proposal(s) dismissed` };
      }
    }
  }
}

export { sourceSlug };
