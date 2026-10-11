-- Phase 4D.6 — active uploaded bug sheet / import context on Chat conversations.
-- Remembers the active uploaded artifact / import for natural language queries like
-- "create tasks only for bugs with dev-status open" without replacing or clearing
-- active task context (`last_task_id` / `last_task_ids_json`).

ALTER TABLE chat_conversations ADD COLUMN active_import_id TEXT REFERENCES backlog_imports(id);
