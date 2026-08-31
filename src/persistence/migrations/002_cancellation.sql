-- Adds the persisted cancellation-intent columns (see /docs/TASK_LIFECYCLE.md
-- "Cancellation" and TECHNICAL_DECISIONS.md). No new table: cancellation is
-- a property of an existing task, not a separate entity with its own
-- lifecycle. `cancel_requested_at`/`cancel_requested_by` are set exactly
-- once (while WORKING) and never cleared; `status='CANCELLED'` plus the
-- existing `completed_at` column record the terminal outcome.

ALTER TABLE tasks ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE tasks ADD COLUMN cancel_requested_by TEXT;
