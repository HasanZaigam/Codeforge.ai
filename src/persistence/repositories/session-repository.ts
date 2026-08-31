import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../../domain/types.js";

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Server-side session records — see /docs/AUTHENTICATION.md. Never stores the raw browser-facing token, only its hash. */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(session: Session): void {
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt, session.lastSeenAt);
  }

  /** Returns the session only if it exists and hasn't expired — an expired row is treated the same as no session, not a special error. */
  findValidByTokenHash(tokenHash: string, now: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, now) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  touch(id: string, now: string): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  /** Logout: deleting the row is real server-side revocation, not just clearing a client-side value. */
  deleteByTokenHash(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteExpired(now: string): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }
}
