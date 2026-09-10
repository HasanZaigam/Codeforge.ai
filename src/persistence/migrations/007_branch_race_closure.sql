-- Closes the check-then-insert race window in TaskService.create's "existing branch" collision
-- check (see /docs/TASK_LIFECYCLE.md "Branch modes" and TaskRepository.listActiveUsingExistingBranch's
-- own doc comment, which named this exact gap: "a check-then-insert with a small race window, not a
-- DB-level constraint"). Mirrors 005_concurrency.sql's own pattern exactly: a real SQL unique
-- constraint as the actual defense, with the application-layer pre-check kept only as a fast,
-- friendly early rejection for the non-racing common case.
--
-- The predicate mirrors listActiveUsingExistingBranch's WHERE clause precisely: two non-terminal
-- (not DONE/FAILED/CANCELLED) tasks in the same project can never both hold branch_mode='existing'
-- with the same working_branch, even under a true concurrent-insert race — SQLite enforces this
-- index at the storage layer, so the second INSERT fails immediately with a UNIQUE constraint
-- violation instead of silently succeeding. TaskService.create (see isBranchUniqueConstraintViolation
-- in task-repository.ts) catches that violation and turns it into the same BranchInUseError the
-- pre-check already throws for the non-racing case — callers never see a raw SQLite error.
--
-- Backward compatible: every existing row already has branch_mode/working_branch/status populated
-- (branch_mode defaults to 'new' per 006_branch_mode.sql, so no pre-existing row can even match this
-- partial index's WHERE clause unless it was created in "existing" mode after 006 landed).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_existing_branch
  ON tasks(project_id, working_branch)
  WHERE branch_mode = 'existing' AND status NOT IN ('DONE', 'FAILED', 'CANCELLED');
