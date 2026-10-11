-- Phase 4A.6 — claim-bound verification runs as a durable WORKER JOB (GAP-033), not as a synchronous call.
-- One job = ONE approved check for ONE claim of ONE analysis at ONE exact revision. The reliability columns mirror
-- backlog_analysis_jobs (atomic guarded-UPDATE claim, lease + heartbeat, lock_generation fencing, cancel_requested_at polled on
-- heartbeat, bounded attempts): the SAME worker process drives both — there is no second worker.
--
-- Job status is about the EXECUTION; the verdict about the claim lives only in claim_verifications (append-only) and still
-- counts only while claim/check/fingerprint/revision all match (backlog/reconciliation.ts):
--   SUCCEEDED = the check ran at the exact revision and PASSED; FAILED = it ran and failed / was rejected / could not run;
--   TIMED_OUT = it exceeded its timeout; CANCELLED = a person cancelled it (no verdict is recorded).

CREATE TABLE IF NOT EXISTS claim_verification_jobs (
  id TEXT PRIMARY KEY,
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_id TEXT NOT NULL REFERENCES backlog_analyses(id),
  claim_id TEXT NOT NULL,
  claim_index INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  check_fingerprint TEXT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  available_at TEXT NOT NULL,
  claim_owner TEXT,
  lease_expires_at TEXT,
  lock_generation INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

-- Idempotent enqueue: at most one live job per (analysis, claim, check).
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_verification_jobs_one_live
ON claim_verification_jobs(analysis_id, claim_id, check_id)
WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_claim_verification_jobs_claimable ON claim_verification_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_claim_verification_jobs_item ON claim_verification_jobs(backlog_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claim_verification_jobs_project ON claim_verification_jobs(project_id);

-- Extra evidence on the append-only result: which job/worker/workspace produced it, when, and the bounded redacted output.
ALTER TABLE claim_verifications ADD COLUMN job_id TEXT;
ALTER TABLE claim_verifications ADD COLUMN executor TEXT;
ALTER TABLE claim_verifications ADD COLUMN workspace_id TEXT;
ALTER TABLE claim_verifications ADD COLUMN started_at TEXT;
ALTER TABLE claim_verifications ADD COLUMN completed_at TEXT;
ALTER TABLE claim_verifications ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_claim_verifications_job ON claim_verifications(job_id);
