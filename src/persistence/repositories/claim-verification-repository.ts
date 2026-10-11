import type { DatabaseSync } from "node:sqlite";
import type { ClaimVerificationRecord, VerificationState } from "../../backlog/backlog-types.js";

interface Row {
  id: string;
  analysis_id: string;
  claim_id: string;
  claim_index: number;
  check_id: string;
  check_fingerprint: string;
  revision: string;
  head_before: string | null;
  head_after: string | null;
  state: string;
  exit_code: number | null;
  duration_ms: number;
  command: string;
  log_excerpt: string | null;
  requested_by: string;
  created_at: string;
  job_id: string | null;
  executor: string | null;
  workspace_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  timed_out: number;
}

const toRecord = (r: Row): ClaimVerificationRecord => ({
  id: r.id,
  analysisId: r.analysis_id,
  claimId: r.claim_id,
  claimIndex: r.claim_index,
  checkId: r.check_id,
  checkFingerprint: r.check_fingerprint,
  revision: r.revision,
  headBefore: r.head_before,
  headAfter: r.head_after,
  state: r.state as VerificationState,
  exitCode: r.exit_code,
  durationMs: r.duration_ms,
  command: r.command,
  logExcerpt: r.log_excerpt,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  jobId: r.job_id,
  executor: r.executor,
  workspaceId: r.workspace_id,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  timedOut: r.timed_out === 1,
});

/** Append-only store of claim verification executions (migration 016). No update, no delete except with the project. */
export class ClaimVerificationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(projectId: string, r: ClaimVerificationRecord): void {
    this.db
      .prepare(
        `INSERT INTO claim_verifications
           (id, analysis_id, project_id, claim_id, claim_index, check_id, check_fingerprint, revision, head_before, head_after,
            state, exit_code, duration_ms, command, log_excerpt, requested_by, created_at,
            job_id, executor, workspace_id, started_at, completed_at, timed_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.analysisId, projectId, r.claimId, r.claimIndex, r.checkId, r.checkFingerprint, r.revision, r.headBefore, r.headAfter, r.state, r.exitCode, r.durationMs, r.command, r.logExcerpt, r.requestedBy, r.createdAt, r.jobId ?? null, r.executor ?? null, r.workspaceId ?? null, r.startedAt ?? null, r.completedAt ?? null, r.timedOut || r.state === "timed_out" ? 1 : 0);
  }

  listForJob(jobId: string): ClaimVerificationRecord[] {
    return (this.db.prepare("SELECT * FROM claim_verifications WHERE job_id = ? ORDER BY created_at ASC, rowid ASC").all(jobId) as unknown as Row[]).map(toRecord);
  }

  listForAnalysis(analysisId: string): ClaimVerificationRecord[] {
    return (this.db.prepare("SELECT * FROM claim_verifications WHERE analysis_id = ? ORDER BY created_at ASC, rowid ASC").all(analysisId) as unknown as Row[]).map(toRecord);
  }
}
