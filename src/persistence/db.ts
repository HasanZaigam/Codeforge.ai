import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Thin wrapper around node:sqlite. Chosen for the MVP over Postgres/better-sqlite3
 * for zero external dependencies and zero native builds — see
 * /docs/TECHNICAL_DECISIONS.md (TD-11). Every write that must be atomic with a
 * read (task claiming) uses a single SQL statement with a WHERE guard rather
 * than relying on this wrapper for locking.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // WAL lets concurrent readers proceed without blocking on a writer, but SQLite still only ever
  // allows one writer at a time — without a busy timeout, a second process's write arriving while
  // another write transaction is in progress fails immediately with SQLITE_BUSY (the default is 0,
  // i.e. no wait at all) instead of waiting briefly for the lock to clear. With two worker processes
  // (or a worker and the API process) sharing one file, both write reasonably often (claims, lease
  // renewals, task_events, AgentRun rows), so a transient overlap is a real, expected occurrence,
  // not a bug — it must be waited out, not surfaced as an error. See /docs/TECHNICAL_DECISIONS.md.
  db.exec("PRAGMA busy_timeout = 5000;");
  runMigrations(db);
  return db;
}

/**
 * Explicit, ordered list — avoids fs.readdir ordering surprises. Exported
 * so tests can assert it stays in sync with what's actually on disk in
 * src/persistence/migrations/ (see tests/migrations.test.ts) — a migration
 * file added here but not on disk (or vice versa) would otherwise only
 * surface as a runtime ENOENT the first time a fresh database is opened.
 */
export const MIGRATION_FILES = ["001_init.sql", "002_cancellation.sql", "003_auth.sql", "004_github.sql", "005_concurrency.sql"];

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = join(__dirname, "migrations");
  const files = MIGRATION_FILES;

  const applied = new Set(
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
      file,
      new Date().toISOString(),
    );
  }
}
