-- Phase 4A.5 — claim-bound verification (GAP-033). Append-only record of ONE execution of ONE approved check for ONE claim at
-- ONE revision. A record only counts as evidence while (claim_id, check_id, check_fingerprint, revision) all still match the
-- analysis and the project's current check definition (see backlog/reconciliation.ts) — so a stale result, a result for a
-- different claim, or a result for a check whose definition later changed can never verify anything.
--
-- `command` is the exact command that ran, copied from the project's own approved check (never from a claim or a model).
-- `head_before`/`head_after` are the workspace's commit read via git BEFORE and AFTER the run: both must equal `revision`.

CREATE TABLE IF NOT EXISTS claim_verifications (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES backlog_analyses(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  claim_id TEXT NOT NULL,
  claim_index INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  check_fingerprint TEXT NOT NULL,
  revision TEXT NOT NULL,
  head_before TEXT,
  head_after TEXT,
  state TEXT NOT NULL CHECK (state IN ('passed', 'failed', 'timed_out', 'infrastructure_error', 'rejected')),
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  command TEXT NOT NULL,
  log_excerpt TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_verifications_analysis ON claim_verifications(analysis_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claim_verifications_project ON claim_verifications(project_id);
