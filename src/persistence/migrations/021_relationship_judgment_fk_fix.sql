-- Phase 4B.3 — root-cause fix for a regression Phase 4B.1 introduced: `backlog_relationship_judgments.relationship_id` was
-- a hard foreign key to `backlog_relationships(id)`. `BacklogRelationshipRepository.replaceProposed` (pre-existing,
-- Phase 4A) DELETEs a still-PROPOSED relationship row whenever a re-analysis supersedes it — including re-proposing the
-- EXACT SAME (kind, from, to) edge under a new analysis id, which deletes-then-reinserts the row. Once a human had judged
-- that edge (Phase 4B.1), the DELETE failed with a raw SQLite FOREIGN KEY error, silently rolling back the ENTIRE
-- re-analysis transaction (the item never advanced past its old analysis).
--
-- The judgment table is a durable AUDIT LOG that must outlive the live proposal it was made against — Phase 4B.1's own
-- design already says a judgment "becomes STALE... never silently reattached", i.e. the live relationship can legitimately
-- disappear or change while the judgment stays valid history. Every judgment already denormalizes from_item_id, to_item_id,
-- analysis_id and ai_confidence, so it needs no enforced FK to remain a complete, self-sufficient record. Fix: rebuild the
-- table with `relationship_id` as a plain (unenforced, still indexed) reference instead of a blocking foreign key.

PRAGMA foreign_keys = OFF;

CREATE TABLE backlog_relationship_judgments_new (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
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

INSERT INTO backlog_relationship_judgments_new
  SELECT id, relationship_id, project_id, from_item_id, to_item_id, analysis_id, repository_revision, ai_confidence, label, reviewer_id, note, created_at
  FROM backlog_relationship_judgments;

DROP TABLE backlog_relationship_judgments;
ALTER TABLE backlog_relationship_judgments_new RENAME TO backlog_relationship_judgments;

CREATE INDEX IF NOT EXISTS idx_backlog_relationship_judgments_rel ON backlog_relationship_judgments(relationship_id, created_at);
CREATE INDEX IF NOT EXISTS idx_backlog_relationship_judgments_project ON backlog_relationship_judgments(project_id);

PRAGMA foreign_keys = ON;
