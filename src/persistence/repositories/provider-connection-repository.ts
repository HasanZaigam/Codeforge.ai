import type { DatabaseSync } from "node:sqlite";
import type { EncryptedSecret } from "../../auth/credential-encryption.js";

export type AiProviderId = "google" | "anthropic" | "openai";
export const AI_PROVIDER_IDS: AiProviderId[] = ["google", "anthropic", "openai"];
export type ProviderConnectionStatus = "connected" | "disconnected" | "error";

export interface ProviderConnectionRecord {
  id: string;
  userId: string;
  provider: AiProviderId;
  model: string;
  secret: EncryptedSecret;
  status: ProviderConnectionStatus;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  encrypted_api_key: string;
  api_key_iv: string;
  api_key_auth_tag: string;
  status: string;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ConnectionRow): ProviderConnectionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as AiProviderId,
    model: row.model,
    secret: { ciphertext: row.encrypted_api_key, iv: row.api_key_iv, authTag: row.api_key_auth_tag },
    status: row.status as ProviderConnectionStatus,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Model Gateway — one connected AI provider (Google/Anthropic/OpenAI) per (user, provider). Only
 * ever stores/returns ciphertext — encryption/decryption happens in `auth/credential-encryption.ts`,
 * called by `ModelGatewayService`, never here. Mirrors `GitHubCredentialRepository`'s exact shape.
 */
export class ProviderConnectionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert-or-replace — reconnecting/rotating a key overwrites the previous one for that (user, provider). */
  upsert(record: ProviderConnectionRecord): void {
    const existing = this.findByUserAndProvider(record.userId, record.provider);
    if (existing) {
      this.db
        .prepare(
          `UPDATE provider_connections
           SET model = ?, encrypted_api_key = ?, api_key_iv = ?, api_key_auth_tag = ?, status = ?, last_verified_at = ?, last_error = ?, updated_at = ?
           WHERE user_id = ? AND provider = ?`,
        )
        .run(
          record.model,
          record.secret.ciphertext,
          record.secret.iv,
          record.secret.authTag,
          record.status,
          record.lastVerifiedAt,
          record.lastError,
          record.updatedAt,
          record.userId,
          record.provider,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO provider_connections
          (id, user_id, provider, model, encrypted_api_key, api_key_iv, api_key_auth_tag, status, last_verified_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.userId,
        record.provider,
        record.model,
        record.secret.ciphertext,
        record.secret.iv,
        record.secret.authTag,
        record.status,
        record.lastVerifiedAt,
        record.lastError,
        record.createdAt,
        record.updatedAt,
      );
  }

  findByUserAndProvider(userId: string, provider: AiProviderId): ProviderConnectionRecord | null {
    const row = this.db.prepare("SELECT * FROM provider_connections WHERE user_id = ? AND provider = ?").get(userId, provider) as ConnectionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByUser(userId: string): ProviderConnectionRecord[] {
    const rows = this.db.prepare("SELECT * FROM provider_connections WHERE user_id = ? ORDER BY provider ASC").all(userId) as unknown as ConnectionRow[];
    return rows.map(rowToRecord);
  }

  /** Real deletion — not just marked inactive, same posture as `GitHubCredentialRepository.deleteByUserId`. */
  deleteByUserAndProvider(userId: string, provider: AiProviderId): void {
    this.db.prepare("DELETE FROM provider_connections WHERE user_id = ? AND provider = ?").run(userId, provider);
  }
}
