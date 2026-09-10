-- Task-creation branch-mode UX (see /docs/TASK_LIFECYCLE.md "Branch modes").
--
-- Backward compatible by construction: every existing row gets branch_mode = 'new' (the behavior
-- that always existed before this migration — an auto-derived, isolated per-task branch) and NULL
-- working_branch/base_branch, which the application layer already treats as "auto-derive"/"use the
-- project's default branch" respectively (see task-repository.ts rowToTask, orchestrator.ts
-- runWorkingEpisode). No backfill needed.
ALTER TABLE tasks ADD COLUMN branch_mode TEXT NOT NULL DEFAULT 'new';
ALTER TABLE tasks ADD COLUMN working_branch TEXT;
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
