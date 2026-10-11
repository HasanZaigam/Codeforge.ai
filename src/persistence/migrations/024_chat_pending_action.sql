-- Phase 4D.3 — bulk task actions from Chat need a two-step propose -> confirm -> execute flow (e.g.
-- "cancel all failed tasks" must show the exact target set before anything is mutated). This stores the
-- ONE pending bulk proposal a conversation is currently waiting on a yes/no reply to — never an arbitrary
-- queue, never executed speculatively. Single-task actions (start/cancel/rename/create) are unaffected:
-- they continue to execute directly on an unambiguous command, exactly as Phase 4D.2 left them.

ALTER TABLE chat_conversations ADD COLUMN pending_action_json TEXT;
