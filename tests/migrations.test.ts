import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MIGRATION_FILES } from "../src/persistence/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "src", "persistence", "migrations");

/**
 * Guards against the migrations directory and db.ts's MIGRATION_FILES list
 * silently drifting apart — a file added to one but not the other only
 * used to surface as a runtime ENOENT (or a migration quietly never
 * running) the first time a fresh database was opened. See db.ts's own
 * comment on MIGRATION_FILES and /docs/DEPLOYMENT.md "Database migrations".
 */
test("MIGRATION_FILES lists every .sql file in src/persistence/migrations, in the same order they're on disk, with none missing or extra", () => {
  const onDisk = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  assert.deepEqual([...MIGRATION_FILES].sort(), onDisk, "MIGRATION_FILES and the migrations directory must list exactly the same files");

  // The list is applied in this exact order (see runMigrations) — numeric
  // filename prefixes must already be in ascending order on disk too, or
  // MIGRATION_FILES's hardcoded order could silently diverge from a simple
  // "sort by filename" expectation.
  assert.deepEqual([...MIGRATION_FILES].sort(), MIGRATION_FILES, "MIGRATION_FILES must already be in ascending filename order");
});

test("every migration file is present on disk and non-empty", () => {
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    assert.ok(sql.trim().length > 0, `${file} must not be empty`);
  }
});
