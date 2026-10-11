import type { DatabaseSync } from "node:sqlite";
import type { AiProviderId } from "./provider-connection-repository.js";

export type GlobalAiMode = "auto" | "fixed";

export interface GlobalAiConfigRecord {
  userId: string;
  mode: GlobalAiMode;
  fixedProvider: AiProviderId | null;
  fixedModel: string | null;
  /** `null` means "every currently connected provider" — see ModelGatewayService.resolveAutoAllowedProviders. */
  autoAllowedProviders: AiProviderId[] | null;
  updatedAt: string;
}

interface ConfigRow {
  user_id: string;
  mode: string;
  fixed_provider: string | null;
  fixed_model: string | null;
  auto_allowed_providers_json: string | null;
  updated_at: string;
}

function rowToRecord(row: ConfigRow): GlobalAiConfigRecord {
  return {
    userId: row.user_id,
    mode: row.mode as GlobalAiMode,
    fixedProvider: row.fixed_provider as AiProviderId | null,
    fixedModel: row.fixed_model,
    autoAllowedProviders: row.auto_allowed_providers_json ? (JSON.parse(row.auto_allowed_providers_json) as AiProviderId[]) : null,
    updatedAt: row.updated_at,
  };
}

/** Model Gateway — the user's Global AI Brain selection (Auto vs. Fixed). One row per user. */
export class GlobalAiConfigRepository {
  constructor(private readonly db: DatabaseSync) {}

  getByUser(userId: string): GlobalAiConfigRecord | null {
    const row = this.db.prepare("SELECT * FROM global_ai_configuration WHERE user_id = ?").get(userId) as ConfigRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  upsert(record: GlobalAiConfigRecord): void {
    const json = record.autoAllowedProviders ? JSON.stringify(record.autoAllowedProviders) : null;
    this.db
      .prepare(
        `INSERT INTO global_ai_configuration (user_id, mode, fixed_provider, fixed_model, auto_allowed_providers_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           mode = excluded.mode,
           fixed_provider = excluded.fixed_provider,
           fixed_model = excluded.fixed_model,
           auto_allowed_providers_json = excluded.auto_allowed_providers_json,
           updated_at = excluded.updated_at`,
      )
      .run(record.userId, record.mode, record.fixedProvider, record.fixedModel, json, record.updatedAt);
  }
}
