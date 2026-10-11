-- Phase 4B — Bulk Backlog Intelligence. Additive only.
--   backlog_imports / backlog_import_rows  the import boundary: one row per source row, ACCEPTED or REJECTED with a reason. The raw file is
--                                          NOT stored (only its hash and the normalised, bounded fields), so a huge upload cannot bloat SQLite.
--   backlog_bulk_jobs / backlog_bulk_job_items  a DURABLE grouping of per-item analysis jobs. It owns no execution: each member is an ordinary
--                                          backlog_analysis_jobs row claimed by the existing worker under the existing global cap.
--   backlog_operation_events               operation-level audit (import created/completed, bulk started/cancelled, bulk actions) that has no
--                                          single backlog item; per-item audit stays in backlog_events.

CREATE TABLE IF NOT EXISTS backlog_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('csv')),
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED')),
  content_hash TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  accepted_rows INTEGER NOT NULL,
  rejected_rows INTEGER NOT NULL,
  already_imported_rows INTEGER NOT NULL DEFAULT 0,
  mapping_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_imports_project ON backlog_imports(project_id, created_at);

CREATE TABLE IF NOT EXISTS backlog_import_rows (
  import_id TEXT NOT NULL REFERENCES backlog_imports(id),
  row_number INTEGER NOT NULL,
  source_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED', 'ALREADY_IMPORTED')),
  reason TEXT,
  detail TEXT,
  backlog_item_id TEXT REFERENCES backlog_items(id),
  warnings_json TEXT NOT NULL,
  PRIMARY KEY (import_id, row_number)
);

ALTER TABLE backlog_items ADD COLUMN import_id TEXT;
ALTER TABLE backlog_items ADD COLUMN source_row INTEGER;
ALTER TABLE backlog_items ADD COLUMN metadata_json TEXT;
CREATE INDEX IF NOT EXISTS idx_backlog_items_import ON backlog_items(import_id);

CREATE TABLE IF NOT EXISTS backlog_bulk_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  import_id TEXT REFERENCES backlog_imports(id),
  total_items INTEGER NOT NULL,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_bulk_jobs_project ON backlog_bulk_jobs(project_id, created_at);

CREATE TABLE IF NOT EXISTS backlog_bulk_job_items (
  bulk_job_id TEXT NOT NULL REFERENCES backlog_bulk_jobs(id),
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  analysis_job_id TEXT REFERENCES backlog_analysis_jobs(id),
  -- QUEUED: enqueued by this bulk job. REUSED: the item already had a live job (not created by this bulk job). SKIPPED: not analysable now.
  disposition TEXT NOT NULL CHECK (disposition IN ('QUEUED', 'REUSED', 'SKIPPED')),
  reason TEXT,
  PRIMARY KEY (bulk_job_id, backlog_item_id)
);

CREATE TABLE IF NOT EXISTS backlog_operation_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('import', 'bulk_analysis', 'bulk_action')),
  operation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_operation_events_op ON backlog_operation_events(operation_kind, operation_id, created_at);
