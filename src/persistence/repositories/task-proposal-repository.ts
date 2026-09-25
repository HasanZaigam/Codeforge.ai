import type { DatabaseSync } from "node:sqlite";
import type { TaskProposal, TaskProposalContent, TaskProposalStatus } from "../../backlog/backlog-types.js";
import { TaskProposalContentSchema } from "../../backlog/analysis-schema.js";
import { proposalStatusesAllowing } from "../../backlog/backlog-state-machine.js";

interface TaskProposalRow {
  id: string;
  backlog_item_id: string;
  project_id: string;
  analysis_id: string;
  status: string;
  content_json: string;
  decided_by: string | null;
  decided_at: string | null;
  reserved_task_id: string | null;
  conversion_claim_id: string | null;
  conversion_lease_expires_at: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseContent(json: string): TaskProposalContent | null {
  try {
    const parsed = TaskProposalContentSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowToProposal(row: TaskProposalRow): TaskProposal {
  return {
    id: row.id,
    backlogItemId: row.backlog_item_id,
    projectId: row.project_id,
    analysisId: row.analysis_id,
    status: row.status as TaskProposalStatus,
    content: parseContent(row.content_json),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True iff `err` is the "one live proposal per backlog item" unique-index violation (see migrations/013). */
export function isLiveProposalViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed:\s*task_proposals\.backlog_item_id/i.test(err.message)
  );
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Persistence for `TaskProposal` — the approval boundary. Every transition is one guarded UPDATE
 * whose allowed-from set comes from backlog-state-machine.ts's PROPOSAL_TRANSITIONS. There is
 * deliberately no method here that takes a status as a parameter: a caller cannot ask this class to
 * "set the status to X" — only to attempt a named transition, which the table may refuse.
 */
export class TaskProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Inserts a PENDING proposal. Throws (propagates) the unique violation if the item already has a live one. */
  insertPending(p: { id: string; backlogItemId: string; projectId: string; analysisId: string; content: TaskProposalContent; now: string }): void {
    this.db
      .prepare(
        `INSERT INTO task_proposals (id, backlog_item_id, project_id, analysis_id, status, content_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(p.id, p.backlogItemId, p.projectId, p.analysisId, JSON.stringify(p.content), p.now, p.now);
  }

  findById(id: string): TaskProposal | null {
    const row = this.db.prepare("SELECT * FROM task_proposals WHERE id = ?").get(id) as TaskProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  /** The item's pending/approved/converting/converted proposal, if any (at most one — see the partial unique index). */
  findLiveForItem(backlogItemId: string): TaskProposal | null {
    const row = this.db
      .prepare("SELECT * FROM task_proposals WHERE backlog_item_id = ? AND status IN ('PENDING','APPROVED','CONVERTING','CONVERTED') LIMIT 1")
      .get(backlogItemId) as TaskProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  /** The newest proposal of any status — what the UI shows when there is no live one (e.g. it was just rejected). */
  findLatestForItem(backlogItemId: string): TaskProposal | null {
    const row = this.db
      .prepare("SELECT * FROM task_proposals WHERE backlog_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(backlogItemId) as TaskProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  /** PENDING -> APPROVED. False if the proposal was not PENDING at the moment of the write. */
  approve(id: string, actorId: string, now: string): boolean {
    const from = proposalStatusesAllowing("approve");
    const result = this.db
      .prepare(`UPDATE task_proposals SET status = 'APPROVED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders(from.length)})`)
      .run(actorId, now, now, id, ...from);
    return result.changes > 0;
  }

  /** PENDING/APPROVED -> REJECTED. False if it was already CONVERTING/CONVERTED/REJECTED. */
  reject(id: string, actorId: string, now: string): boolean {
    const from = proposalStatusesAllowing("reject");
    const result = this.db
      .prepare(`UPDATE task_proposals SET status = 'REJECTED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders(from.length)})`)
      .run(actorId, now, now, id, ...from);
    return result.changes > 0;
  }

  /**
   * Atomically claims an APPROVED proposal for conversion (or re-claims a CONVERTING one whose
   * lease expired). Reserves the Task id on first claim and keeps it across re-claims, so a retry
   * after a crash targets the SAME task id. Two simultaneous conversions can never both claim.
   */
  claimConversion(id: string, claimId: string, reservedTaskId: string, now: string, leaseExpiresAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_proposals
         SET status = 'CONVERTING', conversion_claim_id = ?, conversion_lease_expires_at = ?,
             reserved_task_id = COALESCE(reserved_task_id, ?), updated_at = ?
         WHERE id = ?
           AND (status = 'APPROVED'
                OR (status = 'CONVERTING' AND conversion_lease_expires_at IS NOT NULL AND conversion_lease_expires_at <= ?))`,
      )
      .run(claimId, leaseExpiresAt, reservedTaskId, now, id, now);
    return result.changes > 0;
  }

  reservedTaskId(id: string): string | null {
    const row = this.db.prepare("SELECT reserved_task_id FROM task_proposals WHERE id = ?").get(id) as { reserved_task_id: string | null } | undefined;
    return row?.reserved_task_id ?? null;
  }

  /** CONVERTING -> CONVERTED, fenced by the claim. False if the claim was lost. */
  finalizeConversion(id: string, claimId: string, taskId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_proposals
         SET status = 'CONVERTED', task_id = ?, conversion_claim_id = NULL, conversion_lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'CONVERTING' AND conversion_claim_id = ?`,
      )
      .run(taskId, now, id, claimId);
    return result.changes > 0;
  }

  /** CONVERTING -> APPROVED after a failed task creation, fenced by the claim; the reserved task id is kept for the retry. */
  releaseConversion(id: string, claimId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_proposals
         SET status = 'APPROVED', conversion_claim_id = NULL, conversion_lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'CONVERTING' AND conversion_claim_id = ?`,
      )
      .run(now, id, claimId);
    return result.changes > 0;
  }
}
