-- Explicit, user-defined task dependencies (see /docs/TASK_LIFECYCLE.md "Task dependencies").
-- A normalized, directed-edge table: `task_id` depends on `depends_on_task_id`, AND semantics (a
-- task with multiple rows needs every one of them DONE before it may be released from BACKLOG).
-- No denormalized dependency list on `tasks` itself, no JSON field — a real relational table,
-- following this repo's existing naming/type conventions (TEXT ids, REFERENCES tasks(id), exactly
-- like `task_events.task_id`/`workspaces.task_id` in 001_init.sql).
--
-- Constraints enforced here, at the DB level, because they are a natural, non-fragile fit for
-- SQLite (see CLAUDE.md task brief):
--   - FKs on both task references (mirrors every other *_id column in this schema).
--   - The composite PRIMARY KEY makes a duplicate (task_id, depends_on_task_id) row structurally
--     impossible — the second INSERT fails with a UNIQUE constraint violation rather than silently
--     duplicating the edge (see isDuplicateDependencyViolation in task-dependency-repository.ts).
--   - The CHECK constraint makes a self-dependency row structurally impossible too — a single,
--     cheap, always-true predicate, unlike same-project or circular-dependency enforcement, which
--     both require reasoning about *other* rows (a join / full-graph traversal) and are therefore
--     deliberately NOT forced into a DB constraint here — those stay authoritative at the
--     application layer (TaskService), exactly as CLAUDE.md's task brief directs.
--
-- Indexes: `task_id` is covered by the PRIMARY KEY itself (its leading column); `depends_on_task_id`
-- gets its own index so "which tasks depend on this one" (used when a dependency's status changes,
-- and for cascading lookups) is an indexed lookup, not a table scan.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
