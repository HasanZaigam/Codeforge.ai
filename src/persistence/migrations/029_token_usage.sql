-- Token usage visibility (TD-63).
--
-- Chat: what each assistant reply cost. `tokens` is NULL for user messages and for a reply whose model
-- call reported nothing and couldn't be estimated; 0 for a reply answered entirely from CodeForge's own
-- data with no model call. `tokens_estimated` = 1 when the number is a ~4-chars-per-token estimate.
ALTER TABLE chat_messages ADD COLUMN tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN tokens_estimated INTEGER NOT NULL DEFAULT 0;

-- Monthly token budgets (calendar month, UTC). NULL = no budget set. Display only: reaching a budget
-- warns, it never blocks work.
ALTER TABLE projects ADD COLUMN monthly_token_budget INTEGER;
ALTER TABLE users ADD COLUMN monthly_token_budget INTEGER;
