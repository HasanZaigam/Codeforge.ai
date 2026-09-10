import type { DatabaseSync } from "node:sqlite";
import type { TaskStatus } from "../../domain/types.js";

/** One directed dependency edge: `taskId` depends on `dependsOnTaskId`. */
export interface DependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

/** A dependency, joined with the depended-on task's own current title/status — enough to render "Depends on: ..." / "Blocked by: ..." without a second round trip, and to build the Start Task error naming incomplete dependencies. */
export interface DependencyStatus {
  id: string;
  title: string;
  status: TaskStatus;
}

/**
 * True iff `err` is a node:sqlite UNIQUE constraint violation on
 * `task_dependencies`'s composite primary key (see migrations/008_task_dependencies.sql) — thrown
 * when `addIfBacklog` attempts to insert an edge that already exists. Mirrors
 * `isActiveExistingBranchConstraintViolation`'s own detection style exactly (see
 * task-repository.ts): match on the specific columns, never "any unique violation on this table."
 */
export function isDuplicateDependencyViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed:\s*task_dependencies\.task_id,\s*task_dependencies\.depends_on_task_id/i.test(err.message)
  );
}

/**
 * Persistence for explicit, user-defined task dependencies (see
 * /docs/TASK_LIFECYCLE.md "Task dependencies"). Self-dependency and duplicate-edge rejection are
 * structural (a DB constraint — see the migration's own doc comment); same-project and
 * circular-dependency rejection are authoritative at the application layer (TaskService), which is
 * the only caller that has enough context (the full project's edge set) to check them. This
 * repository is intentionally dumb: it stores edges and answers small, indexed reads.
 */
export class TaskDependencyRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Atomically inserts one dependency edge, but only if `taskId` is still BACKLOG at the moment of
   * insert — an INSERT...SELECT...WHERE EXISTS guard, the same atomic-UPDATE-with-status-guard
   * pattern `TaskRepository.updateBacklogConfig` already uses, adapted to an INSERT (there is no
   * existing row to UPDATE). Returns true iff this call performed the insert; false means the task
   * had already left BACKLOG (caller re-reads to report TaskNotEditableError). Throws (propagates)
   * a UNIQUE constraint violation — see `isDuplicateDependencyViolation` — if the edge already
   * exists on a task that IS still BACKLOG; callers catch that and surface DuplicateDependencyError.
   */
  addIfBacklog(taskId: string, dependsOnTaskId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
         SELECT ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'BACKLOG')`,
      )
      .run(taskId, dependsOnTaskId, now, taskId);
    return result.changes > 0;
  }

  /**
   * Race-safe counterpart to `addIfBacklog`, used only by the standalone `POST
   * /tasks/:taskId/dependencies` endpoint (TaskService.addDependency), where the target task
   * already exists and so CAN already participate in a cycle — unlike the `addIfBacklog` call from
   * task creation, where a brand-new task can never be reachable by any existing edge (nothing can
   * depend on a task that didn't exist a moment ago), so no cycle check is needed there.
   *
   * Closes the cross-process TOCTOU in TaskService.addDependency: that method's own
   * `wouldCreateCycle` pre-check reads the project's edge set and validates acyclicity in
   * application code, then this repository performs the write — two separate steps, with a gap
   * between them. Two different platform processes (API/worker, each its own `node:sqlite`
   * connection over the same WAL-mode file — see persistence/db.ts) each individually validating
   * an edge that is acyclic in isolation could still jointly create a cycle if both writes land.
   * `TaskService.addDependency`'s own pre-check remains as a fast, friendly fail for the ordinary
   * (non-racing) case, but the actual guarantee now comes from THIS method: it folds the
   * BACKLOG-status guard, a fresh read of the project's dependency graph, and the cycle check
   * (a `WITH RECURSIVE` walk of `depends_on_task_id` edges starting at `dependsOnTaskId`, checking
   * whether `taskId` is reachable — the same "can dependsOnTaskId already reach taskId" semantics
   * `wouldCreateCycle` implements in JS) into ONE SQL statement — consistent with this codebase's
   * established "single SQL statement with a WHERE guard" atomicity pattern (see db.ts's own doc
   * comment) rather than introducing an explicit multi-statement `BEGIN`/`COMMIT` transaction. SQLite
   * only ever allows one writer at a time, so this single statement sees a consistent snapshot and
   * commits atomically with respect to any other connection's write — there is no gap left to race.
   *
   * Returns "added" | "not-backlog" | "cycle". A UNIQUE-constraint violation (edge already exists)
   * is NOT swallowed here — it propagates, same as `addIfBacklog`, for the caller to classify via
   * `isDuplicateDependencyViolation`.
   */
  addIfBacklogAndAcyclic(taskId: string, dependsOnTaskId: string, now: string): "added" | "not-backlog" | "cycle" {
    const result = this.db
      .prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
         SELECT ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'BACKLOG')
           AND NOT EXISTS (
             WITH RECURSIVE reachable(id) AS (
               SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
               UNION
               SELECT td.depends_on_task_id FROM task_dependencies td
               JOIN reachable r ON td.task_id = r.id
             )
             SELECT 1 FROM reachable WHERE id = ?
           )`,
      )
      .run(taskId, dependsOnTaskId, now, taskId, dependsOnTaskId, taskId);
    if (result.changes > 0) return "added";
    // The single guard above can reject for either reason (no longer BACKLOG, or would-be-cyclic) —
    // this second, cheap read only classifies WHICH one for the caller's error message; it plays no
    // role in the actual atomicity guarantee above (that's already fully decided by the INSERT).
    const stillBacklog = this.db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND status = 'BACKLOG'`).get(taskId);
    return stillBacklog ? "cycle" : "not-backlog";
  }

  /**
   * Atomically removes one dependency edge, but only if `taskId` is still BACKLOG — mirrors
   * `addIfBacklog`'s own guard. Returns true iff a row was actually deleted; false covers both "the
   * task already left BACKLOG" and "no such edge exists" (an idempotent no-op for the latter — the
   * caller re-reads task status to tell the two apart).
   */
  removeIfBacklog(taskId: string, dependsOnTaskId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM task_dependencies
         WHERE task_id = ? AND depends_on_task_id = ?
           AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'BACKLOG')`,
      )
      .run(taskId, dependsOnTaskId, taskId);
    return result.changes > 0;
  }

  /** This task's dependencies (what it depends on), joined with each dependency's own current title/status, oldest-added first. */
  listDependencies(taskId: string): DependencyStatus[] {
    const rows = this.db
      .prepare(
        `SELECT dep.id AS id, dep.title AS title, dep.status AS status
         FROM task_dependencies td
         JOIN tasks dep ON dep.id = td.depends_on_task_id
         WHERE td.task_id = ?
         ORDER BY td.created_at ASC`,
      )
      .all(taskId) as unknown as DependencyStatus[];
    return rows;
  }

  /**
   * Every dependency edge among tasks in `projectId` — a small, project-scoped table scan, the same
   * "fine at this MVP's scale" tradeoff `TaskRepository.listActiveUsingExistingBranch` already
   * makes. The authoritative input to TaskService's circular-dependency check (see
   * /docs/TASK_LIFECYCLE.md "Task dependencies" — "Circular dependency" rule): dependencies are only
   * ever created between two tasks in the same project (enforced at write time), so scoping the
   * traversal to one project's edges is always complete, never a partial graph.
   */
  listEdgesForProject(projectId: string): DependencyEdge[] {
    const rows = this.db
      .prepare(
        `SELECT td.task_id AS task_id, td.depends_on_task_id AS depends_on_task_id
         FROM task_dependencies td
         JOIN tasks t ON t.id = td.task_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as unknown as { task_id: string; depends_on_task_id: string }[];
    return rows.map((r) => ({ taskId: r.task_id, dependsOnTaskId: r.depends_on_task_id }));
  }
}
