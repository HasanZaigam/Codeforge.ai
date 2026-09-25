import type { DatabaseSync } from "node:sqlite";

/**
 * Runs `fn` — which MUST be fully synchronous — inside one `BEGIN IMMEDIATE` transaction.
 *
 * Why this is safe here even though most of the codebase relies on single guarded statements
 * instead (see task-dependency-repository.ts): `node:sqlite` is synchronous, so a synchronous `fn`
 * can never interleave with any other statement on this process's connection (nothing else runs
 * between BEGIN and COMMIT), and `BEGIN IMMEDIATE` takes the write lock up front so a second
 * process's writer waits (see db.ts's busy_timeout) rather than failing mid-transaction. Never call
 * this with an async function — an `await` inside would let unrelated statements on the same
 * connection join this transaction.
 *
 * Used only where several rows genuinely must change together or not at all (recording an analysis
 * result + its relationship proposals + the item's status; finalizing a conversion). If a
 * transaction is already open (`db.isTransaction`), `fn` simply joins it.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back (e.g. SQLite aborted the transaction itself) — nothing more to undo.
    }
    throw err;
  }
}
