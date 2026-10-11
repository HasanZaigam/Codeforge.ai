-- Model Gateway — multi-provider AI connections + global AI brain config, scoped per account
-- (User.id, the "MVP access model is User -> owns -> Project" — see Project.ownerId's own doc
-- comment). Extends the existing V1.1 Slice 5 routing machinery (model_registry/provider_health/
-- agent_runs.model_id+provider_id, migration 012) rather than duplicating it: these two tables hold
-- WHICH providers a user has connected and HOW the global brain should be resolved; actual routing
-- still goes through the unchanged routing/model-router.ts selectModel() function.

-- One row per (user, provider) — reconnecting/rotating a key overwrites the existing row (upsert),
-- same posture as github_credentials (migration for Step 7). The API key is encrypted at rest with
-- the SAME AES-256-GCM utility (auth/credential-encryption.ts) GitHub tokens already use — never a
-- second crypto implementation.
CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL, -- 'google' | 'anthropic' | 'openai'
  model TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_auth_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected', -- 'connected' | 'disconnected' | 'error'
  last_verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider)
);

-- One row per user — the global AI brain selection. `fixed_provider`/`fixed_model` are only
-- meaningful when mode = 'fixed'; `auto_allowed_providers_json` is a JSON array of provider ids
-- Auto mode may use (defaults to every CONNECTED provider when null — see ModelGatewayService).
CREATE TABLE IF NOT EXISTS global_ai_configuration (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'fixed'
  fixed_provider TEXT,
  fixed_model TEXT,
  auto_allowed_providers_json TEXT,
  updated_at TEXT NOT NULL
);
