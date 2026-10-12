import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Project, Task } from "../domain/types.js";
import type {
  ClaimVerificationRecord,
  ReviewSummary,
  BacklogAnalysis,
  BacklogAnalysisJob,
  BacklogEvent,
  BacklogItem,
  BacklogItemStatus,
  BacklogRelationship,
  TaskProposal,
} from "../backlog/backlog-types.js";
import { buildTaskProposalContent } from "../backlog/task-proposal-builder.js";
import { deriveReview, withVerification } from "../backlog/review-state.js";
import type { ClaimVerificationRepository } from "../persistence/repositories/claim-verification-repository.js";
import { runInTransaction } from "../persistence/transaction.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import { isDuplicateBacklogRefViolation, type BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { BacklogAnalysisRepository } from "../persistence/repositories/backlog-analysis-repository.js";
import type { BacklogRelationshipRepository } from "../persistence/repositories/backlog-relationship-repository.js";
import { isLiveProposalViolation, type TaskProposalRepository } from "../persistence/repositories/task-proposal-repository.js";
import type { BacklogEventRepository } from "../persistence/repositories/backlog-event-repository.js";
import { isActiveJobViolation, type BacklogAnalysisJobRepository } from "../persistence/repositories/backlog-analysis-job-repository.js";
import type { TaskService } from "./task-service.js";
import { assertBacklogItemAccess, assertProjectAccess, assertTaskProposalAccess } from "./authorization.js";
import { ConversionInProgressError, DuplicateBacklogReferenceError, InvalidOperationError } from "./errors.js";
import { resolveRepositoryFor } from "./repository-resolution.js";

export interface CreateBacklogItemInput {
  title: string;
  description: string;
  /** Optional caller-supplied reference (e.g. "BUG-002"). Trimmed; empty means none. */
  externalRef?: string | null;
  /** Which project repository this item concerns (TD-62). Absent: the project's primary repository. */
  repositoryId?: string | null;
}

export interface UpdateBacklogItemInput {
  title?: string;
  description?: string;
  externalRef?: string | null;
  /** Moving the item to another repository is a real change: it resets the item to NEW for re-analysis. */
  repositoryId?: string;
}

export interface BacklogItemSummary {
  item: BacklogItem;
  /** Implementation-vs-behaviour review summary (Phase 4A.5). */
  review: ReviewSummary;
  latestAnalysis: { id: string; status: BacklogAnalysis["status"]; completedAt: string } | null;
  proposal: { id: string; status: TaskProposal["status"]; taskId: string | null } | null;
}

export interface RelationshipView {
  relationship: BacklogRelationship;
  /** `outgoing`: this item's analysis proposed it. `incoming`: another item's analysis proposed it, pointing here. */
  direction: "outgoing" | "incoming";
  other: { id: string; ref: string | null; title: string; status: BacklogItemStatus };
}

export interface BacklogItemDetail {
  item: BacklogItem;
  review: ReviewSummary;
  latestAnalysis: BacklogAnalysis | null;
  /** The most recent analysis job — QUEUED / RUNNING (with attempt + retry info) / finished. `null` if the item was never analyzed. */
  analysisJob: BacklogAnalysisJob | null;
  analysisCount: number;
  relationships: RelationshipView[];
  proposal: TaskProposal | null;
  events: BacklogEvent[];
  /** Recorded executions of approved claim checks for the latest analysis (Phase 4A.5). */
  claimVerifications: ClaimVerificationRecord[];
}

export interface BacklogServiceOptions {
  /**
   * Analysis-JOB tuning, consumed by the worker-side runner (buildPlatform wires them there); the
   * API-side service only uses `analysisMaxAttempts` when it enqueues.
   * `analysisLeaseMs` / `analysisHeartbeatMs`: a running analysis renews its lease on the heartbeat; a
   * crashed worker's job becomes recoverable once the lease lapses.
   */
  analysisLeaseMs?: number;
  analysisHeartbeatMs?: number;
  /** Total attempts a job may make (crash recoveries and retries included). Defaults to `maxInfrastructureRetries + 1`. */
  analysisMaxAttempts?: number;
  /** GLOBAL cap on concurrently running analyses across every worker sharing the database (`MAX_BACKLOG_ANALYSIS_CONCURRENCY`). */
  maxAnalysisConcurrency?: number;
  conversionLeaseMs?: number;
  /** Upper bound on items returned by listItems. */
  listLimit?: number;
}

export interface BacklogServiceDeps {
  db: DatabaseSync;
  items: BacklogItemRepository;
  analyses: BacklogAnalysisRepository;
  relationships: BacklogRelationshipRepository;
  proposals: TaskProposalRepository;
  events: BacklogEventRepository;
  jobs: BacklogAnalysisJobRepository;
  projects: ProjectRepository;
  tasks: TaskRepository;
  taskService: TaskService;
  /** Recorded claim verifications (Phase 4A.5); when present, reads fold them in. */
  claimVerifications?: ClaimVerificationRepository;
  options?: BacklogServiceOptions;
}

/** Thrown inside a transaction to roll it back when this conversion no longer owns its claim (its lease lapsed and another converter took over). */
class AnalysisClaimLostError extends Error {}

const DEFAULT_ANALYSIS_MAX_ATTEMPTS = 3;
const DEFAULT_CONVERSION_LEASE_MS = 60_000;
const DEFAULT_LIST_LIMIT = 200;

const now = () => new Date().toISOString();
const addMs = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

/**
 * Backlog Intelligence (Phase 4A) — the application service behind every backlog route. See
 * /docs/BACKLOG_INTELLIGENCE.md.
 *
 * TRUST MODEL — "AI can make claims. CodeForge owns evidence and state." Concretely:
 *  - This class is the ONLY place a backlog item's or proposal's status is ever written, and only
 *    through the guarded repository transitions whose rules live in backlog-state-machine.ts.
 *  - The model's output enters exactly one place — BacklogAnalysisExecutor (the WORKER process; this
 *    API-side service never calls a model, it only enqueues) — strictly schema-validated; from it the
 *    platform derives the outcome by a fixed rule (`deriveAnalysisOutcome`) and builds the proposal itself. No model-supplied value can name a status, an approval, a task id, or any
 *    execution control (the schema is `.strict()`, so such a key makes the output malformed).
 *  - Approval exists only as `approveProposal(actorId)` — an authenticated user action. Nothing on the
 *    analysis path can reach it.
 *  - A Task is created only by `convertProposal`, only from an APPROVED proposal, and only through the
 *    existing `TaskService.create` — so it enters the normal lifecycle as a BACKLOG task a human must
 *    still explicitly Start. Nothing here schedules, releases, or executes anything.
 */
export class BacklogService {
  private readonly analysisMaxAttempts: number;
  private readonly conversionLeaseMs: number;
  private readonly listLimit: number;

  constructor(private readonly deps: BacklogServiceDeps) {
    this.analysisMaxAttempts = deps.options?.analysisMaxAttempts ?? DEFAULT_ANALYSIS_MAX_ATTEMPTS;
    this.conversionLeaseMs = deps.options?.conversionLeaseMs ?? DEFAULT_CONVERSION_LEASE_MS;
    this.listLimit = deps.options?.listLimit ?? DEFAULT_LIST_LIMIT;
  }

  // -------------------------------------------------------------------------
  // Backlog items
  // -------------------------------------------------------------------------

  createItem(projectId: string, input: CreateBacklogItemInput, actorId: string): BacklogItem {
    const project = assertProjectAccess(this.deps.projects, projectId, actorId);
    const externalRef = normalizeRef(input.externalRef);
    if (externalRef !== null && this.deps.items.findByProjectAndRef(project.id, externalRef)) {
      throw new DuplicateBacklogReferenceError(externalRef);
    }
    if (input.repositoryId) resolveRepositoryFor(this.deps.projects.listRepos(project.id), input.repositoryId); // must belong to this project
    const ts = now();
    const item: BacklogItem = {
      id: randomUUID(),
      projectId: project.id,
      repositoryId: input.repositoryId ?? null,
      externalRef,
      title: input.title.trim(),
      description: input.description.trim(),
      source: "manual",
      status: "NEW",
      createdBy: actorId,
      createdAt: ts,
      updatedAt: ts,
    };
    try {
      this.deps.items.insert(item);
    } catch (err) {
      // Closes the race the pre-check above can't: two creates with the same reference both passing it.
      if (externalRef !== null && isDuplicateBacklogRefViolation(err)) throw new DuplicateBacklogReferenceError(externalRef);
      throw err;
    }
    this.deps.events.append(project.id, item.id, "BACKLOG_ITEM_CREATED", { source: item.source, externalRef }, ts);
    return this.deps.items.findById(item.id)!; // read back: the repository may have defaulted to the primary one
  }

  listItems(projectId: string, actorId: string): BacklogItemSummary[] {
    const project = assertProjectAccess(this.deps.projects, projectId, actorId);
    return this.deps.items.listByProject(projectId, this.listLimit).map((item) => {
      const analysis = this.deps.analyses.findLatestForItem(item.id);
      const proposal = this.deps.proposals.findLatestForItem(item.id);
      const scoped = this.deps.projects.findScoped(item.projectId, item.repositoryId) ?? project; // its own repository's checks
      return {
        item,
        review: deriveReview(item, this.readable(this.deps.analyses.findLatestSucceededForItem(item.id), scoped)),
        latestAnalysis: analysis ? { id: analysis.id, status: analysis.status, completedAt: analysis.completedAt } : null,
        proposal: proposal ? { id: proposal.id, status: proposal.status, taskId: proposal.taskId } : null,
      };
    });
  }

  /** An analysis as it should be read today: recorded verifications folded in, reconciliation recomputed against the project's current approved checks. */
  private readable(analysis: BacklogAnalysis | null, project: Project | null): BacklogAnalysis | null {
    if (!analysis || !this.deps.claimVerifications) return analysis;
    return withVerification(analysis, this.deps.claimVerifications.listForAnalysis(analysis.id), project);
  }

  getItem(itemId: string, actorId: string): BacklogItemDetail {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    const project = this.deps.projects.findScoped(item.projectId, item.repositoryId);
    const latest = this.deps.analyses.findLatestForItem(item.id);
    return {
      item,
      review: deriveReview(item, this.readable(this.deps.analyses.findLatestSucceededForItem(item.id), project)),
      latestAnalysis: latest ? this.readable(latest, project) : null,
      analysisJob: this.deps.jobs.findLatestForItem(item.id),
      analysisCount: this.deps.analyses.countForItem(item.id),
      relationships: this.relationshipViews(item),
      proposal: this.deps.proposals.findLatestForItem(item.id),
      events: this.deps.events.listForItem(item.id),
      claimVerifications: latest && this.deps.claimVerifications ? this.deps.claimVerifications.listForAnalysis(latest.id) : [],
    };
  }

  /**
   * Edits a user-owned field. Allowed only while the item is NEW / NEEDS_CLARIFICATION / ANALYZED
   * (see BACKLOG_TRANSITIONS: no edit during ANALYZING, READY_FOR_TASK, or a terminal state), and a
   * real change always resets the item to NEW, since any prior analysis described text that no longer
   * exists (the old analysis stays as history). A PATCH that changes nothing is a no-op — it never
   * throws away a valid analysis.
   */
  updateItem(itemId: string, patch: UpdateBacklogItemInput, actorId: string): BacklogItem {
    const current = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    const next = {
      title: patch.title !== undefined ? patch.title.trim() : current.title,
      description: patch.description !== undefined ? patch.description.trim() : current.description,
      externalRef: patch.externalRef !== undefined ? normalizeRef(patch.externalRef) : current.externalRef,
      repositoryId: patch.repositoryId !== undefined ? resolveRepositoryFor(this.deps.projects.listRepos(current.projectId), patch.repositoryId).id : (current.repositoryId ?? null),
    };
    if (
      next.title === current.title &&
      next.description === current.description &&
      next.externalRef === current.externalRef &&
      next.repositoryId === (current.repositoryId ?? null)
    ) {
      return current;
    }

    if (next.externalRef !== null && next.externalRef.toLowerCase() !== (current.externalRef ?? "").toLowerCase()) {
      const clash = this.deps.items.findByProjectAndRef(current.projectId, next.externalRef);
      if (clash && clash.id !== current.id) throw new DuplicateBacklogReferenceError(next.externalRef);
    }

    let changed: boolean;
    try {
      changed = this.deps.items.updateContent(current.id, next, now());
    } catch (err) {
      if (next.externalRef !== null && isDuplicateBacklogRefViolation(err)) throw new DuplicateBacklogReferenceError(next.externalRef);
      throw err;
    }
    if (!changed) {
      const fresh = this.deps.items.findById(current.id);
      throw new InvalidOperationError(`A backlog item can only be edited while it is NEW, ANALYZED, or NEEDS_CLARIFICATION — this one is ${fresh?.status ?? "unknown"}.`);
    }
    this.deps.events.append(current.projectId, current.id, "BACKLOG_ITEM_UPDATED", { fields: changedFields(current, next) }, now());
    return this.deps.items.findById(current.id)!;
  }

  /** A human dismisses the item itself. Idempotent; refused while a live analysis or an in-flight/finished conversion owns it. */
  rejectItem(itemId: string, actorId: string): BacklogItem {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    if (item.status === "REJECTED") return item;

    const changed = runInTransaction(this.deps.db, () => {
      const live = this.deps.proposals.findLiveForItem(item.id);
      // A conversion that has started (or finished) owns the item — rejecting under it would leave a Task with a REJECTED origin.
      if (live && (live.status === "CONVERTING" || live.status === "CONVERTED")) return false;
      if (!this.deps.items.transition(item.id, "rejected", now())) return false;
      if (live && (live.status === "PENDING" || live.status === "APPROVED")) this.deps.proposals.reject(live.id, actorId, now());
      return true;
    });
    if (!changed) {
      const fresh = this.deps.items.findById(item.id);
      if (fresh?.status === "REJECTED") return fresh;
      throw new InvalidOperationError(`A backlog item that is ${fresh?.status ?? "unknown"} cannot be rejected${fresh?.status === "ANALYZING" ? " — wait for the analysis to finish" : ""}.`);
    }
    this.deps.events.append(item.projectId, item.id, "BACKLOG_ITEM_REJECTED", { rejectedBy: actorId }, now());
    return this.deps.items.findById(item.id)!;
  }

  // -------------------------------------------------------------------------
  // Analysis (enqueue only — the WORKER executes; see backlog-analysis-executor.ts)
  // -------------------------------------------------------------------------

  /**
   * Enqueues an analysis and returns immediately (HTTP 202). **No model is called here, or anywhere
   * in the API process**: this only records a QUEUED job and marks the item ANALYZING; a worker
   * (`BacklogAnalysisRunner`) claims and runs it. Deterministic, idempotent behavior:
   *
   *   item status                      | result
   *   ---------------------------------|---------------------------------------------------------------
   *   ANALYZING (a QUEUED/RUNNING job) | the EXISTING job is returned, `enqueued: false` — no new job
   *   NEW / NEEDS_CLARIFICATION        | a new job is queued
   *   ANALYZED                         | a new job is queued (an explicit re-analysis request)
   *   READY_FOR_TASK                   | 409 — reject the pending proposal first
   *   CONVERTED / REJECTED             | 409 — terminal
   *
   * After a finished job the next request is a NEW analysis by design (the user asked for it); a page
   * refresh never issues one (it only GETs). A failed or cancelled job returns the item to its
   * pre-analysis status, so it can simply be requested again. The item flip and the job insert are
   * one transaction, and the partial unique index allows at most one live job per item, so two racing
   * requests (or two API processes) create exactly one job.
   */
  requestAnalysis(itemId: string, actorId: string): { item: BacklogItem; job: BacklogAnalysisJob; enqueued: boolean } {
    const before = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);

    const existing = this.deps.jobs.findActiveForItem(before.id);
    if (existing) return { item: this.deps.items.findById(before.id)!, job: existing, enqueued: false };

    const jobId = randomUUID();
    const ts = now();
    try {
      runInTransaction(this.deps.db, () => {
        const fresh = this.deps.items.findById(before.id)!;
        // ANALYZING with no live job is an inconsistency (should be unreachable); heal it by queueing a
        // job for it rather than leaving the item stuck.
        if (fresh.status !== "ANALYZING" && !this.deps.items.beginAnalysis(before.id, ts)) {
          throw new InvalidOperationError(
            fresh.status === "READY_FOR_TASK"
              ? "This item already has a task proposal awaiting a decision. Reject the proposal before analyzing again."
              : `A backlog item that is ${fresh.status} cannot be analyzed.`,
          );
        }
        this.deps.jobs.enqueue({ id: jobId, backlogItemId: before.id, projectId: before.projectId, requestedBy: actorId, maxAttempts: this.analysisMaxAttempts, now: ts });
      });
    } catch (err) {
      if (isActiveJobViolation(err)) {
        // Lost the race to another request/process: answer with the winner's job.
        const winner = this.deps.jobs.findActiveForItem(before.id);
        if (winner) return { item: this.deps.items.findById(before.id)!, job: winner, enqueued: false };
      }
      throw err;
    }
    this.deps.events.append(before.projectId, before.id, "ANALYSIS_QUEUED", { jobId, requestedBy: actorId }, ts);
    return { item: this.deps.items.findById(before.id)!, job: this.deps.jobs.findById(jobId)!, enqueued: true };
  }

  /**
   * Cancels the item's live analysis. A QUEUED job is cancelled at once (nothing ran); a RUNNING job
   * gets a cancel request the owning worker acts on at its next heartbeat (it aborts the model call
   * and settles the job CANCELLED). Either way the item returns to its pre-analysis status. Idempotent
   * for a cancel already requested; 409 when there is no live analysis.
   */
  cancelAnalysis(itemId: string, actorId: string): { item: BacklogItem; job: BacklogAnalysisJob } {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    const job = this.deps.jobs.findActiveForItem(item.id);
    if (!job) throw new InvalidOperationError("This backlog item has no analysis in progress to cancel.");
    const ts = now();

    if (job.status === "QUEUED") {
      const cancelled = runInTransaction(this.deps.db, () => {
        if (!this.deps.jobs.cancelQueued(job.id, ts)) return false;
        this.deps.items.abortAnalysis(item.id, ts);
        return true;
      });
      if (cancelled) {
        this.deps.events.append(item.projectId, item.id, "ANALYSIS_CANCELLED", { jobId: job.id, cancelledBy: actorId, before: "started" }, ts);
        return { item: this.deps.items.findById(item.id)!, job: this.deps.jobs.findById(job.id)! };
      }
      // Lost a race with a worker claiming it — fall through to a cancel REQUEST on the now-running job.
    }
    this.deps.jobs.requestCancel(job.id, ts);
    return { item: this.deps.items.findById(item.id)!, job: this.deps.jobs.findById(job.id)! };
  }

  getLatestAnalysis(itemId: string, actorId: string): BacklogAnalysis | null {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    return this.deps.analyses.findLatestForItem(item.id);
  }

  /** The item's most recent analysis JOB (queued / running / retry-scheduled / finished) — what the UI polls to show progress. */
  getLatestAnalysisJob(itemId: string, actorId: string): BacklogAnalysisJob | null {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    return this.deps.jobs.findLatestForItem(item.id);
  }

  getRelationships(itemId: string, actorId: string): RelationshipView[] {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    return this.relationshipViews(item);
  }

  // -------------------------------------------------------------------------
  // Task proposals
  // -------------------------------------------------------------------------

  /**
   * Builds (deterministically — no model call) a TaskProposal from the item's latest SUCCEEDED
   * analysis. Idempotent: if the item already has a live proposal it is returned unchanged
   * (`created: false`), so repeated or racing requests never produce two — the partial unique index
   * on task_proposals is the structural backstop. Only an ANALYZED item may get a proposal; a
   * NEEDS_CLARIFICATION item (blocking questions, or malformed analysis) may not.
   */
  generateProposal(itemId: string, actorId: string): { proposal: TaskProposal; created: boolean } {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    const existing = this.deps.proposals.findLiveForItem(item.id);
    if (existing) return { proposal: existing, created: false };

    const fresh = this.deps.items.findById(item.id)!;
    if (fresh.status !== "ANALYZED") {
      throw new InvalidOperationError(`A task proposal can only be generated for an ANALYZED backlog item — this one is ${fresh.status}.`);
    }
    const analysis = this.deps.analyses.findLatestSucceededForItem(item.id);
    const project = this.deps.projects.findScoped(item.projectId, item.repositoryId);
    if (!analysis) throw new InvalidOperationError("This backlog item has no successful analysis to build a proposal from.");

    const content = buildTaskProposalContent({
      item: fresh,
      analysis: this.readable(analysis, project) ?? analysis,
      outgoing: this.deps.relationships.listOutgoing(item.id),
      incoming: this.deps.relationships.listIncoming(item.id),
      findItem: (id) => {
        const other = this.deps.items.findById(id);
        return other && other.projectId === item.projectId ? other : null;
      },
    });

    const proposalId = randomUUID();
    const ts = now();
    try {
      runInTransaction(this.deps.db, () => {
        this.deps.proposals.insertPending({ id: proposalId, backlogItemId: item.id, projectId: item.projectId, analysisId: analysis.id, content, now: ts });
        if (!this.deps.items.transition(item.id, "proposal_generated", ts)) throw new InvalidOperationError("The backlog item changed while the proposal was being created — retry.");
      });
    } catch (err) {
      if (isLiveProposalViolation(err)) {
        const winner = this.deps.proposals.findLiveForItem(item.id);
        if (winner) return { proposal: winner, created: false };
      }
      throw err;
    }
    this.deps.events.append(item.projectId, item.id, "TASK_PROPOSAL_GENERATED", { proposalId, analysisId: analysis.id }, ts);
    return { proposal: this.deps.proposals.findById(proposalId)!, created: true };
  }

  getProposal(proposalId: string, actorId: string): TaskProposal {
    return assertTaskProposalAccess(this.deps.proposals, this.deps.projects, proposalId, actorId);
  }

  /**
   * The human approval. Only reachable as an authenticated user action — there is no code path from
   * analysis or proposal generation to here. Idempotent (approving an APPROVED/CONVERTING/CONVERTED
   * proposal returns it unchanged); refused for a REJECTED proposal and for one whose stored content
   * no longer validates.
   */
  approveProposal(proposalId: string, actorId: string): TaskProposal {
    const proposal = assertTaskProposalAccess(this.deps.proposals, this.deps.projects, proposalId, actorId);
    if (proposal.content === null) {
      throw new InvalidOperationError("This proposal's stored content is invalid and it cannot be approved. Reject it and generate a new one.");
    }
    if (this.deps.proposals.approve(proposal.id, actorId, now())) {
      this.deps.events.append(proposal.projectId, proposal.backlogItemId, "TASK_PROPOSAL_APPROVED", { proposalId, approvedBy: actorId }, now());
      return this.deps.proposals.findById(proposal.id)!;
    }
    const fresh = this.deps.proposals.findById(proposal.id)!;
    if (fresh.status === "APPROVED" || fresh.status === "CONVERTING" || fresh.status === "CONVERTED") return fresh;
    throw new InvalidOperationError(`A ${fresh.status} proposal cannot be approved.`);
  }

  /** Rejects a PENDING/APPROVED proposal (idempotent), returning the item to ANALYZED so a new proposal can be generated. */
  rejectProposal(proposalId: string, actorId: string): TaskProposal {
    const proposal = assertTaskProposalAccess(this.deps.proposals, this.deps.projects, proposalId, actorId);
    const ts = now();
    const changed = runInTransaction(this.deps.db, () => {
      if (!this.deps.proposals.reject(proposal.id, actorId, ts)) return false;
      this.deps.items.transition(proposal.backlogItemId, "proposal_rejected", ts); // false only if the item itself was already REJECTED — fine
      return true;
    });
    if (changed) {
      this.deps.events.append(proposal.projectId, proposal.backlogItemId, "TASK_PROPOSAL_REJECTED", { proposalId, rejectedBy: actorId }, ts);
      return this.deps.proposals.findById(proposal.id)!;
    }
    const fresh = this.deps.proposals.findById(proposal.id)!;
    if (fresh.status === "REJECTED") return fresh;
    throw new InvalidOperationError(`A ${fresh.status} proposal cannot be rejected.`);
  }

  /**
   * Converts an APPROVED proposal into exactly one ordinary Task through the EXISTING
   * `TaskService.create` — the same path a hand-created task takes, so it lands in BACKLOG and a human
   * still has to Start it; nothing here executes, schedules, or releases anything.
   *
   * Idempotency / no duplicate Tasks (see migrations/013_backlog_intelligence.sql):
   *  1. An atomic claim moves APPROVED -> CONVERTING and RESERVES the Task id on the proposal. Two
   *     simultaneous conversions (two requests, or two processes) can never both claim; the loser gets
   *     ConversionInProgressError, or — if the winner already finished — the finished result.
   *  2. The Task is created with that reserved id, so even a bug could not insert a second one (the
   *     primary key refuses it). A retry after a crash finds the reserved Task already exists and only
   *     finalizes.
   *  3. Finalizing (proposal -> CONVERTED with its task id, item -> CONVERTED) is one transaction.
   *  A repeated call on a CONVERTED proposal simply returns the same Task.
   */
  async convertProposal(proposalId: string, actorId: string): Promise<{ proposal: TaskProposal; task: Task; alreadyConverted: boolean }> {
    const proposal = assertTaskProposalAccess(this.deps.proposals, this.deps.projects, proposalId, actorId);

    if (proposal.status === "CONVERTED") return this.convertedResult(proposal);
    if (proposal.status === "PENDING") throw new InvalidOperationError("This proposal must be approved before it can be converted to a task.");
    if (proposal.status === "REJECTED") throw new InvalidOperationError("A rejected proposal cannot be converted to a task.");
    const content = proposal.content;
    if (content === null) throw new InvalidOperationError("This proposal's stored content is invalid and it cannot be converted. Reject it and generate a new one.");

    const claimId = randomUUID();
    const ts = now();
    if (!this.deps.proposals.claimConversion(proposal.id, claimId, randomUUID(), ts, addMs(ts, this.conversionLeaseMs))) {
      const fresh = this.deps.proposals.findById(proposal.id)!;
      if (fresh.status === "CONVERTED") return this.convertedResult(fresh);
      if (fresh.status === "CONVERTING") throw new ConversionInProgressError();
      throw new InvalidOperationError(`A ${fresh.status} proposal cannot be converted to a task.`);
    }

    const taskId = this.deps.proposals.reservedTaskId(proposal.id)!;
    try {
      let task = this.deps.tasks.findById(taskId);
      if (!task) {
        task = await this.deps.taskService.create(
          {
            projectId: proposal.projectId,
            // The task works in the same repository the backlog item (and its analysis) concerned (TD-62).
            repositoryId: this.deps.items.findById(proposal.backlogItemId)?.repositoryId ?? null,
            title: content.title,
            description: content.goal,
            id: taskId,
            origin: { backlogItemId: proposal.backlogItemId, taskProposalId: proposal.id },
          },
          actorId,
        );
      }
      const finalizedAt = now();
      runInTransaction(this.deps.db, () => {
        if (!this.deps.proposals.finalizeConversion(proposal.id, claimId, task!.id, finalizedAt)) throw new AnalysisClaimLostError();
        if (!this.deps.items.transition(proposal.backlogItemId, "converted", finalizedAt)) {
          throw new Error(`backlog item ${proposal.backlogItemId} was not READY_FOR_TASK when its proposal converted`);
        }
      });
      this.deps.events.append(proposal.projectId, proposal.backlogItemId, "TASK_PROPOSAL_CONVERTED", { proposalId: proposal.id, taskId: task.id, convertedBy: actorId }, finalizedAt);
      return { proposal: this.deps.proposals.findById(proposal.id)!, task, alreadyConverted: false };
    } catch (err) {
      if (err instanceof AnalysisClaimLostError) {
        // Another actor finalized it first (our lease lapsed) — report what is now true.
        const fresh = this.deps.proposals.findById(proposal.id)!;
        if (fresh.status === "CONVERTED") return this.convertedResult(fresh);
        throw new ConversionInProgressError();
      }
      // Task creation (or finalization) failed: give the claim back so the proposal is APPROVED again
      // and retryable. The reserved task id stays, so a retry can never produce a second Task.
      this.deps.proposals.releaseConversion(proposal.id, claimId, now());
      throw err;
    }
  }

  private convertedResult(proposal: TaskProposal): { proposal: TaskProposal; task: Task; alreadyConverted: boolean } {
    const task = proposal.taskId ? this.deps.tasks.findById(proposal.taskId) : null;
    if (!task) throw new Error(`Proposal ${proposal.id} is CONVERTED but its task ${proposal.taskId} does not exist`);
    return { proposal, task, alreadyConverted: true };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private relationshipViews(item: BacklogItem): RelationshipView[] {
    const view = (rel: BacklogRelationship, direction: "outgoing" | "incoming"): RelationshipView | null => {
      const otherId = direction === "outgoing" ? rel.toItemId : rel.fromItemId;
      const other = this.deps.items.findById(otherId);
      if (!other || other.projectId !== item.projectId) return null;
      return { relationship: rel, direction, other: { id: other.id, ref: other.externalRef, title: other.title, status: other.status } };
    };
    return [
      ...this.deps.relationships.listOutgoing(item.id).map((r) => view(r, "outgoing")),
      ...this.deps.relationships.listIncoming(item.id).map((r) => view(r, "incoming")),
    ].filter((v): v is RelationshipView => v !== null);
  }
}

function normalizeRef(ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  const trimmed = ref.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function changedFields(a: { title: string; description: string; externalRef: string | null }, b: { title: string; description: string; externalRef: string | null }): string[] {
  const fields: string[] = [];
  if (a.title !== b.title) fields.push("title");
  if (a.description !== b.description) fields.push("description");
  if (a.externalRef !== b.externalRef) fields.push("externalRef");
  return fields;
}
