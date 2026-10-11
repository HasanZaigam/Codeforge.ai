-- Phase 4D.5 — conversational task references ("that task", "the second one", "the oldest one") need
-- more than the single `last_task_id` column (migration 023) tracks: a message can display SEVERAL tasks
-- at once ("Show me Review tasks." -> 3 results), and a later ordinal/pronoun reference ("the second
-- one") must resolve against THAT ordered list, not just the single most-recently-discussed task. Stores
-- the ordered list of task ids the conversation most recently displayed — never an unbounded history,
-- always overwritten wholesale by the next list-producing read, never appended to.

ALTER TABLE chat_conversations ADD COLUMN last_task_ids_json TEXT;
