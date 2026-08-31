-- Real authentication (see /docs/AUTHENTICATION.md). Replaces the Step 3
-- placeholder "trust a client-supplied x-user-id header" seam.
--
-- No new table for password storage — `users` already exists and gains one
-- column. Sessions are a new table because they have their own lifecycle
-- (created at login, expire, are revoked at logout) independent of a user.
--
-- DEV RESET NOTE: any local .data/platform.sqlite created by Steps 1-5 only
-- ever contained the placeholder bootstrap "system" user (no real password,
-- unusable for login) — there is no real user data to migrate. Delete that
-- file and let the app recreate a fresh database; this is a documented
-- reset path, not silent data loss (see TECHNICAL_DECISIONS.md).

ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT '';

-- Nullable at the DB level (SQLite can't add a NOT NULL column with no
-- default to a non-empty table); enforced NOT NULL at the application layer
-- instead — ProjectService.create always sets it. Same pattern already used
-- for created_by on tasks.
ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
