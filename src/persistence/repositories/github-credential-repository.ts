import type { DatabaseSync } from "node:sqlite";
import type { EncryptedSecret } from "../../auth/credential-encryption.js";

export interface GitHubCredentialRecord {
  id: string;
  userId: string;
  githubLogin: string;
  secret: EncryptedSecret;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

interface CredentialRow {
  id: string;
  user_id: string;
  github_login: string;
  encrypted_token: string;
  iv: string;
  auth_tag: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

function rowToRecord(row: CredentialRow): GitHubCredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    githubLogin: row.github_login,
    secret: { ciphertext: row.encrypted_token, iv: row.iv, authTag: row.auth_tag },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * One GitHub credential per user (see /docs/GITHUB_INTEGRATION.md). Only
 * ever stores/returns ciphertext — encryption/decryption happens in
 * `auth/credential-encryption.ts`, called by `GitHubIntegrationService` and
 * `GitHubSourceControlProvider`, never here.
 */
export class GitHubCredentialRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert-or-replace — reconnecting overwrites the previous credential (see "Revocation behavior" in the docs). */
  upsert(record: GitHubCredentialRecord): void {
    const existing = this.findByUserId(record.userId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE github_credentials
           SET github_login = ?, encrypted_token = ?, iv = ?, auth_tag = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .run(record.githubLogin, record.secret.ciphertext, record.secret.iv, record.secret.authTag, record.updatedAt, record.userId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO github_credentials
          (id, user_id, github_login, encrypted_token, iv, auth_tag, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.userId,
        record.githubLogin,
        record.secret.ciphertext,
        record.secret.iv,
        record.secret.authTag,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
      );
  }

  findByUserId(userId: string): GitHubCredentialRecord | null {
    const row = this.db.prepare("SELECT * FROM github_credentials WHERE user_id = ?").get(userId) as CredentialRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  touch(userId: string, now: string): void {
    this.db.prepare("UPDATE github_credentials SET last_used_at = ? WHERE user_id = ?").run(now, userId);
  }

  /** Real revocation: the row is deleted, not just marked inactive — see /docs/GITHUB_INTEGRATION.md "Revocation behavior". */
  deleteByUserId(userId: string): void {
    this.db.prepare("DELETE FROM github_credentials WHERE user_id = ?").run(userId);
  }
}
