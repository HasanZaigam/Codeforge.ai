-- Phase 4B.2 — a FROZEN baseline experiment snapshot. Immutable once written: nothing in this file's application code ever
-- UPDATEs a row here. A later measurement (more labels, a re-sample) creates a NEW row (see `version`), never rewrites this
-- one — "do not silently mutate the baseline when future labels are added" (Phase 4B.2 §15).

CREATE TABLE IF NOT EXISTS backlog_adjudication_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  seed TEXT NOT NULL,
  source_name TEXT,
  repository_revisions_json TEXT NOT NULL,
  models_json TEXT NOT NULL,
  -- The exact frozen sample (which groups/edges/items were in scope) and the metrics computed against exactly that sample
  -- at freeze time — never recomputed live, so the baseline reads the same way forever.
  sample_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  established INTEGER NOT NULL CHECK (established IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_adjudication_baselines_version ON backlog_adjudication_baselines(project_id, version);
CREATE INDEX IF NOT EXISTS idx_backlog_adjudication_baselines_project ON backlog_adjudication_baselines(project_id, created_at);
