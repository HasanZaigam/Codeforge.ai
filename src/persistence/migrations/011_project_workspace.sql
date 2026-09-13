-- Phase 3 — Project Workspace, Slice 1 (see /docs/ARCHITECTURE.md and the approved Phase 3
-- architecture audit). Introduces `project_workspaces`, a NEW first-class persistent domain
-- concept keyed by `project_id`, completely separate from the EXISTING task-execution `workspaces`
-- table (keyed by `task_id` — see migrations/001_init.sql/005_concurrency.sql/009_lock_generation.sql
-- and src/workspace/*), which this migration does not touch in any way. Relationship: one Project
-- has exactly one ProjectWorkspace, enforced at the DB level via UNIQUE(project_id) — the same
-- "constraint is the backstop, not a transaction" posture task_dependencies.sql already documents.
--
-- Backward compatible by construction: every project that already existed before this migration
-- shipped gets its ProjectWorkspace backfilled below (id/created_at/updated_at synthesized —
-- created_at/updated_at both copied from the owning project's own created_at, since no more
-- meaningful timestamp exists for a workspace that was never actually provisioned at creation
-- time). The guarded `WHERE NOT EXISTS` makes this INSERT...SELECT idempotent — re-running this
-- migration's SQL text against a DB that already has a project_workspaces row for a given project
-- inserts nothing further for it, so it can never create a duplicate row itself; the UNIQUE
-- constraint is the actual, structural backstop against any other path ever producing one.
CREATE TABLE IF NOT EXISTS project_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_workspaces_project
ON project_workspaces(project_id);

INSERT INTO project_workspaces (id, project_id, created_at, updated_at)
SELECT lower(hex(randomblob(16))), p.id, p.created_at, p.created_at
FROM projects p
WHERE NOT EXISTS (
  SELECT 1
  FROM project_workspaces pw
  WHERE pw.project_id = p.id
);
