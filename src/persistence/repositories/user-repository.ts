import type { DatabaseSync } from "node:sqlite";
import type { User } from "../../domain/types.js";

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

/** See docs/MVP_SCOPE.md: single-tenant, but multiple real developer accounts (Step 6). */
export class UserRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(user: User): void {
    this.db
      .prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, user.tenantId, user.email, user.name, user.passwordHash, user.createdAt);
  }

  findById(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  /** Email lookup is case-insensitive at query time; storage keeps whatever casing the user registered with. */
  findByEmail(email: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }
}
