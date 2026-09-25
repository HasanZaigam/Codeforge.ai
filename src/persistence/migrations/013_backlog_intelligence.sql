-- Phase 4A — Backlog Intelligence Foundation (see /docs/BACKLOG_INTELLIGENCE.md).
-- Purely additive: five new tables, no change to any existing table, so every project/task that
-- already exists is untouched.
--
-- Concepts (deliberately NOT collapsed into `tasks`):
--   backlog_items          "something the team wants CodeForge to understand"
--   backlog_analyses       one row per analysis attempt — the AI's structured PROPOSAL plus the
--                          platform's own checks of it; never authoritative state
--   backlog_relationships  duplicate / dependency PROPOSALS between two backlog items
--   task_proposals         the explicit human-approval boundary between an item and a real Task
--   backlog_events         append-only audit trail / observability (mirrors task_events)
--
-- Concurrency is enforced structurally here, not just in application code (this codebase's
-- "constraint is the backstop" posture — see 008_task_dependencies.sql / 011_project_workspace.sql):
--   * UNIQUE (project_id, external_ref COLLATE NOCASE) — a reference is unique within a project.
--   * At most ONE non-rejected task proposal per backlog item (partial unique index) — repeated or
--     racing proposal generation can never create two.
--   * UNIQUE task_proposals.task_id / reserved_task_id — one proposal maps to at most one Task, and
--     a Task id can be reserved by at most one proposal.

CREATE TABLE IF NOT EXISTS backlog_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  external_ref TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'import')),
  status TEXT NOT NULL CHECK (status IN ('NEW', 'ANALYZING', 'ANALYZED', 'NEEDS_CLARIFICATION', 'READY_FOR_TASK', 'CONVERTED', 'REJECTED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  -- Analysis claim (same lease/fencing idea as tasks.lock_owner/lock_generation): set when an
  -- analysis is claimed, checked when its result is recorded, so a stale analyzer whose lease
  -- expired can never overwrite a newer one's outcome.
  analysis_claim_id TEXT,
  analysis_lease_expires_at TEXT,
  -- The status the item had when analysis was claimed — where it returns to if the analysis is
  -- aborted by an infrastructure failure (never an invented status).
  status_before_analysis TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_items_project_ref
ON backlog_items(project_id, external_ref COLLATE NOCASE)
WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_backlog_items_project
ON backlog_items(project_id, created_at);

CREATE TABLE IF NOT EXISTS backlog_analyses (
  id TEXT PRIMARY KEY,
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure_category TEXT,
  failure_reason TEXT,
  result_json TEXT,
  platform_checks_json TEXT,
  diagnostics_json TEXT,
  model_id TEXT,
  provider_id TEXT,
  engine_key TEXT,
  fallback_index INTEGER NOT NULL DEFAULT 0,
  routing_reason TEXT,
  cost_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  -- A succeeded analysis must carry a result; a failed one must not.
  CHECK ((status = 'succeeded' AND result_json IS NOT NULL) OR (status = 'failed' AND result_json IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_backlog_analyses_item
ON backlog_analyses(backlog_item_id, completed_at);

CREATE TABLE IF NOT EXISTS backlog_relationships (
  -- Deterministic: a hash of (kind, from_item_id, to_item_id) — see BacklogRelationshipRepository.
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  to_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('POSSIBLE_DUPLICATE', 'DEPENDS_ON')),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'CONFIRMED', 'DISMISSED')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  rationale TEXT NOT NULL,
  analysis_id TEXT NOT NULL REFERENCES backlog_analyses(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, from_item_id, to_item_id),
  CHECK (from_item_id != to_item_id)
);

CREATE INDEX IF NOT EXISTS idx_backlog_relationships_to
ON backlog_relationships(to_item_id);

CREATE INDEX IF NOT EXISTS idx_backlog_relationships_from
ON backlog_relationships(from_item_id);

CREATE TABLE IF NOT EXISTS task_proposals (
  id TEXT PRIMARY KEY,
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_id TEXT NOT NULL REFERENCES backlog_analyses(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CONVERTING', 'CONVERTED', 'REJECTED')),
  content_json TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  -- Conversion claim: the Task id is RESERVED before the Task is created, so a crash between
  -- "created the Task" and "marked the proposal CONVERTED" is recoverable without ever creating a
  -- second Task (the retry finds the reserved id already exists and just finalizes).
  reserved_task_id TEXT,
  conversion_claim_id TEXT,
  conversion_lease_expires_at TEXT,
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One live-or-converted proposal per backlog item: a REJECTED one no longer counts, so a rejected
-- proposal can be regenerated, but two can never be pending/approved/converting/converted at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_proposals_one_live_per_item
ON task_proposals(backlog_item_id)
WHERE status IN ('PENDING', 'APPROVED', 'CONVERTING', 'CONVERTED');

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_proposals_task
ON task_proposals(task_id)
WHERE task_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_proposals_reserved_task
ON task_proposals(reserved_task_id)
WHERE reserved_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_proposals_project
ON task_proposals(project_id);

CREATE TABLE IF NOT EXISTS backlog_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backlog_events_item
ON backlog_events(backlog_item_id, created_at);
