import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ClaimVerificationJob, ClaimVerificationRecord } from "../backlog/backlog-types.js";
import { HUMAN_REQUESTED_VERIFICATION, checkFingerprint, planVerification, prepareRevisionWorkspace, runClaimVerification, type RevisionWorkspace } from "../backlog/verification.js";
import type { Project } from "../domain/types.js";
import type { BacklogAnalysisRepository } from "../persistence/repositories/backlog-analysis-repository.js";
import type { BacklogEventRepository } from "../persistence/repositories/backlog-event-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { ClaimVerificationJobRepository } from "../persistence/repositories/claim-verification-job-repository.js";
import type { ClaimVerificationRepository } from "../persistence/repositories/claim-verification-repository.js";
import type { JobClaim } from "../persistence/repositories/backlog-analysis-job-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { SourceControlProviderRegistry } from "../source-control/source-control-provider.js";
import { redactSecrets } from "../security/redact.js";
import type { AbortReason } from "./backlog-analysis-executor.js";

export const VERIFICATION_EXECUTOR_ID = "codeforge-claim-verifier/1";

export type WorkspaceFactory = (project: Project, revision: string, providers: SourceControlProviderRegistry, signal: AbortSignal) => Promise<RevisionWorkspace>;

export interface ClaimVerificationExecutorDeps {
  db: DatabaseSync;
  items: BacklogItemRepository;
  analyses: BacklogAnalysisRepository;
  projects: ProjectRepository;
  jobs: ClaimVerificationJobRepository;
  claimVerifications: ClaimVerificationRepository;
  events: BacklogEventRepository;
  sourceControlProviders: SourceControlProviderRegistry;
  /** Test seam only; production uses a throwaway checkout fetched by SHA. */
  workspaceFactory?: WorkspaceFactory;
  checkTimeoutMsOverride?: number;
  retryBaseDelayMs?: number;
}

const now = () => new Date().toISOString();

/**
 * Executes ONE claim-verification job inside the existing worker process. Every refusal (revoked access, superseded analysis,
 * revision/claim/check/fingerprint drift, unbound check) happens BEFORE any workspace is prepared or process spawned. The
 * job's terminal update and the append-only result are ONE transaction fenced by the claim: a worker whose lease was lost
 * writes nothing, so a result can never be recorded twice or by a stale owner.
 */
export class ClaimVerificationExecutor {
  constructor(private readonly deps: ClaimVerificationExecutorDeps) {}

  async execute(job: ClaimVerificationJob, signal: AbortSignal, abortReason: () => AbortReason | null): Promise<void> {
    const claim: JobClaim = { id: job.id, owner: job.claimOwner!, generation: job.lockGeneration };
    const { jobs } = this.deps;
    if (job.cancelRequestedAt) {
      jobs.finish(claim, "CANCELLED", "Cancelled by request.", now());
      return;
    }
    const invalid = this.validateBinding(job);
    if (invalid) {
      jobs.finish(claim, "FAILED", invalid, now());
      return;
    }
    const project = this.deps.projects.findById(job.projectId)!;
    const analysis = this.deps.analyses.findById(job.analysisId)!;

    const startedAt = now();
    let workspace: RevisionWorkspace | null = null;
    try {
      workspace = await (this.deps.workspaceFactory ?? ((p, r, s, sig) => prepareRevisionWorkspace(p, r, s, sig)))(project, job.revision, this.deps.sourceControlProviders, signal);
      const requirement = planVerification(analysis.result!.claims, project).find((r) => r.claimId === job.claimId && r.checkId === job.checkId)!;
      const dir = workspace.dir;
      const raw = await runClaimVerification({
        analysisId: analysis.id,
        project,
        requirements: [requirement],
        claims: analysis.result!.claims,
        revision: job.revision,
        workspacePath: dir,
        policy: HUMAN_REQUESTED_VERIFICATION,
        signal,
        requestedBy: job.requestedBy,
        fileExists: (f) => existsSync(join(dir, f)),
        checkTimeoutMsOverride: this.deps.checkTimeoutMsOverride,
      });
      const completedAt = now();
      const records: ClaimVerificationRecord[] = raw.map((r) => ({
        ...r,
        logExcerpt: r.logExcerpt === null ? null : redactSecrets(r.logExcerpt, process.env).slice(0, 2000),
        jobId: job.id,
        executor: VERIFICATION_EXECUTOR_ID,
        workspaceId: basename(dir),
        startedAt,
        completedAt,
        timedOut: r.state === "timed_out",
      }));
      const rec = records[0]!;
      const status = rec.state === "passed" ? "SUCCEEDED" : rec.state === "timed_out" ? "TIMED_OUT" : "FAILED";
      const reason = rec.state === "passed" ? null : `The check ${rec.state === "rejected" ? "was rejected before/while running" : rec.state.replace("_", " ")}.`;
      this.deps.db.exec("BEGIN IMMEDIATE");
      try {
        if (jobs.finish(claim, status, reason, completedAt)) {
          for (const r of records) this.deps.claimVerifications.insert(job.projectId, r);
          this.deps.events.append(job.projectId, job.backlogItemId, "CLAIM_VERIFICATION_RUN", { jobId: job.id, analysisId: analysis.id, revision: job.revision, checkId: job.checkId, claimId: job.claimId, state: rec.state }, completedAt);
        }
        this.deps.db.exec("COMMIT");
      } catch (err) {
        this.deps.db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      this.settleFailure(job, claim, err, signal, abortReason);
    } finally {
      await workspace?.dispose().catch(() => {});
    }
  }

  /** A job out of attempts whose lease lapsed (a crash loop) will not run again. */
  settleExhausted(job: ClaimVerificationJob): void {
    this.deps.jobs.finish({ id: job.id, owner: job.claimOwner!, generation: job.lockGeneration }, "FAILED", "The worker running this verification was lost and no attempts remain; no result was recorded.", now());
  }

  private settleFailure(job: ClaimVerificationJob, claim: JobClaim, err: unknown, signal: AbortSignal, abortReason: () => AbortReason | null): void {
    const { jobs } = this.deps;
    if (signal.aborted) {
      const reason = abortReason();
      if (reason === "cancel") jobs.finish(claim, "CANCELLED", "Cancelled by request.", now());
      else if (reason === "shutdown") jobs.release(claim, now());
      // lease_lost: another worker owns the job now — write nothing.
      return;
    }
    const message = redactSecrets(err instanceof Error ? err.message : String(err), process.env).slice(0, 500);
    if (job.attemptCount < job.maxAttempts) {
      const delay = Math.min((this.deps.retryBaseDelayMs ?? 5_000) * 2 ** (job.attemptCount - 1), 60_000);
      jobs.requeue(claim, new Date(Date.now() + delay).toISOString(), `Infrastructure error (will retry): ${message}`, now());
    } else {
      jobs.finish(claim, "FAILED", `Infrastructure error, no attempts left: ${message}`, now());
    }
  }

  /** Null if the job still binds; else why not. Nothing has been prepared or run at this point. */
  private validateBinding(job: ClaimVerificationJob): string | null {
    const item = this.deps.items.findById(job.backlogItemId);
    const project = this.deps.projects.findById(job.projectId);
    if (!item || !project || item.projectId !== project.id) return "The backlog item or project no longer exists.";
    if (project.ownerId !== job.requestedBy) return "The requester no longer has access to this project.";
    const analysis = this.deps.analyses.findById(job.analysisId);
    if (!analysis?.result || analysis.backlogItemId !== item.id) return "The analysis this verification was bound to is not available.";
    if (this.deps.analyses.findLatestSucceededForItem(item.id)?.id !== analysis.id) return "The analysis was superseded by a newer one; this result would not be about the current analysis.";
    const revision = analysis.platformChecks?.assessment?.reconciliation?.revision;
    if (!revision || revision !== job.revision) return "The analysed revision does not match the revision this verification was requested for.";
    const req = planVerification(analysis.result.claims, project).find((r) => r.claimId === job.claimId && r.claimIndex === job.claimIndex && r.checkId === job.checkId);
    if (!req) return "The claim is no longer bound to this approved check.";
    const check = (project.commands?.claimChecks ?? []).find((c) => c.id === job.checkId);
    if (!check || checkFingerprint(check) !== job.checkFingerprint) return "The approved check changed since this verification was requested.";
    return null;
  }
}
