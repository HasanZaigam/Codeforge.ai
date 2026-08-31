-- Real GitHub integration (see /docs/GITHUB_INTEGRATION.md). One credential
-- per user (UNIQUE user_id) — connecting GitHub is an account-level action;
-- individual projects reference the same stored credential via their owner.
-- The token itself is never stored in plaintext — only AES-256-GCM
-- ciphertext plus the IV/auth tag needed to decrypt it (see
-- /docs/AUTHENTICATION.md-adjacent auth/credential-encryption.ts).

CREATE TABLE IF NOT EXISTS github_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  github_login TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

-- Non-secret repository identity — never a credential. Nullable: only
-- populated for sourceControlProvider = 'github' projects; local-git dev/test
-- projects leave both null and keep using repoUrl as a plain filesystem path.
ALTER TABLE projects ADD COLUMN owner TEXT;
ALTER TABLE projects ADD COLUMN repo TEXT;
