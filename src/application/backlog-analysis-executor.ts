import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CostMetadata, Project } from "../domain/types.js";
import type { AnalysisFailureCategory, AnalysisResult, BacklogAnalysisJob, BacklogItem, EvidenceAssessment, PlatformChecks } from "../backlog/backlog-types.js";
import { parseAnalysisOutput } from "../backlog/analysis-schema.js";
import { deriveAnalysisOutcome } from "../backlog/backlog-state-machine.js";
import type { AnalyzerOutcome, BacklogAnalyzer } from "../backlog/backlog-analyzer.js";
import type { BacklogContextBuilder, BuiltAnalysisContext, RepositoryAccess } from "../backlog/context-builder.js";
import { assessClaims, buildAssessment, collectEvidence, listingState, type CollectedEvidence } from "../backlog/evidence.js";
import { DEFAULT_INSPECTION_LIMITS, RepositoryInspector, type InspectionLimits } from "../backlog/repository-inspector.js";
import type { IndexAccess, RepositoryIndexService } from "../backlog/repository-index-service.js";
import { reconcile } from "../backlog/reconciliation.js";
import { investigate } from "../backlog/investigation.js";
import { planVerification, verificationCandidates } from "../backlog/verification.js";
import type { RepositoryStructureProvider } from "../backlog/repository-structure.js";
import { resolveRelationshipProposals } from "../backlog/relationship-resolution.js";
import { computeBackoffDelayMs } from "../coding-engine/retry-backoff.js";
import { redactSecrets } from "../security/redact.js";
import { runInTransaction } from "../persistence/transaction.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { BacklogAnalysisRepository } from "../persistence/repositories/backlog-analysis-repository.js";
import type { BacklogRelationshipRepository } from "../persistence/repositories/backlog-relationship-repository.js";
import type { BacklogEventRepository } from "../persistence/repositories/backlog-event-repository.js";
import type { BacklogAnalysisJobRepository, JobClaim, JobOutcomeRouting } from "../persistence/repositories/backlog-analysis-job-repository.js";

/** Why the runner aborted a run's signal — decides how the executor settles the job. */
export type AbortReason = "shutdown" | "cancel" | "lease_lost";

export interface BacklogAnalysisExecutorOptions {
  /** Bounded backoff between job attempts after a retryable failure — the SAME knobs as episode-level infrastructure retry (`INFRA_RETRY_*`). */
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** Upper bound on a "wait for a cooling provider" deferral (mirrors `providerCooldownMaxMs`). */
  cooldownMaxMs: number;
}

export interface BacklogAnalysisExecutorDeps {
  db: DatabaseSync;
  items: BacklogItemRepository;
  analyses: BacklogAnalysisRepository;
  relationships: BacklogRelationshipRepository;
  events: BacklogEventRepository;
  jobs: BacklogAnalysisJobRepository;
  projects: ProjectRepository;
  analyzer: BacklogAnalyzer;
  contextBuilder: BacklogContextBuilder;
  /** How analysis reads the repository (listing + bounded content). `null` = no repository access. See backlog/repository-structure.ts. */
  repository: RepositoryStructureProvider | null;
  inspectionLimits?: InspectionLimits;
  /** Lazily builds/serves the revision-bound repository index (Phase 4A.3). `null` = select by file name only. */
  repositoryIndex?: RepositoryIndexService | null;
  options: BacklogAnalysisExecutorOptions;
}

/** Thrown inside a transaction to roll it back when this worker no longer owns the job (its lease lapsed and another worker took over). */
class JobClaimLostError extends Error {}

const now = () => new Date().toISOString();
const NO_ROUTING: JobOutcomeRouting = { modelId: null, providerId: null };

/**
 * Performs ONE attempt of a claimed backlog-analysis job, in the WORKER process (never in an API
 * request), and settles it. This is where a model output first touches platform state — and the
 * trust model is unchanged from Phase 4A (see backlog-service.ts / BACKLOG_INTELLIGENCE.md §2): the
 * output is strictly schema-validated; the platform derives the item status and builds every
 * relationship row itself; nothing the model returns can name a status.
 *
 * Every write is fenced by the job's `(owner, lock_generation)` claim inside the same transaction as
 * the rows it accompanies, so a worker that lost its lease can never leave a half-written or
 * duplicate result: its transaction rolls back and it discards its work.
 *
 * Failure handling REUSES the existing machinery — `classifyOrchestratorFailure` (via the analyzer),
 * `computeBackoffDelayMs`, model routing + provider health — and adds no second taxonomy:
 *   retryable infrastructure failure -> requeue with backoff, while attempts remain;
 *   malformed output                 -> NEVER retried (a model repeating the same mistake is not
 *                                       infrastructure); the item goes to NEEDS_CLARIFICATION;
 *   auth / permanent-config / unknown -> terminal FAILED immediately.
 */
export class BacklogAnalysisExecutor {
  private readonly env: NodeJS.ProcessEnv = process.env;

  constructor(private readonly deps: BacklogAnalysisExecutorDeps) {}

  async execute(job: BacklogAnalysisJob, signal: AbortSignal, abortReason: () => AbortReason | null): Promise<void> {
    const claim = claimOf(job);
    const started = Date.now();
    const startedAt = now();

    // A cancel that arrived while the job was queued/expired is honored before any model call.
    if (job.cancelRequestedAt !== null) {
      this.settleCancelled(job, claim);
      return;
    }

    const item = this.deps.items.findById(job.backlogItemId);
    const project = item ? this.deps.projects.findById(item.projectId) : null;
    if (!item || !project || item.status !== "ANALYZING") {
      // Should be unreachable (an item is only edited/rejected/converted when it has no live job), but a
      // job must never be left RUNNING against an item that can no longer accept its result.
      this.failWithoutResult(job, claim, "context_error", "The backlog item is no longer awaiting analysis.");
      return;
    }

    this.deps.events.append(project.id, item.id, "ANALYSIS_STARTED", { jobId: job.id, attempt: job.attemptCount, maxAttempts: job.maxAttempts, worker: job.claimOwner }, startedAt);

    // One repository session per attempt (listing + bounded content reads); ALWAYS disposed.
    let repo: RepositoryAccess = { session: null, inspector: null, error: null };
    try {
      let ctx: BuiltAnalysisContext;
      try {
        repo = await this.openRepository(project, signal);
        ctx = await this.deps.contextBuilder.build(project, item, this.deps.items.listSiblings(project.id, item.id), signal, repo);
      } catch (err) {
        if (signal.aborted) {
          this.settleAborted(job, claim, project, item, abortReason(), null);
        } else {
          console.error(`[backlog] context build failed for item ${item.id}:`, err);
          this.settleFailure(job, claim, project, item, startedAt, started, "context_error", "The analysis context could not be built.", null, null, null);
        }
        return;
      }

      const outcome = await this.deps.analyzer.run(project, ctx.prompt, signal);

      if (!outcome.ok) {
        if (outcome.category === "cancelled" || signal.aborted) {
          this.settleAborted(job, claim, project, item, abortReason(), outcome);
          return;
        }
        if (outcome.retryable && job.attemptCount < job.maxAttempts) {
          this.scheduleRetry(job, claim, project, item, outcome);
          return;
        }
        this.settleFailure(job, claim, project, item, startedAt, started, outcome.category, outcome.reason, outcome, ctx, null);
        return;
      }

      const parsed = parseAnalysisOutput(outcome.rawOutput);
      if (!parsed.ok) {
        // Malformed output is NEVER accepted, never retried, never silently dropped: it is recorded as a
        // failed analysis with bounded diagnostics, and the item goes to NEEDS_CLARIFICATION.
        this.settleFailure(job, claim, project, item, startedAt, started, "malformed_output", parsed.reason, outcome, ctx, {
          stage: parsed.stage,
          issues: parsed.issues ?? [],
          outputExcerpt: this.clean(outcome.rawOutput.slice(0, 500)),
          outputChars: outcome.rawOutput.length,
        });
        return;
      }

      // The model's claims are checked HERE, by the platform, against the repository — the model's own
      // words about verification are never consulted (see backlog/evidence.ts).
      let collected: CollectedEvidence;
      try {
        collected = await collectEvidence(parsed.value, repo.session, repo.inspector, signal, repo.index?.state === "used" ? repo.index.index : null);
      } catch (err) {
        if (signal.aborted) {
          this.settleAborted(job, claim, project, item, abortReason(), null);
          return;
        }
        throw err;
      }
      // The platform's OWN investigation of the item's premise — from the item text and the repository, independent of any
      // claim the model made (real models mostly accept the premise instead of asserting an absence).
      let investigated;
      try {
        investigated = await investigate({
          text: `${item.title}\n${item.description}`,
          session: repo.session,
          inspector: repo.inspector,
          index: repo.index?.state === "used" ? repo.index.index : null,
          startEvidenceNumber: collected.evidence.length + 1,
          signal,
        });
      } catch (err) {
        if (signal.aborted) {
          this.settleAborted(job, claim, project, item, abortReason(), null);
          return;
        }
        throw err;
      }
      const baseAssessment = {
        investigation: investigated.investigation,
        ...buildAssessment(
          [...collected.evidence, ...investigated.evidence],
          assessClaims(parsed.value.claims, collected.perClaim, listingState(repo.session)),
          parsed.value.confidence.overall,
          repo.inspector?.summary(listingState(repo.session)) ?? { listing: "unavailable", filesRead: 0, bytesRead: 0, filesSkipped: [], limits: { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 } },
        ),
        // Which of the project's APPROVED checks are bound to which behaviour claims (recorded as `not_run`: analysis executes nothing).
        verification: planVerification(parsed.value.claims, project),
        verificationCandidates: verificationCandidates(parsed.value.claims, project.commands?.claimChecks),
      };
      // AFTER the model answered and the platform gathered its own evidence: the platform — not the model —
      // decides how claim and evidence relate (see backlog/reconciliation.ts). Bound to the analysed revision.
      const assessment = { ...baseAssessment, reconciliation: reconcile(parsed.value.claims, baseAssessment, repo.session?.revision ?? null, { investigation: investigated.investigation, checks: project.commands?.claimChecks }) };
      this.settleSuccess(job, claim, project, item, startedAt, started, parsed.value, outcome, ctx, collected, assessment);
    } finally {
      await repo.session?.dispose().catch(() => {});
    }
  }

  /** Opens the repository for this attempt. A failure degrades to "no repository access" (analysis still runs and says so) — except an abort, which propagates. */
  private async openRepository(project: Project, signal: AbortSignal): Promise<RepositoryAccess> {
    if (!this.deps.repository) return { session: null, inspector: null, error: "no repository structure provider configured" };
    try {
      const session = await this.deps.repository.open(project, signal);
      // The index is best-effort: any failure to obtain one degrades to name-only selection (and says so).
      let index: IndexAccess | null = null;
      if (this.deps.repositoryIndex) {
        try {
          index = await this.deps.repositoryIndex.obtain(project, session, signal);
        } catch (err) {
          if (signal.aborted) {
            await session.dispose().catch(() => {});
            throw err;
          }
          index = { state: "failed", index: null, built: false, reason: err instanceof Error ? err.message.slice(0, 300) : "index unavailable" };
        }
      }
      return { session, inspector: new RepositoryInspector(session, this.deps.inspectionLimits ?? DEFAULT_INSPECTION_LIMITS), error: null, index };
    } catch (err) {
      if (signal.aborted) throw err;
      return { session: null, inspector: null, error: err instanceof Error ? err.message.slice(0, 300) : "repository could not be opened" };
    }
  }

  /** A crash-looping job (expired lease, attempts exhausted) is settled as FAILED instead of running again. */
  settleExhausted(job: BacklogAnalysisJob): void {
    const claim = claimOf(job);
    const item = this.deps.items.findById(job.backlogItemId);
    const project = item ? this.deps.projects.findById(item.projectId) : null;
    if (!item || !project) {
      this.failWithoutResult(job, claim, "interrupted", "Analysis was interrupted more times than allowed.");
      return;
    }
    this.settleFailure(job, claim, project, item, job.startedAt ?? job.createdAt, Date.parse(job.startedAt ?? job.createdAt) || Date.now(), "interrupted", "The analysis was interrupted (its worker stopped) more times than allowed.", null, null, null);
  }

  // -------------------------------------------------------------------------
  // settling
  // -------------------------------------------------------------------------

  private settleSuccess(
    job: BacklogAnalysisJob,
    claim: JobClaim,
    project: Project,
    item: BacklogItem,
    startedAt: string,
    started: number,
    result: AnalysisResult,
    outcome: Extract<AnalyzerOutcome, { ok: true }>,
    ctx: BuiltAnalysisContext,
    collected: CollectedEvidence,
    assessment: EvidenceAssessment,
  ): void {
    const analysisId = randomUUID();
    const completedAt = now();
    const siblings = this.deps.items.listSiblings(project.id, item.id);
    const resolved = resolveRelationshipProposals(item, result, siblings, this.deps.relationships.listLiveEdges(project.id, "DEPENDS_ON"));
    const platformChecks: PlatformChecks = {
      // Existence of each named file, decided by the platform from the listing (`null` = it could not decide).
      candidateFiles: collected.candidateFiles,
      unresolvedReferences: resolved.unresolved,
      droppedRelationships: resolved.dropped,
      context: ctx.summary,
      assessment,
    };
    const trigger = deriveAnalysisOutcome(result, assessment);
    const routing = routingOf(outcome.selection);

    if (
      !this.settle(() => {
        this.deps.analyses.insert({
          id: analysisId,
          backlogItemId: item.id,
          projectId: project.id,
          status: "succeeded",
          failureCategory: null,
          failureReason: null,
          result,
          platformChecks,
          diagnostics: ctx.structureError ? { repositoryStructureError: this.clean(ctx.structureError) } : null,
          modelId: routing.modelId,
          providerId: routing.providerId,
          engineKey: outcome.engineKey,
          fallbackIndex: outcome.selection?.fallbackIndex ?? 0,
          routingReason: outcome.selection?.reason ?? null,
          cost: outcome.cost,
          startedAt,
          completedAt,
          durationMs: Date.now() - started,
        });
        this.deps.relationships.replaceProposed(project.id, item.id, analysisId, resolved.proposals, completedAt);
        if (!this.deps.items.completeAnalysis(item.id, trigger, completedAt)) throw new JobClaimLostError();
        if (!this.deps.jobs.succeed(claim, analysisId, routing, completedAt)) throw new JobClaimLostError();
      }, job)
    ) {
      return;
    }

    this.deps.events.append(project.id, item.id, "ANALYSIS_COMPLETED", {
      jobId: job.id,
      analysisId,
      attempt: job.attemptCount,
      modelId: routing.modelId,
      providerId: routing.providerId,
      fallbackIndex: outcome.selection?.fallbackIndex ?? 0,
      modelAttempts: outcome.attempts.length,
      durationMs: Date.now() - started,
      itemStatus: trigger === "analysis_succeeded" ? "ANALYZED" : "NEEDS_CLARIFICATION",
      duplicateProposals: resolved.proposals.filter((p) => p.kind === "POSSIBLE_DUPLICATE").length,
      dependencyProposals: resolved.proposals.filter((p) => p.kind === "DEPENDS_ON").length,
      unresolvedReferences: resolved.unresolved.length,
      blockingMissingInformation: result.missingInformation.filter((m) => m.blocking).length,
      claims: result.claims.length,
      claimsSupported: assessment.summary.supported,
      claimsContradicted: assessment.summary.contradicted,
      claimsUnresolved: assessment.summary.unresolved,
      claimsNotChecked: assessment.summary.notChecked,
      confidenceOverridden: assessment.confidenceOverridden,
      alreadyImplemented: assessment.reconciliation?.alreadyImplemented ?? "none",
      implementation: assessment.reconciliation?.implementation ?? "none",
      investigation: assessment.investigation?.signal ?? "UNRESOLVED",
      filesRead: assessment.inspection.filesRead,
      hasUsage: outcome.cost !== null,
      context: ctx.summary,
    }, completedAt);
  }

  /** A TERMINAL failure: records a failed analysis (history + diagnostics) and finishes the job as FAILED. */
  private settleFailure(
    job: BacklogAnalysisJob,
    claim: JobClaim,
    project: Project,
    item: BacklogItem,
    startedAt: string,
    started: number,
    category: AnalysisFailureCategory,
    reason: string,
    outcome: { selection: { modelId: string; providerId: string; fallbackIndex: number; reason: string } | null; engineKey: string | null; attempts: unknown[]; cost?: CostMetadata | null } | null,
    ctx: BuiltAnalysisContext | null,
    diagnostics: Record<string, unknown> | null,
  ): void {
    const analysisId = randomUUID();
    const completedAt = now();
    const cleanReason = this.clean(reason);
    const routing = routingOf(outcome?.selection ?? null);
    // Malformed output means a human should look (NEEDS_CLARIFICATION); anything else is an
    // infrastructure/config problem the user cannot fix by clarifying, so the item returns to where it was.
    const toClarification = category === "malformed_output";

    if (
      !this.settle(() => {
        this.deps.analyses.insert({
          id: analysisId,
          backlogItemId: item.id,
          projectId: project.id,
          status: "failed",
          failureCategory: category,
          failureReason: cleanReason,
          result: null,
          platformChecks: null,
          diagnostics: { ...(diagnostics ?? {}), attempts: job.attemptCount, ...(ctx ? { context: ctx.summary } : {}) },
          modelId: routing.modelId,
          providerId: routing.providerId,
          engineKey: outcome?.engineKey ?? null,
          fallbackIndex: outcome?.selection?.fallbackIndex ?? 0,
          routingReason: outcome?.selection?.reason ?? null,
          // A call that RETURNED (e.g. malformed output) really consumed tokens — keep what the engine reported.
          // A call that failed before returning has no usage to attribute, so this stays null (never a guess).
          cost: outcome?.cost ?? null,
          startedAt,
          completedAt,
          durationMs: Date.now() - started,
        });
        const itemSettled = toClarification ? this.deps.items.completeAnalysis(item.id, "analysis_needs_clarification", completedAt) : this.deps.items.abortAnalysis(item.id, completedAt);
        if (!itemSettled) throw new JobClaimLostError();
        if (!this.deps.jobs.fail(claim, category, cleanReason, analysisId, routing, completedAt)) throw new JobClaimLostError();
      }, job)
    ) {
      return;
    }

    this.deps.events.append(project.id, item.id, "ANALYSIS_FAILED", {
      jobId: job.id,
      analysisId,
      category,
      reason: cleanReason,
      attempt: job.attemptCount,
      maxAttempts: job.maxAttempts,
      modelId: routing.modelId,
      providerId: routing.providerId,
      fallbackIndex: outcome?.selection?.fallbackIndex ?? 0,
      modelAttempts: outcome?.attempts.length ?? 0,
      durationMs: Date.now() - started,
      itemStatus: toClarification ? "NEEDS_CLARIFICATION" : "(returned to its pre-analysis status)",
    }, completedAt);
  }

  /** A retryable infrastructure failure with attempts left: back to QUEUED with a backoff; the item stays ANALYZING. */
  private scheduleRetry(job: BacklogAnalysisJob, claim: JobClaim, project: Project, item: BacklogItem, outcome: Extract<AnalyzerOutcome, { ok: false }>): void {
    const { retryBaseDelayMs, retryMaxDelayMs, cooldownMaxMs } = this.deps.options;
    const backoff = Math.max(Math.floor(retryBaseDelayMs / 2), computeBackoffDelayMs(job.attemptCount, retryBaseDelayMs, retryMaxDelayMs));
    // Same rule the orchestrator uses for episode retry: honor a provider-suggested wait, bounded. A wait
    // for a cooling-down provider (no_model_available) is bounded by the cooldown ceiling instead, since
    // retrying sooner than the cooldown just fails again without calling anything.
    const delayMs =
      outcome.category === "no_model_available"
        ? Math.min(Math.max(outcome.retryAfterMs ?? backoff, backoff), cooldownMaxMs)
        : outcome.retryAfterMs !== null
          ? Math.min(Math.max(backoff, outcome.retryAfterMs), retryMaxDelayMs)
          : backoff;
    const at = now();
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    const reason = this.clean(outcome.reason);
    const routing = routingOf(outcome.selection);
    if (!this.settle(() => {
      if (!this.deps.jobs.requeue(claim, availableAt, outcome.category, reason, routing, at)) throw new JobClaimLostError();
    }, job)) return;
    this.deps.events.append(project.id, item.id, "ANALYSIS_RETRY_SCHEDULED", {
      jobId: job.id,
      attempt: job.attemptCount,
      maxAttempts: job.maxAttempts,
      category: outcome.category,
      reason,
      retryInMs: delayMs,
      availableAt,
      modelId: routing.modelId,
      providerId: routing.providerId,
    }, at);
  }

  /** The run's signal was aborted: `cancel` -> CANCELLED, `shutdown` -> give the job back untouched, `lease_lost` -> discard (someone else owns it now). */
  private settleAborted(job: BacklogAnalysisJob, claim: JobClaim, project: Project, item: BacklogItem, reason: AbortReason | null, _outcome: unknown): void {
    if (reason === "lease_lost") {
      console.warn(`[backlog] analysis job ${job.id} lost its lease mid-run; discarding this attempt's work.`);
      return;
    }
    if (reason === "shutdown") {
      // The worker is stopping, the job did not fail: return it to the queue and give the attempt back.
      this.settle(() => {
        if (!this.deps.jobs.release(claim, now())) throw new JobClaimLostError();
      }, job);
      return;
    }
    // "cancel" (or an abort with no recorded reason: treat as a cancel rather than leave the job RUNNING).
    this.settleCancelled(job, claim, project, item);
  }

  private settleCancelled(job: BacklogAnalysisJob, claim: JobClaim, project?: Project, item?: BacklogItem): void {
    const at = now();
    const loadedItem = item ?? this.deps.items.findById(job.backlogItemId);
    const loadedProject = project ?? (loadedItem ? this.deps.projects.findById(loadedItem.projectId) : null);
    if (
      !this.settle(() => {
        this.deps.items.abortAnalysis(job.backlogItemId, at); // false only if the item already left ANALYZING — fine
        if (!this.deps.jobs.cancel(claim, null, at)) throw new JobClaimLostError();
      }, job)
    ) {
      return;
    }
    if (loadedProject && loadedItem) this.deps.events.append(loadedProject.id, loadedItem.id, "ANALYSIS_CANCELLED", { jobId: job.id, attempt: job.attemptCount }, at);
  }

  /** A job that cannot produce a result row (its item vanished / is inconsistent): fail the job only. */
  private failWithoutResult(job: BacklogAnalysisJob, claim: JobClaim, category: AnalysisFailureCategory, reason: string): void {
    this.settle(() => {
      if (!this.deps.jobs.fail(claim, category, this.clean(reason), null, NO_ROUTING, now())) throw new JobClaimLostError();
    }, job);
  }

  /** Runs `fn` in one transaction; returns false (having rolled back) if this worker no longer owns the job. */
  private settle(fn: () => void, job: BacklogAnalysisJob): boolean {
    try {
      runInTransaction(this.deps.db, fn);
      return true;
    } catch (err) {
      if (err instanceof JobClaimLostError) {
        console.warn(`[backlog] analysis job ${job.id} finished after losing its claim; outcome discarded.`);
        return false;
      }
      throw err;
    }
  }

  private clean(text: string): string {
    return redactSecrets(text, this.env).slice(0, 500);
  }
}

function claimOf(job: BacklogAnalysisJob): JobClaim {
  return { id: job.id, owner: job.claimOwner ?? "", generation: job.lockGeneration };
}

function routingOf(selection: { modelId: string; providerId: string } | null): JobOutcomeRouting {
  return { modelId: selection?.modelId ?? null, providerId: selection?.providerId ?? null };
}
