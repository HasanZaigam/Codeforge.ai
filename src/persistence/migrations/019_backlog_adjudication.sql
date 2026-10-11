-- Phase 4B.1 — human ground-truth adjudication. Append-only: a judgment is NEVER updated in place and AI state is never
-- overwritten — it is a separate layer bound to the exact analysis and repository revision it was made against. A backlog
-- item or relationship re-analysed later gets NEW rows; the old ones stay valid history for the revision they name.
-- Concurrent reviewers judging the same target both land here — nothing is silently overwritten; "current" is simply the
-- most recent row for that target (see BacklogAdjudicationRepository).

CREATE TABLE IF NOT EXISTS backlog_relationship_judgments (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES backlog_relationships(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  to_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  analysis_id TEXT NOT NULL REFERENCES backlog_analyses(id),
  repository_revision TEXT,
  ai_confidence TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('CONFIRMED_DUPLICATE', 'RELATED_NOT_DUPLICATE', 'REJECTED')),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_relationship_judgments_rel ON backlog_relationship_judgments(relationship_id, created_at);
CREATE INDEX IF NOT EXISTS idx_backlog_relationship_judgments_project ON backlog_relationship_judgments(project_id);

CREATE TABLE IF NOT EXISTS backlog_review_judgments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id),
  analysis_id TEXT NOT NULL REFERENCES backlog_analyses(id),
  repository_revision TEXT,
  category TEXT NOT NULL CHECK (category IN ('CLARIFICATION', 'PROPOSAL_READINESS')),
  ai_review_state TEXT,
  label TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_review_judgments_item ON backlog_review_judgments(backlog_item_id, category, created_at);
CREATE INDEX IF NOT EXISTS idx_backlog_review_judgments_project ON backlog_review_judgments(project_id, category);
