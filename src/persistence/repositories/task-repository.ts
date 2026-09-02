import type { DatabaseSync } from "node:sqlite";
import type { Task, TaskRecord, TaskStatus } from "../../domain/types.js";

interface TaskRow {
  id: string;
  tenant_id: string;
  project_id: string;
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
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    status: row.status as TaskStatus,
    taskRecord: JSON.parse(row.task_record_json) as TaskRecord,
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
  };
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
          (id, tenant_id, project_id, title, goal, status, task_record_json,
           current_agent_run_id, workspace_id, lock_owner, lock_expires_at,
           created_by, created_at, updated_at, started_at, completed_at,
           cancel_requested_at, cancel_requested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.tenantId,
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
   * lease on it. Returns true iff this call won the claim.
   */
  claimTodo(id: string, ownerId: string, leaseMs: number, now: string): boolean {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'WORKING', lock_owner = ?, lock_expires_at = ?,
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND status = 'TODO'
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)`,
      )
      .run(ownerId, leaseExpires, now, now, id, now);
    return result.changes > 0;
  }

  /**
   * Atomically (re-)takes an execution lease on a task already in WORKING —
   * used to resume after a NEEDS_INPUT answer or to recover an orphaned
   * WORKING task after a crash (see recover() in the Orchestrator).
   */
  claimWorking(id: string, ownerId: string, leaseMs: number, now: string): boolean {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET lock_owner = ?, lock_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'WORKING'
           AND (lock_owner IS NULL OR lock_owner = ? OR lock_expires_at < ?)`,
      )
      .run(ownerId, leaseExpires, now, id, ownerId, now);
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
  claimReviewForHumanFeedback(id: string, ownerId: string, leaseMs: number, now: string): boolean {
    const leaseExpires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'WORKING', lock_owner = ?, lock_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'REVIEW'
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)`,
      )
      .run(ownerId, leaseExpires, now, id, now);
    return result.changes > 0;
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
   * Persists a full mutable-field update. Callers must have already computed
   * the new status via task-state-machine.transition() — this method does
   * not itself enforce transition legality.
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
}
