import type { DatabaseSync } from "node:sqlite";
import type { ClaimVerificationJob, VerificationJobStatus } from "../../backlog/backlog-types.js";
import type { JobClaim } from "./backlog-analysis-job-repository.js";

interface Row {
  id: string; backlog_item_id: string; project_id: string; analysis_id: string; claim_id: string; claim_index: number;
  check_id: string; check_fingerprint: string; revision: string; status: string; requested_by: string;
  attempt_count: number; max_attempts: number; available_at: string; claim_owner: string | null; lease_expires_at: string | null;
  lock_generation: number; cancel_requested_at: string | null; failure_reason: string | null;
  created_at: string; started_at: string | null; completed_at: string | null; updated_at: string;
}

const toJob = (r: Row): ClaimVerificationJob => ({
  id: r.id, backlogItemId: r.backlog_item_id, projectId: r.project_id, analysisId: r.analysis_id, claimId: r.claim_id, claimIndex: r.claim_index,
  checkId: r.check_id, checkFingerprint: r.check_fingerprint, revision: r.revision, status: r.status as VerificationJobStatus, requestedBy: r.requested_by,
  attemptCount: r.attempt_count, maxAttempts: r.max_attempts, availableAt: r.available_at, claimOwner: r.claim_owner, leaseExpiresAt: r.lease_expires_at,
  lockGeneration: r.lock_generation, cancelRequestedAt: r.cancel_requested_at, failureReason: r.failure_reason,
  createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at, updatedAt: r.updated_at,
});

export type VerificationTerminal = "SUCCEEDED" | "FAILED" | "TIMED_OUT";

/**
 * Persistence for claim-verification JOBS — the same guarded-UPDATE discipline as BacklogAnalysisJobRepository: the claim and
 * its GLOBAL concurrency cap are one statement; every later write is fenced by (owner, lock_generation, status='RUNNING').
 * Enqueue is idempotent per (analysis, claim, check) while a job is live.
 */
export class ClaimVerificationJobRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Inserts a QUEUED job, or returns the live one for the same (analysis, claim, check). */
  enqueue(j: { id: string; backlogItemId: string; projectId: string; analysisId: string; claimId: string; claimIndex: number; checkId: string; checkFingerprint: string; revision: string; requestedBy: string; maxAttempts: number; now: string }): { job: ClaimVerificationJob; enqueued: boolean } {
    const live = this.findLive(j.analysisId, j.claimId, j.checkId);
    if (live) return { job: live, enqueued: false };
    try {
      this.db
        .prepare(
          `INSERT INTO claim_verification_jobs (id, backlog_item_id, project_id, analysis_id, claim_id, claim_index, check_id, check_fingerprint, revision, status, requested_by, attempt_count, max_attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, 0, ?, ?, ?, ?)`,
        )
        .run(j.id, j.backlogItemId, j.projectId, j.analysisId, j.claimId, j.claimIndex, j.checkId, j.checkFingerprint, j.revision, j.requestedBy, j.maxAttempts, j.now, j.now, j.now);
    } catch (err) {
      const raced = /UNIQUE constraint failed/i.test(String((err as Error).message)) ? this.findLive(j.analysisId, j.claimId, j.checkId) : null;
      if (raced) return { job: raced, enqueued: false };
      throw err;
    }
    return { job: this.findById(j.id)!, enqueued: true };
  }

  findById(id: string): ClaimVerificationJob | null {
    const r = this.db.prepare("SELECT * FROM claim_verification_jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  findLive(analysisId: string, claimId: string, checkId: string): ClaimVerificationJob | null {
    const r = this.db.prepare("SELECT * FROM claim_verification_jobs WHERE analysis_id = ? AND claim_id = ? AND check_id = ? AND status IN ('QUEUED','RUNNING') LIMIT 1").get(analysisId, claimId, checkId) as Row | undefined;
    return r ? toJob(r) : null;
  }

  listForItem(itemId: string): ClaimVerificationJob[] {
    return (this.db.prepare("SELECT * FROM claim_verification_jobs WHERE backlog_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(itemId) as unknown as Row[]).map(toJob);
  }

  countRunning(now: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM claim_verification_jobs WHERE status = 'RUNNING' AND lease_expires_at > ?").get(now) as { n: number }).n;
  }

  claimNext(owner: string, now: string, leaseExpiresAt: string, maxConcurrency: number): ClaimVerificationJob | null {
    if (this.countRunning(now) >= maxConcurrency) return null;
    const candidates = this.db
      .prepare(
        `SELECT id FROM claim_verification_jobs
         WHERE (status = 'QUEUED' AND available_at <= ?) OR (status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count < max_attempts)
         ORDER BY created_at ASC, rowid ASC LIMIT 5`,
      )
      .all(now, now) as Array<{ id: string }>;
    const claim = this.db.prepare(
      `UPDATE claim_verification_jobs
       SET status = 'RUNNING', claim_owner = ?, lease_expires_at = ?, lock_generation = lock_generation + 1,
           attempt_count = attempt_count + 1, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ?
         AND ((status = 'QUEUED' AND available_at <= ?) OR (status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count < max_attempts))
         AND (SELECT COUNT(*) FROM claim_verification_jobs r WHERE r.status = 'RUNNING' AND r.lease_expires_at > ? AND r.id != ?) < ?`,
    );
    for (const c of candidates) if (claim.run(owner, leaseExpiresAt, now, now, c.id, now, now, now, c.id, maxConcurrency).changes > 0) return this.findById(c.id);
    return null;
  }

  listOrphans(now: string): ClaimVerificationJob[] {
    return (this.db.prepare("SELECT * FROM claim_verification_jobs WHERE status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count >= max_attempts ORDER BY created_at ASC LIMIT 10").all(now) as unknown as Row[]).map(toJob);
  }

  takeOverOrphan(id: string, owner: string, now: string, leaseExpiresAt: string): ClaimVerificationJob | null {
    const r = this.db
      .prepare("UPDATE claim_verification_jobs SET claim_owner = ?, lease_expires_at = ?, lock_generation = lock_generation + 1, updated_at = ? WHERE id = ? AND status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count >= max_attempts")
      .run(owner, leaseExpiresAt, now, id, now);
    return r.changes > 0 ? this.findById(id) : null;
  }

  renewLease(claim: JobClaim, leaseExpiresAt: string, now: string): { ok: boolean; cancelRequested: boolean } {
    const r = this.db.prepare("UPDATE claim_verification_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?").run(leaseExpiresAt, now, claim.id, claim.owner, claim.generation);
    if (r.changes === 0) return { ok: false, cancelRequested: false };
    const row = this.db.prepare("SELECT cancel_requested_at FROM claim_verification_jobs WHERE id = ?").get(claim.id) as { cancel_requested_at: string | null };
    return { ok: true, cancelRequested: row.cancel_requested_at !== null };
  }

  /** RUNNING -> terminal, fenced. Returns false if the claim was lost (the caller must then record nothing). */
  finish(claim: JobClaim, status: VerificationTerminal | "CANCELLED", reason: string | null, now: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE claim_verification_jobs SET status = ?, failure_reason = ?, claim_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?`,
        )
        .run(status, reason, now, now, claim.id, claim.owner, claim.generation).changes > 0
    );
  }

  requeue(claim: JobClaim, availableAt: string, reason: string, now: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE claim_verification_jobs SET status = 'QUEUED', available_at = ?, failure_reason = ?, claim_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?`,
        )
        .run(availableAt, reason, now, claim.id, claim.owner, claim.generation).changes > 0
    );
  }

  /** Graceful shutdown: back to QUEUED, the attempt given back. Fenced. */
  release(claim: JobClaim, now: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE claim_verification_jobs SET status = 'QUEUED', available_at = ?, attempt_count = MAX(attempt_count - 1, 0), claim_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?`,
        )
        .run(now, now, claim.id, claim.owner, claim.generation).changes > 0
    );
  }

  cancelQueued(id: string, now: string): boolean {
    return this.db.prepare("UPDATE claim_verification_jobs SET status = 'CANCELLED', failure_reason = 'Cancelled before it started.', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'").run(now, now, id).changes > 0;
  }

  requestCancel(id: string, now: string): boolean {
    return this.db.prepare("UPDATE claim_verification_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(now, now, id).changes > 0;
  }
}
