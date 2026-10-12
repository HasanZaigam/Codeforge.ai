import type { DatabaseSync } from "node:sqlite";
import type { BranchMode, Task, TaskRecord, TaskStatus } from "../../domain/types.js";

interface TaskRow {
  id: string;
  tenant_id: string;
  project_id: string;
  repository_id: string | null;
  title: string;
  goal: string;
  status: string;
  task_record_json: string;
  current_agent_run_id: string | null;
  workspace_id: string | null;
  lock_owner: string | null;
  lock_expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested_at: string | null;
  cancel_requested_by: string | null;
  branch_mode: string | null;
  working_branch: string | null;
  base_branch: string | null;
  lock_generation: number;
  next_review_check_at: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    title: row.title,
    goal: row.goal,
    status: row.status as TaskStatus,
    taskRecord: JSON.parse(row.task_record_json) as TaskRecord,
    // Absent/NULL on any row created before this column existed (or on the `006_branch_mode.sql`
    // column default for a pre-migration row's brief NULL window) — always "new", the only
    // behavior that existed before branch modes did. See /docs/TASK_LIFECYCLE.md "Branch modes".
    branchMode: (row.branch_mode as BranchMode | null) ?? "new",
    workingBranch: row.working_branch,
    baseBranch: row.base_branch,
    currentAgentRunId: row.current_agent_run_id,
    workspaceId: row.workspace_id,
    lockOwner: row.lock_owner,
    lockExpiresAt: row.lock_expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelRequestedAt: row.cancel_requested_at,
    cancelRequestedBy: row.cancel_requested_by,
    lockGeneration: row.lock_generation,
    nextReviewCheckAt: row.next_review_check_at,
  };
}

/**
 * True iff `err` is a node:sqlite UNIQUE constraint violation on
 * `idx_tasks_active_existing_branch` (see migrations/007_branch_race_closure.sql) — the DB-level
 * defense that closes TaskService.create's own check-then-insert race for "existing branch" mode.
 * node:sqlite reports this as a plain Error with `code === "ERR_SQLITE_ERROR"` and a message of the
 * exact shape `UNIQUE constraint failed: tasks.project_id, tasks.working_branch` — verified directly
 * against node:sqlite's actual runtime behavior (SQLite reports the conflicting table/columns, never
 * the index name itself). Matching on the specific columns (not just "any unique violation on
 * `tasks`") avoids ever misclassifying an unrelated future unique constraint on this table as a
 * branch collision.
 */
export function isActiveExistingBranchConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed:\s*tasks\.project_id,\s*(tasks\.repository_id,\s*)?tasks\.working_branch/i.test(err.message)
  );
}

/**
 * Task persistence + the atomic claim/lease mechanics that make concurrent
 * workers and crash-recovery safe (see /docs/TECHNICAL_DECISIONS.md TD-12
 * "idempotency boundaries"). Every claim is a single UPDATE with a WHERE
 * guard — never a read-then-write pair — so two workers racing on the same
 * task can never both believe they own it.
 */
export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks
          (id, tenant_id, project_id, repository_id, title, goal, status, task_record_json,
           current_agent_run_id, workspace_id, lock_owner, lock_expires_at,
           created_by, created_at, updated_at, started_at, completed_at,
           cancel_requested_at, cancel_requested_by, branch_mode, working_branch, base_branch)
         VALUES (?, ?, ?,
           COALESCE(?, (SELECT id FROM project_repos WHERE project_id = ? ORDER BY created_at, rowid LIMIT 1)),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.tenantId,
        task.projectId,
        task.repositoryId ?? null,
        task.projectId,
        task.title,
        task.goal,
        task.status,
        JSON.stringify(task.taskRecord),
        task.currentAgentRunId,
        task.workspaceId,
        task.lockOwner,
        task.lockExpiresAt,
        task.createdBy,
        task.createdAt,
        task.updatedAt,
        task.startedAt,
        task.completedAt,
        task.cancelRequestedAt,
        task.cancelRequestedBy,
        task.branchMode,
        task.workingBranch,
        task.baseBranch,
      );
  }

  findById(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listByProject(projectId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  listByStatus(status: TaskStatus): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC")
      .all(status) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Atomically transitions a TODO task to WORKING and takes an execution
   * lease on it. Every TODO task is, by construction, unowned (see
   * releaseFromBacklog/rowToTask — TODO never carries a live lock_owner
   * forward), so a winning claim here is always "unowned -> owned": the
   * lease-generation column always advances. Returns the resulting
   * lock_generation iff this call won the claim, else null — this IS the
   * execution's ownership identity for everything it does afterward (see
   * /docs/TASK_LIFECYCLE.md "Worker concurrency and lease loss").
   */
  claimTodo(id: string, ownerId: string, leaseMs: number, now: string): number | null {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const row = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'WORKING', lock_owner = ?, lock_expires_at = ?,
             started_at = COALESCE(started_at, ?), updated_at = ?,
             lock_generation = lock_generation + 1
         WHERE id = ? AND status = 'TODO'
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)
         RETURNING lock_generation`,
      )
      .get(ownerId, leaseExpires, now, now, id, now) as { lock_generation: number } | undefined;
    return row ? row.lock_generation : null;
  }

  /**
   * Atomically transitions a BACKLOG task to TODO — the release step a
   * human triggers explicitly (see TaskService.startTask / POST
   * /tasks/:taskId/start). No execution lease is taken here: TODO isn't
   * "in progress," it's just now eligible for the worker's normal
   * claimTodo. A single UPDATE with a WHERE guard, mirroring claimTodo's own
   * concurrency-safety pattern, so two concurrent "Start Task" clicks (or
   * requests) can never both win — the second sees `changes === 0` and the
   * caller surfaces that as an InvalidTransitionError, never a silent
   * no-op.
   *
   * The `NOT EXISTS` clause is the authoritative dependency gate (see
   * /docs/TASK_LIFECYCLE.md "Task dependencies"): it re-evaluates every one of this task's
   * dependencies, in the SAME statement that flips status, so there is no window between "checked
   * dependencies" and "released" for a concurrent dependency edit (or a dependency's own status
   * change) to invalidate. Only a dependency whose task is DONE satisfies it — every other status
   * (BACKLOG/TODO/WORKING/NEEDS_INPUT/REVIEW/FAILED/CANCELLED) keeps the row unmatched. A task with
   * no dependency rows at all trivially passes (the NOT EXISTS finds nothing to object to). Returns
   * true iff THIS call performed the transition; false covers both "already left BACKLOG" and "at
   * least one dependency isn't DONE" — Orchestrator.startTask re-reads to tell the two apart and
   * report the right error.
   */
  releaseFromBacklog(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'TODO', updated_at = ?
         WHERE id = ? AND status = 'BACKLOG'
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies td
             JOIN tasks dep ON dep.id = td.depends_on_task_id
             WHERE td.task_id = tasks.id AND dep.status != 'DONE'
           )`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  /**
   * Atomically (re-)takes an execution lease on a task already in WORKING —
   * used to resume after a NEEDS_INPUT answer or to recover an orphaned
   * WORKING task after a crash (see recover() in the Orchestrator). This is
   * an OWNERSHIP ACQUISITION, not a renewal — see `renewWorkingLease` for
   * the narrower, generation-preserving operation a live execution's own
   * heartbeat uses instead. Every successful call here advances
   * lock_generation (whether taking over from a different/expired owner or
   * re-acquiring after this same task was previously released, e.g. a fresh
   * WORKING episode after a NEEDS_INPUT answer) — it always represents a new
   * execution beginning to drive this task, which is exactly the "unowned
   * (or stale) -> owned" case the generation exists to fence. Returns the
   * resulting lock_generation iff this call won the claim, else null.
   */
  claimWorking(id: string, ownerId: string, leaseMs: number, now: string): number | null {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const row = this.db
      .prepare(
        `UPDATE tasks
         SET lock_owner = ?, lock_expires_at = ?, updated_at = ?,
             lock_generation = lock_generation + 1
         WHERE id = ? AND status = 'WORKING'
           AND (lock_owner IS NULL OR lock_owner = ? OR lock_expires_at < ?)
         RETURNING lock_generation`,
      )
      .get(ownerId, leaseExpires, now, id, ownerId, now) as { lock_generation: number } | undefined;
    return row ? row.lock_generation : null;
  }

  /**
   * Renews the CURRENT owner's still-valid execution lease without
   * advancing lock_generation — the ONLY operation the lease-generation
   * design treats as "not a new ownership event." Used exclusively by
   * Orchestrator.withCancellation's heartbeat interval while a live
   * execution is genuinely still running (see its own doc comment). Unlike
   * `claimWorking`, this refuses to succeed for anyone but the exact
   * current `lock_owner` — it can never itself take over an expired or
   * differently-owned lease (that's `claimWorking`'s job), so it can never
   * accidentally paper over an actual takeover with a same-generation
   * renewal. Returns true iff this call renewed the lease.
   */
  renewWorkingLease(id: string, ownerId: string, leaseMs: number, now: string): boolean {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET lock_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'WORKING' AND lock_owner = ?`,
      )
      .run(leaseExpires, now, id, ownerId);
    return result.changes > 0;
  }

  /**
   * Atomically transitions a REVIEW task to WORKING and takes an execution
   * lease on it — the claim guard for the human review feedback loop (see
   * Orchestrator.checkHumanReviewFeedback). Mirrors claimTodo's pattern:
   * a single UPDATE with a WHERE guard, so two concurrent pollers (or
   * worker processes) racing on the same task's PR feedback can never both
   * win and both start a fix cycle. Returns true iff this call won the claim.
   */
  claimReviewForHumanFeedback(id: string, ownerId: string, leaseMs: number, now: string): number | null {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const row = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'WORKING', lock_owner = ?, lock_expires_at = ?, updated_at = ?,
             lock_generation = lock_generation + 1
         WHERE id = ? AND status = 'REVIEW'
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)
         RETURNING lock_generation`,
      )
      .get(ownerId, leaseExpires, now, id, now) as { lock_generation: number } | undefined;
    return row ? row.lock_generation : null;
  }

  /**
   * Releases the execution lease without changing status (step finished or
   * task paused) — owner-guarded: only clears the lease if `ownerId` is
   * still the current holder. Without this guard, a process that has
   * already lost its lease (see `claimWorking`, `LeaseLostError`) finishing
   * its own cleanup afterward would unconditionally null out whichever
   * *other* process's lease is now legitimately active, effectively
   * un-claiming a task out from under its real current owner. A mismatched
   * release is a safe, silent no-op — the real owner's lease is untouched.
   */
  releaseLock(id: string, ownerId: string, now: string): void {
    this.db
      .prepare("UPDATE tasks SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ? AND lock_owner = ?")
      .run(now, id, ownerId);
  }

  /**
   * Persists a full mutable-field update, UNCONDITIONALLY (no lease check).
   * Callers must have already computed the new status via
   * task-state-machine.transition() — this method does not itself enforce
   * transition legality. Reserved for call sites that legitimately don't
   * hold (or need) an execution lease — user-initiated commands like
   * submitHumanAnswer/acceptReview/requestChanges, and cancellation
   * finalization. Any write made ON BEHALF OF a live execution (inside
   * runWorkingEpisode / runHumanFeedbackFixCycle / runAgent and everything
   * they call) MUST use `saveOwned` instead — see its own doc comment for
   * why an unconditional save there would let a stale, lease-lost process
   * silently corrupt a newer owner's state.
   */
  save(task: Task, now: string): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, task_record_json = ?, current_agent_run_id = ?,
             workspace_id = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        task.status,
        JSON.stringify(task.taskRecord),
        task.currentAgentRunId,
        task.workspaceId,
        now,
        task.completedAt,
        task.id,
      );
  }

  /**
   * The generation-fenced counterpart to `save()` — every write an
   * in-flight execution makes on a task's behalf must go through this
   * method instead (see /docs/TASK_LIFECYCLE.md "Worker concurrency and
   * lease loss"). `generation` is the lock_generation this execution
   * captured when it won its claim (claimTodo/claimWorking/
   * claimReviewForHumanFeedback's return value) — the WHERE guard below
   * re-checks it against the row's CURRENT lock_generation at write time,
   * not a value read earlier, so there is no read-then-write gap for a
   * concurrent takeover to slip through. Returns false (and performs no
   * write) iff the generation no longer matches — i.e. this execution has
   * lost the lease to a newer owner; the caller (Orchestrator) treats that
   * as lease-lost, never as a reason to fail the task. Deliberately does
   * NOT touch lock_owner/lock_expires_at/lock_generation itself — those are
   * exclusively claimTodo/claimWorking/claimReviewForHumanFeedback/
   * renewWorkingLease/releaseLock's concern.
   */
  saveOwned(task: Task, generation: number, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, task_record_json = ?, current_agent_run_id = ?,
             workspace_id = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND lock_generation = ?`,
      )
      .run(
        task.status,
        JSON.stringify(task.taskRecord),
        task.currentAgentRunId,
        task.workspaceId,
        now,
        task.completedAt,
        task.id,
        generation,
      );
    return result.changes > 0;
  }

  /**
   * Atomically updates the editable configuration of a task still sitting in
   * BACKLOG — title/goal/branch selection only, never `status` or anything
   * else (see TaskService.editBacklogTask / POST /tasks/:taskId/edit and the
   * doc comment atop src/api/routes/tasks.ts on why this stays narrow). A
   * single UPDATE with a `WHERE status = 'BACKLOG'` guard, mirroring
   * `releaseFromBacklog`'s own concurrency-safety pattern, so an edit racing
   * against a concurrent "Start Task"/cancel can never silently apply to a
   * task that has already left BACKLOG. Returns true iff this call performed
   * the update.
   */
  updateBacklogConfig(
    id: string,
    fields: { title: string; goal: string; branchMode: BranchMode; workingBranch: string | null; baseBranch: string | null; repositoryId?: string | null },
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET title = ?, goal = ?, branch_mode = ?, working_branch = ?, base_branch = ?,
             repository_id = COALESCE(?, repository_id), updated_at = ?
         WHERE id = ? AND status = 'BACKLOG'`,
      )
      .run(fields.title, fields.goal, fields.branchMode, fields.workingBranch, fields.baseBranch, fields.repositoryId ?? null, now, id);
    return result.changes > 0;
  }

  /**
   * Non-terminal (not DONE/FAILED/CANCELLED) tasks in `projectId` already
   * working (branchMode "existing") directly on `branch` — the guard behind
   * rejecting a second concurrent "existing branch" task against the same
   * branch (see /docs/TASK_LIFECYCLE.md "Branch modes" and TaskService.create's
   * own doc comment on why this is a rejection, not a lock). A small,
   * project-scoped table scan is fine at this MVP's scale — see
   * /docs/MVP_SCOPE.md.
   */
  listActiveUsingExistingBranch(projectId: string, branch: string, repositoryId: string | null = null): Task[] {
    // Scoped to one repository (TD-62): the same branch name in two repositories is two different branches.
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE project_id = ? AND branch_mode = 'existing' AND working_branch = ?
           AND (? IS NULL OR repository_id IS ?)
           AND status NOT IN ('DONE', 'FAILED', 'CANCELLED')`,
      )
      .all(projectId, branch, repositoryId, repositoryId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Tasks whose lease has expired while still WORKING — candidates for crash recovery. */
  findOrphanedWorking(now: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'WORKING' AND lock_expires_at IS NOT NULL AND lock_expires_at < ?`,
      )
      .all(now) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  // ---------------------------------------------------------------------
  // Cancellation (see /docs/TASK_LIFECYCLE.md "Cancellation")
  // ---------------------------------------------------------------------

  /**
   * Cheap, frequent-safe read used by an in-flight execution's cancellation
   * watcher (Orchestrator.withCancellation) to notice a pending request
   * without re-reading/deserializing the whole task row.
   */
  isCancelRequested(id: string): boolean {
    const row = this.db.prepare("SELECT cancel_requested_at FROM tasks WHERE id = ?").get(id) as
      | { cancel_requested_at: string | null }
      | undefined;
    return !!row?.cancel_requested_at;
  }

  /**
   * Records cancellation intent on a WORKING task without changing its
   * status — the running execution (this process or another) is what
   * eventually transitions it to CANCELLED once it has actually stopped.
   * Returns true only if this call newly set the flag; false means either
   * it was already set (idempotent repeat request) or the task is no
   * longer WORKING (caller should re-read and retry against fresh state).
   */
  requestCancellationIntentOnWorking(id: string, requestedBy: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET cancel_requested_at = ?, cancel_requested_by = ?, updated_at = ?
         WHERE id = ? AND status = 'WORKING' AND cancel_requested_at IS NULL`,
      )
      .run(now, requestedBy, now, id);
    return result.changes > 0;
  }

  /** Atomically cancels a task that has no live execution to interrupt (nothing has started yet). */
  finalizeCancellationOnTodo(id: string, requestedBy: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'CANCELLED', cancel_requested_at = ?, cancel_requested_by = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'TODO'`,
      )
      .run(now, requestedBy, now, now, id);
    return result.changes > 0;
  }

  /**
   * Atomically cancels a task still sitting in BACKLOG — never released to
   * the worker, so there is nothing running anywhere to stop; identical
   * shape to finalizeCancellationOnTodo. See task-state-machine.ts's
   * TRANSITIONS comment for why BACKLOG is cancellable at all.
   */
  finalizeCancellationOnBacklog(id: string, requestedBy: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'CANCELLED', cancel_requested_at = ?, cancel_requested_by = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'BACKLOG'`,
      )
      .run(now, requestedBy, now, now, id);
    return result.changes > 0;
  }

  /** Atomically cancels a task paused on NEEDS_INPUT — no live execution is running while paused. */
  finalizeCancellationOnNeedsInput(id: string, requestedBy: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'CANCELLED', cancel_requested_at = ?, cancel_requested_by = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'NEEDS_INPUT'`,
      )
      .run(now, requestedBy, now, now, id);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------
  // PR merge sync (see /docs/TASK_LIFECYCLE.md "PR merge sync")
  // ---------------------------------------------------------------------

  /**
   * Atomically completes a REVIEW task whose Pull Request was found merged
   * on GitHub — the PR-merge-sync counterpart to a human clicking "Accept"
   * in the platform UI (see Orchestrator.acceptReview), except driven by
   * observing the PR's real remote state instead of an explicit in-app
   * action. A single UPDATE with a WHERE guard, the same pattern every other
   * claim/finalize method in this class already uses (`claimTodo`,
   * `claimReviewForHumanFeedback`, `finalizeCancellationOnTodo`, ...) — so
   * two concurrent pollers (or worker processes) that both observe the same
   * merged PR can never both "win" and duplicate the completion event; only
   * the first UPDATE actually matches `status = 'REVIEW'`, the second is a
   * harmless no-op. No lease/lock is taken here (unlike `claimWorking`):
   * unlike a fix cycle, there is no further work to protect from a second
   * process racing in mid-execution — this is a single terminal write.
   * Returns true iff THIS call performed the transition.
   */
  finalizeReviewAsDoneOnMerge(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'DONE', completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'REVIEW'`,
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------
  // REVIEW polling schedule (see /docs/TASK_LIFECYCLE.md "REVIEW polling" and
  // migrations/010_review_poll_scheduling.sql)
  // ---------------------------------------------------------------------

  /**
   * Atomically claims THIS cycle's GitHub refresh for a REVIEW task —
   * "who gets to make the read-only status/feedback call," not task
   * execution ownership (that stays entirely `claimReviewForHumanFeedback`'s
   * concern; this method never touches `status`/`lock_owner`/`lock_generation`).
   * A single UPDATE with a WHERE guard, mirroring every other claim method in
   * this class: the guard re-checks `next_review_check_at` against `now` in
   * the SAME statement that advances it to `nextCheckAt`, so two workers (or
   * two overlapping ticks) racing the same due task can never both win — the
   * loser's UPDATE simply matches zero rows, because the winner already
   * moved `next_review_check_at` into the future before the loser's
   * statement runs (SQLite serializes writers). `next_review_check_at IS
   * NULL` covers a REVIEW task that has never been checked yet (including
   * every pre-migration row) — always immediately due, matching the
   * pre-existing behavior of checking a REVIEW task's PR the first time a
   * worker sees it. Returns true iff THIS call won the claim; the caller
   * (Worker.tick) must skip calling Orchestrator.checkHumanReviewFeedback —
   * and therefore skip every GitHub call it would make — entirely when this
   * returns false.
   */
  claimReviewCheck(id: string, now: string, nextCheckAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET next_review_check_at = ?
         WHERE id = ? AND status = 'REVIEW'
           AND (next_review_check_at IS NULL OR next_review_check_at <= ?)`,
      )
      .run(nextCheckAt, id, now);
    return result.changes > 0;
  }

  /**
   * Pushes a REVIEW task's next due GitHub refresh further out than the
   * optimistic schedule `claimReviewCheck` already set — used only when a
   * refresh this process just won the claim for hit a `rate_limited`
   * classification whose own suggested wait (Retry-After / rate-limit
   * reset) is longer than the normal `REVIEW_POLL_INTERVAL_MS` cadence (see
   * Orchestrator.checkHumanReviewFeedback's catch blocks). Unconditional by
   * `id` — this process already legitimately won this cycle's claim moments
   * earlier, so there is no ownership race to guard against here the way
   * `claimReviewCheck`'s own WHERE clause must; worst case (task moved out
   * of REVIEW in between) is a harmless write to a column nothing currently
   * reads.
   */
  rescheduleReviewCheck(id: string, nextCheckAt: string): void {
    this.db.prepare(`UPDATE tasks SET next_review_check_at = ? WHERE id = ?`).run(nextCheckAt, id);
  }
}
