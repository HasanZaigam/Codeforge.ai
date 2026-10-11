import { randomUUID } from "node:crypto";
import type { ClaimVerificationJob } from "../backlog/backlog-types.js";
import { checkFingerprint, planVerification } from "../backlog/verification.js";
import type { BacklogAnalysisRepository } from "../persistence/repositories/backlog-analysis-repository.js";
import type { BacklogEventRepository } from "../persistence/repositories/backlog-event-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { ClaimVerificationJobRepository } from "../persistence/repositories/claim-verification-job-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import { assertBacklogItemAccess } from "./authorization.js";
import { InvalidOperationError, NotFoundError } from "./errors.js";

export interface ClaimVerifierDeps {
  items: BacklogItemRepository;
  analyses: BacklogAnalysisRepository;
  projects: ProjectRepository;
  jobs: ClaimVerificationJobRepository;
  events: BacklogEventRepository;
  maxAttempts?: number;
}

/**
 * The API-side half of claim-bound verification (Phase 4A.6): it only ENQUEUES and CANCELS durable jobs — running a project's
 * command (and `npm ci`) belongs to the worker, never an HTTP request. Reachable only by the project's owner via an explicit
 * request; nothing a model returns can call it.
 *
 * `request`: latest SUCCEEDED analysis → its analysed revision → requirements (claim ⇄ approved check, decided by the platform)
 * → one idempotent job per (claim, check), each bound to that analysis, revision and the check's fingerprint.
 */
export class ClaimVerifier {
  constructor(private readonly deps: ClaimVerifierDeps) {}

  request(itemId: string, actorId: string, only?: { claimIndex?: number; checkId?: string }): { jobs: ClaimVerificationJob[]; enqueued: number; revision: string; note: string | null } {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    const analysis = this.deps.analyses.findLatestSucceededForItem(item.id);
    if (!analysis?.result) throw new InvalidOperationError("This backlog item has no successful analysis to verify claims of.");
    const revision = analysis.platformChecks?.assessment?.reconciliation?.revision;
    if (!revision) throw new InvalidOperationError("This analysis did not record the repository revision it examined, so a check cannot be bound to it.");
    const project = this.deps.projects.findById(item.projectId);
    if (!project) throw new InvalidOperationError("The item's project no longer exists.");

    const requirements = planVerification(analysis.result.claims, project).filter(
      (r) => (only?.claimIndex === undefined || r.claimIndex === only.claimIndex) && (only?.checkId === undefined || r.checkId === only.checkId),
    );
    if (requirements.length === 0) return { jobs: [], enqueued: 0, revision, note: "No approved check of this project is bound to any (selected) behaviour claim of this analysis, so nothing was queued; behaviour stays unverified." };

    const now = new Date().toISOString();
    const jobs: ClaimVerificationJob[] = [];
    let enqueued = 0;
    for (const r of requirements) {
      const check = (project.commands?.claimChecks ?? []).find((c) => c.id === r.checkId)!;
      const res = this.deps.jobs.enqueue({
        id: randomUUID(),
        backlogItemId: item.id,
        projectId: project.id,
        analysisId: analysis.id,
        claimId: r.claimId!,
        claimIndex: r.claimIndex,
        checkId: r.checkId,
        checkFingerprint: checkFingerprint(check),
        revision,
        requestedBy: actorId,
        maxAttempts: this.deps.maxAttempts ?? 2,
        now,
      });
      jobs.push(res.job);
      if (res.enqueued) {
        enqueued++;
        this.deps.events.append(project.id, item.id, "CLAIM_VERIFICATION_QUEUED", { jobId: res.job.id, analysisId: analysis.id, claimId: r.claimId, checkId: r.checkId, revision }, now);
      }
    }
    return { jobs, enqueued, revision, note: null };
  }

  list(itemId: string, actorId: string): ClaimVerificationJob[] {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    return this.deps.jobs.listForItem(item.id);
  }

  /** A QUEUED job is cancelled at once; a RUNNING one at the owning worker's next heartbeat. Idempotent; 409 if already finished. */
  cancel(itemId: string, jobId: string, actorId: string): ClaimVerificationJob {
    const item = assertBacklogItemAccess(this.deps.items, this.deps.projects, itemId, actorId);
    const job = this.deps.jobs.findById(jobId);
    if (!job || job.backlogItemId !== item.id) throw new NotFoundError("ClaimVerificationJob", jobId);
    const now = new Date().toISOString();
    if (job.status === "QUEUED" && this.deps.jobs.cancelQueued(job.id, now)) return this.deps.jobs.findById(job.id)!;
    if (this.deps.jobs.requestCancel(job.id, now)) return this.deps.jobs.findById(job.id)!;
    const fresh = this.deps.jobs.findById(job.id)!;
    if (fresh.status === "CANCELLED") return fresh;
    throw new InvalidOperationError(`This verification already finished (${fresh.status}).`);
  }
}
