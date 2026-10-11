-- Phase 4C — Project-aware Chat (V1). A minimal durable conversation/message model, NOT a generic chat platform.
-- One conversation per (project, user) — V1 doesn't need multiple named threads. An uploaded file's raw bytes are
-- NEVER stored here, only bounded, non-secret metadata about it (filename/mime/size) — same posture as
-- backlog_imports, which deliberately never stores the raw CSV either. The actual durable result of a file
-- attachment is the ordinary backlog_imports/backlog_items/backlog_bulk_jobs rows it produces via the existing
-- import pipeline (see ChatService) — chat_messages.bulk_job_id just points at that for later "show suggestions".

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_project_user ON chat_conversations(project_id, created_by);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  attachment_filename TEXT,
  attachment_mime_type TEXT,
  attachment_byte_size INTEGER,
  -- Set on an assistant message that started a real bulk analysis run from an attachment — lets the UI later ask
  -- "show me the suggestions for that" without re-deriving which run a given message referred to.
  bulk_job_id TEXT REFERENCES backlog_bulk_jobs(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
