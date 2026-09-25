import type { DatabaseSync } from "node:sqlite";
import type { ProviderHealth, ProviderHealthState } from "../../domain/types.js";

interface ProviderHealthRow {
  provider_id: string;
  state: string;
  consecutive_failures: number;
  last_failure_at: string | null;
  last_failure_category: string | null;
  cooldown_until: string | null;
  updated_at: string;
}

function rowToHealth(row: ProviderHealthRow): ProviderHealth {
  return {
    providerId: row.provider_id,
    state: row.state as ProviderHealthState,
    consecutiveFailures: row.consecutive_failures,
    lastFailureAt: row.last_failure_at,
    lastFailureCategory: row.last_failure_category,
    cooldownUntil: row.cooldown_until,
    updatedAt: row.updated_at,
  };
}

/**
 * Persisted, cross-task/cross-worker provider health (V1.1 Slice 5 — see
 * this slice's brief, items 13/14 and src/routing/provider-health-policy.ts
 * for the state-transition logic this repository stores the result of).
 * One row per `providerId`, upserted — never accumulated history; a
 * provider has exactly one current health state at a time.
 */
export class ProviderHealthRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(providerId: string): ProviderHealth | null {
    const row = this.db.prepare("SELECT * FROM provider_health WHERE provider_id = ?").get(providerId) as ProviderHealthRow | undefined;
    return row ? rowToHealth(row) : null;
  }

  /** Upserts the full row — callers always pass a complete ProviderHealth (see provider-health-policy.ts's derive* functions), never a partial patch, so there's no ambiguity about which fields a write is allowed to leave stale. */
  upsert(health: ProviderHealth): void {
    this.db
      .prepare(
        `INSERT INTO provider_health (provider_id, state, consecutive_failures, last_failure_at, last_failure_category, cooldown_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           state = excluded.state,
           consecutive_failures = excluded.consecutive_failures,
           last_failure_at = excluded.last_failure_at,
           last_failure_category = excluded.last_failure_category,
           cooldown_until = excluded.cooldown_until,
           updated_at = excluded.updated_at`,
      )
      .run(health.providerId, health.state, health.consecutiveFailures, health.lastFailureAt, health.lastFailureCategory, health.cooldownUntil, health.updatedAt);
  }

  list(): ProviderHealth[] {
    const rows = this.db.prepare("SELECT * FROM provider_health ORDER BY provider_id ASC").all() as unknown as ProviderHealthRow[];
    return rows.map(rowToHealth);
  }
}
