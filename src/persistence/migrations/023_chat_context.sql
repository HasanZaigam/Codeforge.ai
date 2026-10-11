-- Phase 4D — Context Layer for Chat. Adds ONE small piece of durable state: which task a conversation
-- last discussed, so a pronoun follow-up ("what happened on it?", "continue that task") can resolve
-- without replaying the whole conversation transcript. Everything else the Context Layer returns is
-- derived live from existing Task/AgentRun/TaskEvent/ProjectContext records — nothing else is stored.

ALTER TABLE chat_conversations ADD COLUMN last_task_id TEXT REFERENCES tasks(id);
