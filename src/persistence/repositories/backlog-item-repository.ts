import type { DatabaseSync } from "node:sqlite";
import type { BacklogItem, BacklogItemStatus, BacklogSource } from "../../backlog/backlog-types.js";
import { nextBacklogStatus, resolveAbortTarget, statusesAllowing, type BacklogTrigger } from "../../backlog/backlog-state-machine.js";

interface BacklogItemRow {
  id: string;
  project_id: string;
  external_ref: string | null;
  title: string;
  description: string;
  source: string;
  status: string;
  created_by: string;
  status_before_analysis: string | null;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: BacklogItemRow): BacklogItem {
  return {
    id: row.id,
    projectId: row.project_id,
    externalRef: row.external_ref,
    title: row.title,
    description: row.description,
    source: row.source as BacklogSource,
    status: row.status as BacklogItemStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * True iff `err` is the UNIQUE violation on `(project_id, external_ref COLLATE NOCASE)` — see
 * migrations/013_backlog_intelligence.sql. Same match-the-specific-columns style as
 * `isDuplicateDependencyViolation`.
 */
export function isDuplicateBacklogRefViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed:.*backlog_items\.project_id/i.test(err.message)
  );
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Persistence for `BacklogItem`. Intentionally dumb about authorization (BacklogService owns that),
 * but NOT dumb about state: every status change is a single guarded `UPDATE ... WHERE status IN
 * (...)` whose allowed-from set comes from backlog-state-machine.ts, so a concurrent writer (another
 * request, or another process sharing the SQLite file) can never push an item through an illegal
 * transition — the loser's UPDATE simply changes zero rows.
 */
export class BacklogItemRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(item: BacklogItem): void {
    this.db
      .prepare(
        `INSERT INTO backlog_items (id, project_id, external_ref, title, description, source, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.projectId, item.externalRef, item.title, item.description, item.source, item.status, item.createdBy, item.createdAt, item.updatedAt);
  }

  findById(id: string): BacklogItem | null {
    const row = this.db.prepare("SELECT * FROM backlog_items WHERE id = ?").get(id) as BacklogItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  /** Case-insensitive, matching the unique index. */
  findByProjectAndRef(projectId: string, ref: string): BacklogItem | null {
    const row = this.db
      .prepare("SELECT * FROM backlog_items WHERE project_id = ? AND external_ref = ? COLLATE NOCASE")
      .get(projectId, ref) as BacklogItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  /** Newest first. `limit` bounds the response; the API never returns an unbounded list. */
  listByProject(projectId: string, limit: number): BacklogItem[] {
    const rows = this.db
      .prepare("SELECT * FROM backlog_items WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(projectId, limit) as unknown as BacklogItemRow[];
    return rows.map(rowToItem);
  }

  /** Every item of a project except `excludeId` — the sibling pool for duplicate/dependency analysis and reference resolution. */
  listSiblings(projectId: string, excludeId: string): BacklogItem[] {
    const rows = this.db
      .prepare("SELECT * FROM backlog_items WHERE project_id = ? AND id != ? ORDER BY created_at DESC, id ASC")
      .all(projectId, excludeId) as unknown as BacklogItemRow[];
    return rows.map(rowToItem);
  }

  /**
   * Applies a user edit — only from a status that permits `content_edited`, and always resets the
   * item to NEW (any prior analysis described text that no longer exists). Returns false if the item
   * was in a status that forbids editing at the moment of the write (a racing analysis claim, a
   * proposal, a terminal state). Throws (propagates) the UNIQUE violation for a duplicate reference.
   */
  updateContent(id: string, content: { title: string; description: string; externalRef: string | null }, now: string): boolean {
    const from = statusesAllowing("content_edited");
    const result = this.db
      .prepare(
        `UPDATE backlog_items
         SET title = ?, description = ?, external_ref = ?, status = 'NEW',
             status_before_analysis = NULL, updated_at = ?
         WHERE id = ? AND status IN (${placeholders(from.length)})`,
      )
      .run(content.title, content.description, content.externalRef, now, id, ...from);
    return result.changes > 0;
  }

  /**
   * Marks an item ANALYZING (recording the status to return to) — the item-side half of enqueueing
   * an analysis job, done in the same transaction as the job insert. Allowed only from NEW /
   * NEEDS_CLARIFICATION / ANALYZED; returns false from anywhere else (an item already ANALYZING has
   * a live job — the caller answers idempotently; READY_FOR_TASK / CONVERTED / REJECTED are refused).
   */
  beginAnalysis(id: string, now: string): boolean {
    const from = statusesAllowing("analysis_requested");
    const result = this.db
      .prepare(
        `UPDATE backlog_items
         SET status_before_analysis = status, status = 'ANALYZING', updated_at = ?
         WHERE id = ? AND status IN (${placeholders(from.length)})`,
      )
      .run(now, id, ...from);
    return result.changes > 0;
  }

  /**
   * Moves ANALYZING -> ANALYZED / NEEDS_CLARIFICATION. Ownership is not checked HERE: the caller
   * (BacklogAnalysisExecutor) runs this in one transaction together with the job's fenced
   * `succeed`/`fail`, and that fence is what proves this worker still owns the analysis.
   */
  completeAnalysis(id: string, trigger: Extract<BacklogTrigger, "analysis_succeeded" | "analysis_needs_clarification">, now: string): boolean {
    const to = nextBacklogStatus("ANALYZING", trigger);
    const result = this.db
      .prepare("UPDATE backlog_items SET status = ?, status_before_analysis = NULL, updated_at = ? WHERE id = ? AND status = 'ANALYZING'")
      .run(to, now, id);
    return result.changes > 0;
  }

  /** Job failed/cancelled without a usable result: returns the item to the status it had before analysis (never an invented one). Same caller/fence contract as `completeAnalysis`. */
  abortAnalysis(id: string, now: string): boolean {
    const row = this.db.prepare("SELECT status_before_analysis FROM backlog_items WHERE id = ? AND status = 'ANALYZING'").get(id) as
      | { status_before_analysis: string | null }
      | undefined;
    if (!row) return false;
    const to = resolveAbortTarget(row.status_before_analysis as BacklogItemStatus | null);
    const result = this.db
      .prepare("UPDATE backlog_items SET status = ?, status_before_analysis = NULL, updated_at = ? WHERE id = ? AND status = 'ANALYZING'")
      .run(to, now, id);
    return result.changes > 0;
  }

  /**
   * Applies a NON-analysis trigger (`proposal_generated`, `proposal_rejected`, `converted`,
   * `rejected`) as one guarded UPDATE. The destination comes from the state machine, so this can
   * never write a status the table doesn't define. Returns false when the item was not in a status
   * that allows the trigger at the moment of the write.
   */
  transition(id: string, trigger: Exclude<BacklogTrigger, "analysis_requested" | "analysis_succeeded" | "analysis_needs_clarification" | "analysis_aborted" | "content_edited">, now: string): boolean {
    const from = statusesAllowing(trigger);
    const to = new Set(from.map((f) => nextBacklogStatus(f, trigger)));
    if (to.size !== 1) throw new Error(`transition("${trigger}") must have a single destination, found ${[...to].join(", ")}`);
    const result = this.db
      .prepare(`UPDATE backlog_items SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders(from.length)})`)
      .run([...to][0]!, now, id, ...from);
    return result.changes > 0;
  }
}
