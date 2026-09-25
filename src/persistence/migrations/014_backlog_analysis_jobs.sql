-- Phase 4A.1 — Backlog analysis moves out of the API process into the worker (see
-- /docs/BACKLOG_INTELLIGENCE.md "Analysis worker"). Purely additive.
--
-- Separation: a JOB is the unit of *work* (queued, claimed, leased, retried, cancelled); the
-- existing `backlog_analyses` row is the *result* (append-only history). A job points at its result
-- once terminal (`analysis_id`). Backlog analysis is deliberately NOT an `agent_runs` row: there is
-- no task, no workspace, no coding — it is a read-only model call.
--
-- Superseded: 013's `backlog_items.analysis_claim_id` / `analysis_lease_expires_at` (an item-level claim
-- that only fit analysis-inside-the-API-process) are no longer read or written; ownership, lease and
-- fencing now live on the job row. They are left in place (migrations are never edited or
-- destructively altered); `status_before_analysis` is still used.
--
-- Reliability primitives deliberately mirror task execution (see 005_concurrency.sql /
-- 009_lock_generation.sql): an atomic guarded-UPDATE claim, a lease renewed by heartbeat, and a
-- monotonically increasing `lock_generation` that fences every write a stale owner might still try.
--
-- Global concurrency cap: enforced INSIDE the claim statement (BacklogAnalysisJobRepository.
-- claimNext) by counting live RUNNING leases in the same UPDATE, so it holds across every worker
-- process sharing this database — SQLite serializes writers, so the count-then-update is atomic.
-- An expired lease does not count against the cap, so a crashed worker never holds a slot.

CREATE TABLE IF NOT EXISTS backlog_analysis_jobs (
  id TEXT PRIMARY KEY,
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  -- Claims so far (a claim after a crash counts too). Bounded by max_attempts, so a job that keeps
  -- killing its worker can never loop forever.
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  -- Earliest time a worker may claim a QUEUED job (backoff after a retryable failure).
  available_at TEXT NOT NULL,
  claim_owner TEXT,
  lease_expires_at TEXT,
  lock_generation INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  -- Most recent failure (a scheduled retry, or the terminal cause). Redacted + bounded upstream.
  failure_category TEXT,
  failure_reason TEXT,
  -- The platform's routing decision for the most recent attempt (observability during retries).
  model_id TEXT,
  provider_id TEXT,
  -- The result reference; set when the job reaches SUCCEEDED / FAILED / CANCELLED with a recorded analysis.
  analysis_id TEXT REFERENCES backlog_analyses(id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

-- At most ONE live (QUEUED/RUNNING) job per backlog item: repeated or racing enqueue can never
-- create a second, so a page refresh / double click / two processes cannot fan out model calls.
CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_analysis_jobs_one_active_per_item
ON backlog_analysis_jobs(backlog_item_id)
WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_backlog_analysis_jobs_claimable
ON backlog_analysis_jobs(status, available_at);

CREATE INDEX IF NOT EXISTS idx_backlog_analysis_jobs_item
ON backlog_analysis_jobs(backlog_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_backlog_analysis_jobs_project
ON backlog_analysis_jobs(project_id);
