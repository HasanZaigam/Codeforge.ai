-- V1.1 Slice 5 — Hybrid Model Routing / Provider Resilience / Usage foundation.
--
-- `provider_health` is a new table because it must coordinate ACROSS tasks and ACROSS worker
-- processes (this slice's brief, items 13/14: "the state must be persisted if it is intended to
-- coordinate workers") — an in-memory circuit breaker would be invisible to a second worker process
-- entirely, defeating the point. One row per providerId (e.g. "google", "openai"), never per model —
-- health is a property of the underlying provider/account, not of one model string. See
-- src/routing/provider-health-policy.ts for the (simple, deliberately not "distributed
-- production-grade") state machine this table records, and
-- src/persistence/repositories/provider-health-repository.ts for the single upsert this uses.
CREATE TABLE IF NOT EXISTS provider_health (
  provider_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TEXT,
  last_failure_category TEXT,
  cooldown_until TEXT,
  updated_at TEXT NOT NULL
);

-- `agent_runs` already persists one row per CodingEngine invocation (see migrations/001_init.sql) —
-- extending it with the platform's own routing decision (never the AI's) is the minimal-footprint
-- way to answer "which model/provider actually executed this attempt, and was it a fallback" (this
-- slice's brief, item 7: extend the existing attempt model rather than introducing a second one).
-- NULL for every row inserted before this slice, and for any row where no ModelRouter/ModelRegistry
-- selected a candidate at all (see domain/types.ts AgentRun.modelId's own doc comment) — never
-- backfilled or guessed.
ALTER TABLE agent_runs ADD COLUMN model_id TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_id TEXT;
ALTER TABLE agent_runs ADD COLUMN fallback_index INTEGER NOT NULL DEFAULT 0;
