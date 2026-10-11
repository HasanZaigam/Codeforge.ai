import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BacklogRelationship, BacklogRelationshipKind, BacklogRelationshipStatus, ConfidenceLevel } from "../../backlog/backlog-types.js";

interface RelationshipRow {
  id: string;
  project_id: string;
  from_item_id: string;
  to_item_id: string;
  kind: string;
  status: string;
  confidence: string;
  rationale: string;
  analysis_id: string;
  created_at: string;
  updated_at: string;
}

function rowToRelationship(row: RelationshipRow): BacklogRelationship {
  return {
    id: row.id,
    projectId: row.project_id,
    fromItemId: row.from_item_id,
    toItemId: row.to_item_id,
    kind: row.kind as BacklogRelationshipKind,
    status: row.status as BacklogRelationshipStatus,
    confidence: row.confidence as ConfidenceLevel,
    rationale: row.rationale,
    analysisId: row.analysis_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Deterministic id: the same (kind, from, to) always maps to the same id, so a re-analysis that
 * re-proposes the same relationship addresses the same row instead of minting a new one. (Ids are
 * for stable references from the UI/API; the UNIQUE(kind, from, to) constraint is the actual
 * integrity backstop.)
 */
export function relationshipId(kind: BacklogRelationshipKind, fromItemId: string, toItemId: string): string {
  return createHash("sha256").update(`${kind}|${fromItemId}|${toItemId}`).digest("hex").slice(0, 32);
}

export interface RelationshipProposal {
  kind: BacklogRelationshipKind;
  toItemId: string;
  confidence: ConfidenceLevel;
  rationale: string;
}

/** Duplicate / dependency PROPOSALS. Nothing here ever merges, deletes, or reorders anything — it is data for a human. */
export class BacklogRelationshipRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Replaces `fromItemId`'s still-PROPOSED relationships with `proposals` (a re-analysis supersedes
   * its own earlier guesses) while leaving any relationship a human has since CONFIRMED/DISMISSED
   * alone. Call inside a transaction together with the analysis insert.
   */
  replaceProposed(projectId: string, fromItemId: string, analysisId: string, proposals: RelationshipProposal[], now: string): void {
    this.db.prepare("DELETE FROM backlog_relationships WHERE from_item_id = ? AND status = 'PROPOSED'").run(fromItemId);
    const insert = this.db.prepare(
      `INSERT INTO backlog_relationships (id, project_id, from_item_id, to_item_id, kind, status, confidence, rationale, analysis_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?)
       ON CONFLICT (kind, from_item_id, to_item_id) DO NOTHING`,
    );
    for (const p of proposals) {
      insert.run(relationshipId(p.kind, fromItemId, p.toItemId), projectId, fromItemId, p.toItemId, p.kind, p.confidence, p.rationale, analysisId, now, now);
    }
  }

  findById(id: string): BacklogRelationship | null {
    const row = this.db.prepare("SELECT * FROM backlog_relationships WHERE id = ?").get(id) as RelationshipRow | undefined;
    return row ? rowToRelationship(row) : null;
  }

  /** A HUMAN's decision on a proposal. Never merges, deletes or reorders anything. */
  setStatus(id: string, status: "CONFIRMED" | "DISMISSED", now: string): boolean {
    return this.db.prepare("UPDATE backlog_relationships SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id).changes > 0;
  }

  /** Every relationship of a project (both kinds, any status) — for group views. */
  listForProject(projectId: string): BacklogRelationship[] {
    return (this.db.prepare("SELECT * FROM backlog_relationships WHERE project_id = ? ORDER BY kind ASC, created_at ASC, id ASC").all(projectId) as unknown as RelationshipRow[]).map(rowToRelationship);
  }

  /** Relationships proposed BY this item's analysis. */
  listOutgoing(itemId: string): BacklogRelationship[] {
    const rows = this.db
      .prepare("SELECT * FROM backlog_relationships WHERE from_item_id = ? ORDER BY kind ASC, created_at ASC, id ASC")
      .all(itemId) as unknown as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  /** Relationships OTHER items' analyses proposed that point at this item. */
  listIncoming(itemId: string): BacklogRelationship[] {
    const rows = this.db
      .prepare("SELECT * FROM backlog_relationships WHERE to_item_id = ? ORDER BY kind ASC, created_at ASC, id ASC")
      .all(itemId) as unknown as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  /** Every live (not DISMISSED) edge of one kind in a project — the graph the cycle guard walks. */
  listLiveEdges(projectId: string, kind: BacklogRelationshipKind): Array<{ fromItemId: string; toItemId: string }> {
    const rows = this.db
      .prepare("SELECT from_item_id, to_item_id FROM backlog_relationships WHERE project_id = ? AND kind = ? AND status != 'DISMISSED'")
      .all(projectId, kind) as unknown as Array<{ from_item_id: string; to_item_id: string }>;
    return rows.map((r) => ({ fromItemId: r.from_item_id, toItemId: r.to_item_id }));
  }
}
