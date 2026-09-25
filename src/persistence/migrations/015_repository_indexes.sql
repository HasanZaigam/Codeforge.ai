-- Phase 4A.3 — the persistent, revision-bound repository index (see /docs/BACKLOG_INTELLIGENCE.md
-- "Repository index"). Purely additive.
--
-- One row per (project, source, revision, schema version). The index is DERIVED from repository contents
-- by platform code (never written by a model) and is only ever used for the exact revision it was built
-- from: a lookup requires the current commit SHA, so a repository that moved on simply misses the cache
-- and a new row is built — an old row is never treated as current.
--
-- `source_key` is a hash of the project's repository URL + branch, so a project whose repository was
-- re-pointed cannot reuse an index built for the old one. `project_id` scopes every lookup: two projects
-- never share a row even when they name the same repository.
--
-- Build coordination (no indexing storm, no second worker system): the row itself is the claim. A build
-- inserts a BUILDING row with a short lease; any other worker that finds a live BUILDING row does not
-- wait and does not build — its analysis simply proceeds without the index. An expired lease (a crashed
-- builder) or a FAILED row past its retry delay can be taken over.

CREATE TABLE IF NOT EXISTS repository_indexes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('BUILDING', 'READY', 'FAILED')),
  build_owner TEXT,
  build_expires_at TEXT,
  -- The index document (JSON). NULL until READY.
  index_json TEXT,
  file_count INTEGER,
  content_indexed_files INTEGER,
  symbol_count INTEGER,
  build_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_key, revision, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_repository_indexes_project ON repository_indexes(project_id, updated_at);
