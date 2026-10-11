import type { DatabaseSync } from "node:sqlite";
import type { ClarificationLabel, ProposalReadinessLabel, ReviewJudgmentCategory } from "../../backlog/adjudication.js";
import type { ConfidenceLevel } from "../../backlog/backlog-types.js";

export interface RelationshipJudgmentRecord {
  id: string;
  relationshipId: string;
  projectId: string;
  fromItemId: string;
  toItemId: string;
  analysisId: string;
  revision: string | null;
  aiConfidence: ConfidenceLevel;
  label: "CONFIRMED_DUPLICATE" | "RELATED_NOT_DUPLICATE" | "REJECTED";
  reviewerId: string;
  note: string | null;
  createdAt: string;
}

export interface ItemJudgmentRecord {
  id: string;
  projectId: string;
  backlogItemId: string;
  analysisId: string;
  revision: string | null;
  category: ReviewJudgmentCategory;
  aiReviewState: string | null;
  label: ClarificationLabel | ProposalReadinessLabel;
  reviewerId: string;
  note: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

const toRel = (r: Row): RelationshipJudgmentRecord => ({
  id: r.id as string, relationshipId: r.relationship_id as string, projectId: r.project_id as string, fromItemId: r.from_item_id as string, toItemId: r.to_item_id as string,
  analysisId: r.analysis_id as string, revision: r.repository_revision as string | null, aiConfidence: r.ai_confidence as ConfidenceLevel, label: r.label as RelationshipJudgmentRecord["label"],
  reviewerId: r.reviewer_id as string, note: r.note as string | null, createdAt: r.created_at as string,
});

const toItem = (r: Row): ItemJudgmentRecord => ({
  id: r.id as string, projectId: r.project_id as string, backlogItemId: r.backlog_item_id as string, analysisId: r.analysis_id as string, revision: r.repository_revision as string | null,
  category: r.category as ReviewJudgmentCategory, aiReviewState: r.ai_review_state as string | null, label: r.label as ItemJudgmentRecord["label"], reviewerId: r.reviewer_id as string,
  note: r.note as string | null, createdAt: r.created_at as string,
});

/**
 * Append-only ground-truth judgments (migration 019). Every insert is a NEW row — a judgment is never updated in place, so
 * two reviewers (or the same reviewer twice) judging the same target never silently lose a prior judgment; `current*` picks
 * the most recent by (created_at, rowid) as a deterministic, documented tie-break, and every other call returns the full history.
 */
export class BacklogAdjudicationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertRelationshipJudgment(r: RelationshipJudgmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO backlog_relationship_judgments (id, relationship_id, project_id, from_item_id, to_item_id, analysis_id, repository_revision, ai_confidence, label, reviewer_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.relationshipId, r.projectId, r.fromItemId, r.toItemId, r.analysisId, r.revision, r.aiConfidence, r.label, r.reviewerId, r.note, r.createdAt);
  }

  listRelationshipJudgments(relationshipId: string): RelationshipJudgmentRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_relationship_judgments WHERE relationship_id = ? ORDER BY created_at ASC, rowid ASC").all(relationshipId) as Row[]).map(toRel);
  }

  currentRelationshipJudgment(relationshipId: string): RelationshipJudgmentRecord | null {
    const r = this.db.prepare("SELECT * FROM backlog_relationship_judgments WHERE relationship_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(relationshipId) as Row | undefined;
    return r ? toRel(r) : null;
  }

  /** The current judgment (if any) for every judged relationship of a project — for metrics/export. One row per relationship_id. */
  currentRelationshipJudgmentsForProject(projectId: string): RelationshipJudgmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM backlog_relationship_judgments j
         JOIN (SELECT relationship_id, MAX(created_at) AS mx, MAX(rowid) AS mr FROM backlog_relationship_judgments WHERE project_id = ? GROUP BY relationship_id) latest
           ON latest.relationship_id = j.relationship_id AND j.created_at = latest.mx AND j.rowid = latest.mr`,
      )
      .all(projectId) as Row[];
    return rows.map(toRel);
  }

  insertItemJudgment(r: ItemJudgmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO backlog_review_judgments (id, project_id, backlog_item_id, analysis_id, repository_revision, category, ai_review_state, label, reviewer_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.projectId, r.backlogItemId, r.analysisId, r.revision, r.category, r.aiReviewState, r.label, r.reviewerId, r.note, r.createdAt);
  }

  listItemJudgments(backlogItemId: string, category: ReviewJudgmentCategory): ItemJudgmentRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_review_judgments WHERE backlog_item_id = ? AND category = ? ORDER BY created_at ASC, rowid ASC").all(backlogItemId, category) as Row[]).map(toItem);
  }

  currentItemJudgment(backlogItemId: string, category: ReviewJudgmentCategory): ItemJudgmentRecord | null {
    const r = this.db.prepare("SELECT * FROM backlog_review_judgments WHERE backlog_item_id = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(backlogItemId, category) as Row | undefined;
    return r ? toItem(r) : null;
  }

  currentItemJudgmentsForProject(projectId: string, category: ReviewJudgmentCategory): ItemJudgmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM backlog_review_judgments j
         JOIN (SELECT backlog_item_id, MAX(created_at) AS mx, MAX(rowid) AS mr FROM backlog_review_judgments WHERE project_id = ? AND category = ? GROUP BY backlog_item_id) latest
           ON latest.backlog_item_id = j.backlog_item_id AND j.created_at = latest.mx AND j.rowid = latest.mr AND j.category = ?`,
      )
      .all(projectId, category, category) as Row[];
    return rows.map(toItem);
  }

  allCurrentForProject(projectId: string): { relationships: RelationshipJudgmentRecord[]; clarification: ItemJudgmentRecord[]; proposalReadiness: ItemJudgmentRecord[] } {
    return {
      relationships: this.currentRelationshipJudgmentsForProject(projectId),
      clarification: this.currentItemJudgmentsForProject(projectId, "CLARIFICATION"),
      proposalReadiness: this.currentItemJudgmentsForProject(projectId, "PROPOSAL_READINESS"),
    };
  }
}
