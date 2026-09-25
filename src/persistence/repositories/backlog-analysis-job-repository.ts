import type { DatabaseSync } from "node:sqlite";
import type { AnalysisFailureCategory, AnalysisJobStatus, BacklogAnalysisJob } from "../../backlog/backlog-types.js";

interface JobRow {
  id: string;
  backlog_item_id: string;
  project_id: string;
  status: string;
  requested_by: string;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  claim_owner: string | null;
  lease_expires_at: string | null;
  lock_generation: number;
  cancel_requested_at: string | null;
  failure_category: string | null;
  failure_reason: string | null;
  model_id: string | null;
  provider_id: string | null;
  analysis_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function rowToJob(r: JobRow): BacklogAnalysisJob {
  return {
    id: r.id,
    backlogItemId: r.backlog_item_id,
    projectId: r.project_id,
    status: r.status as AnalysisJobStatus,
    requestedBy: r.requested_by,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    availableAt: r.available_at,
    claimOwner: r.claim_owner,
    leaseExpiresAt: r.lease_expires_at,
    lockGeneration: r.lock_generation,
    cancelRequestedAt: r.cancel_requested_at,
    failureCategory: r.failure_category as AnalysisFailureCategory | null,
    failureReason: r.failure_reason,
    modelId: r.model_id,
    providerId: r.provider_id,
    analysisId: r.analysis_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

/** True iff `err` is the "one live job per backlog item" unique-index violation (see migrations/014). */
export function isActiveJobViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed:\s*backlog_analysis_jobs\.backlog_item_id/i.test(err.message)
  );
}

/** Identifies one claim: every write a running worker makes is fenced by all three. */
export interface JobClaim {
  id: string;
  owner: string;
  generation: number;
}

export interface JobOutcomeRouting {
  modelId: string | null;
  providerId: string | null;
}

/**
 * Persistence for analysis JOBS. Every state change is one guarded `UPDATE`; there is no method that
 * accepts an arbitrary status. The claim is where the two reliability guarantees live:
 *
 *  1. **Exclusive ownership** — the winner of the guarded UPDATE gets a fresh `lock_generation`;
 *     every later write (`renewLease`, `succeed`, `fail`, `cancel`, `requeue`, `release`) must match
 *     `(owner, generation)` and `status = 'RUNNING'`, so a worker whose lease lapsed and was
 *     replaced can never overwrite the new owner's outcome (the same fencing task execution uses).
 *  2. **A global concurrency cap** — the claim counts live RUNNING leases in the SAME statement.
 */
export class BacklogAnalysisJobRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Inserts a QUEUED job. Throws (propagates) the unique violation if the item already has a live job. */
  enqueue(job: { id: string; backlogItemId: string; projectId: string; requestedBy: string; maxAttempts: number; now: string }): void {
    this.db
      .prepare(
        `INSERT INTO backlog_analysis_jobs (id, backlog_item_id, project_id, status, requested_by, attempt_count, max_attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, 'QUEUED', ?, 0, ?, ?, ?, ?)`,
      )
      .run(job.id, job.backlogItemId, job.projectId, job.requestedBy, job.maxAttempts, job.now, job.now, job.now);
  }

  findById(id: string): BacklogAnalysisJob | null {
    const row = this.db.prepare("SELECT * FROM backlog_analysis_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /** The item's QUEUED/RUNNING job, if any (at most one — see the partial unique index). */
  findActiveForItem(backlogItemId: string): BacklogAnalysisJob | null {
    const row = this.db
      .prepare("SELECT * FROM backlog_analysis_jobs WHERE backlog_item_id = ? AND status IN ('QUEUED','RUNNING') LIMIT 1")
      .get(backlogItemId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  findLatestForItem(backlogItemId: string): BacklogAnalysisJob | null {
    const row = this.db
      .prepare("SELECT * FROM backlog_analysis_jobs WHERE backlog_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(backlogItemId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /** Live (unexpired-lease) RUNNING jobs across every worker sharing this database. */
  countRunning(now: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM backlog_analysis_jobs WHERE status = 'RUNNING' AND lease_expires_at > ?").get(now) as { n: number }).n;
  }

  /**
   * Claims the oldest runnable job, or returns null (nothing runnable, or the global cap is full).
   * Runnable = QUEUED and due (`available_at <= now`), or RUNNING with an
   * EXPIRED lease that still has attempts left (crash recovery). Both the ownership grab and the cap
   * check are ONE guarded UPDATE:
   *
   *   ... AND (SELECT COUNT(*) FROM jobs WHERE status='RUNNING' AND lease live AND id != this) < cap
   *
   * SQLite serializes writers, so two workers (any process count) evaluating this concurrently
   * cannot both see room for the last slot. That is why the cap is GLOBAL rather than per-worker: with
   * three workers and cap 2 there are still never more than 2 live analyses.
   */
  claimNext(owner: string, now: string, leaseExpiresAt: string, maxConcurrency: number): BacklogAnalysisJob | null {
    if (this.countRunning(now) >= maxConcurrency) return null; // cheap early exit; the UPDATE below is the real guard
    const candidates = this.db
      .prepare(
        `SELECT id FROM backlog_analysis_jobs
         WHERE (status = 'QUEUED' AND available_at <= ? )
            OR (status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count < max_attempts)
         ORDER BY created_at ASC, rowid ASC
         LIMIT 5`,
      )
      .all(now, now) as Array<{ id: string }>;
    const claim = this.db.prepare(
      `UPDATE backlog_analysis_jobs
       SET status = 'RUNNING', claim_owner = ?, lease_expires_at = ?, lock_generation = lock_generation + 1,
           attempt_count = attempt_count + 1, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ?
         AND ((status = 'QUEUED' AND available_at <= ? )
              OR (status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count < max_attempts))
         AND (SELECT COUNT(*) FROM backlog_analysis_jobs r WHERE r.status = 'RUNNING' AND r.lease_expires_at > ? AND r.id != ?) < ?`,
    );
    for (const c of candidates) {
      if (claim.run(owner, leaseExpiresAt, now, now, c.id, now, now, now, c.id, maxConcurrency).changes > 0) return this.findById(c.id);
    }
    return null;
  }

  /**
   * Expired-lease RUNNING jobs that must NOT run again because they are out of attempts (a crash
   * loop). A worker takes each over (fenced like any claim) and settles it as FAILED. A
   * cancel-requested job needs no special claim rule: whoever claims it sees `cancelRequestedAt`
   * first thing and settles it as CANCELLED, so a cancel can never strand a job.
   */
  listOrphans(now: string): BacklogAnalysisJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM backlog_analysis_jobs
         WHERE status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count >= max_attempts
         ORDER BY created_at ASC, rowid ASC LIMIT 10`,
      )
      .all(now) as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  /** Fenced take-over of an orphan (does not consume an attempt). Null if someone else got it first. */
  takeOverOrphan(id: string, owner: string, now: string, leaseExpiresAt: string): BacklogAnalysisJob | null {
    const result = this.db
      .prepare(
        `UPDATE backlog_analysis_jobs
         SET claim_owner = ?, lease_expires_at = ?, lock_generation = lock_generation + 1, updated_at = ?
         WHERE id = ? AND status = 'RUNNING' AND lease_expires_at <= ? AND attempt_count >= max_attempts`,
      )
      .run(owner, leaseExpiresAt, now, id, now);
    return result.changes > 0 ? this.findById(id) : null;
  }

  /** Extends a live claim. `ok: false` means the claim was lost (replaced, or the job left RUNNING). `cancelRequested` is read in the same call so the heartbeat also polls for a user cancel. */
  renewLease(claim: JobClaim, leaseExpiresAt: string, now: string): { ok: boolean; cancelRequested: boolean } {
    const result = this.db
      .prepare("UPDATE backlog_analysis_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?")
      .run(leaseExpiresAt, now, claim.id, claim.owner, claim.generation);
    if (result.changes === 0) return { ok: false, cancelRequested: false };
    const row = this.db.prepare("SELECT cancel_requested_at FROM backlog_analysis_jobs WHERE id = ?").get(claim.id) as { cancel_requested_at: string | null };
    return { ok: true, cancelRequested: row.cancel_requested_at !== null };
  }

  /** RUNNING -> SUCCEEDED, fenced. `analysisId` is the recorded result. */
  succeed(claim: JobClaim, analysisId: string, routing: JobOutcomeRouting, now: string): boolean {
    return this.finish(claim, "SUCCEEDED", { analysisId, category: null, reason: null, routing }, now);
  }

  /** RUNNING -> FAILED, fenced. `analysisId` is the recorded failed-analysis row when one was written. */
  fail(claim: JobClaim, category: AnalysisFailureCategory, reason: string, analysisId: string | null, routing: JobOutcomeRouting, now: string): boolean {
    return this.finish(claim, "FAILED", { analysisId, category, reason, routing }, now);
  }

  /** RUNNING -> CANCELLED, fenced. */
  cancel(claim: JobClaim, analysisId: string | null, now: string): boolean {
    return this.finish(claim, "CANCELLED", { analysisId, category: "cancelled", reason: "Cancelled by request.", routing: { modelId: null, providerId: null } }, now);
  }

  private finish(
    claim: JobClaim,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    r: { analysisId: string | null; category: AnalysisFailureCategory | null; reason: string | null; routing: JobOutcomeRouting },
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE backlog_analysis_jobs
         SET status = ?, analysis_id = ?, failure_category = ?, failure_reason = ?, model_id = ?, provider_id = ?,
             claim_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?`,
      )
      .run(status, r.analysisId, r.category, r.reason, r.routing.modelId, r.routing.providerId, now, now, claim.id, claim.owner, claim.generation);
    return result.changes > 0;
  }

  /** RUNNING -> QUEUED with a backoff, keeping the attempt it consumed and recording why. Fenced. */
  requeue(claim: JobClaim, availableAt: string, category: AnalysisFailureCategory, reason: string, routing: JobOutcomeRouting, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE backlog_analysis_jobs
         SET status = 'QUEUED', available_at = ?, failure_category = ?, failure_reason = ?, model_id = ?, provider_id = ?,
             claim_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?`,
      )
      .run(availableAt, category, reason, routing.modelId, routing.providerId, now, claim.id, claim.owner, claim.generation);
    return result.changes > 0;
  }

  /** Graceful shutdown: RUNNING -> QUEUED immediately, and the attempt this run consumed is given back (the worker stopped, the job did not fail). Fenced. */
  release(claim: JobClaim, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE backlog_analysis_jobs
         SET status = 'QUEUED', available_at = ?, attempt_count = MAX(attempt_count - 1, 0),
             claim_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'RUNNING' AND claim_owner = ? AND lock_generation = ?`,
      )
      .run(now, now, claim.id, claim.owner, claim.generation);
    return result.changes > 0;
  }

  /** QUEUED -> CANCELLED (nothing ran, so nothing to fence). False if the job is no longer QUEUED. */
  cancelQueued(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE backlog_analysis_jobs
         SET status = 'CANCELLED', failure_category = 'cancelled', failure_reason = 'Cancelled before it started.', completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'QUEUED'`,
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  /** Asks the owning worker to stop a RUNNING job; it notices on its next heartbeat. False if the job is not RUNNING. */
  requestCancel(id: string, now: string): boolean {
    const result = this.db
      .prepare("UPDATE backlog_analysis_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ? AND status = 'RUNNING'")
      .run(now, now, id);
    return result.changes > 0;
  }
}
