import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RepositoryIndex } from "../../backlog/repository-index.js";
import { runInTransaction } from "../transaction.js";

interface Row {
  id: string;
  project_id: string;
  source_key: string;
  revision: string;
  schema_version: number;
  status: string;
  build_owner: string | null;
  build_expires_at: string | null;
  index_json: string | null;
  updated_at: string;
}

export type IndexKey = { projectId: string; sourceKey: string; revision: string; schemaVersion: number };

/** Outcome of asking to build an index: someone else has it, someone else is building it, or the caller now owns the build. */
export type BuildClaim = { kind: "ready" } | { kind: "busy" } | { kind: "backoff" } | { kind: "claimed"; id: string };

/** How many revisions of one project's index are kept; older READY rows are pruned after a successful build. */
export const RETAINED_REVISIONS_PER_PROJECT = 3;

/**
 * Persistent store for `RepositoryIndex` documents (migration 015). Every read is keyed by (project,
 * source, revision, schema version), so an index can only be found for the exact repository state it
 * describes and never across projects. The row doubles as the build claim: coordination needs no second
 * worker system, and a second builder can never start while a live claim exists.
 */
export class RepositoryIndexRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** The READY index for exactly this key, or `null`. Never returns another revision's index. */
  find(key: IndexKey): RepositoryIndex | null {
    const row = this.db
      .prepare("SELECT * FROM repository_indexes WHERE project_id = ? AND source_key = ? AND revision = ? AND schema_version = ? AND status = 'READY'")
      .get(key.projectId, key.sourceKey, key.revision, key.schemaVersion) as unknown as Row | undefined;
    if (!row?.index_json) return null;
    try {
      return JSON.parse(row.index_json) as RepositoryIndex;
    } catch {
      return null; // a corrupt row is a cache miss, never a crash
    }
  }

  /**
   * Atomically decides who builds. `owner` is the caller's identity. A live BUILDING claim held by someone
   * else yields `busy` (the caller must NOT build and must NOT wait); a recently FAILED build yields
   * `backoff` (don't hammer a repository that just failed to index); an expired claim or a FAILED row past
   * `retryAfterMs` is taken over.
   */
  tryBeginBuild(key: IndexKey, owner: string, leaseMs: number, retryAfterMs: number, nowMs: number = Date.now()): BuildClaim {
    const now = new Date(nowMs).toISOString();
    const expires = new Date(nowMs + leaseMs).toISOString();
    return runInTransaction(this.db, () => {
      const id = randomUUID();
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO repository_indexes
             (id, project_id, source_key, revision, schema_version, status, build_owner, build_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'BUILDING', ?, ?, ?, ?)`,
        )
        .run(id, key.projectId, key.sourceKey, key.revision, key.schemaVersion, owner, expires, now, now);
      if (inserted.changes > 0) return { kind: "claimed", id } as const;

      const row = this.db
        .prepare("SELECT * FROM repository_indexes WHERE project_id = ? AND source_key = ? AND revision = ? AND schema_version = ?")
        .get(key.projectId, key.sourceKey, key.revision, key.schemaVersion) as unknown as Row;
      if (row.status === "READY") return { kind: "ready" } as const;
      if (row.status === "BUILDING" && row.build_expires_at !== null && row.build_expires_at > now) return { kind: "busy" } as const;
      if (row.status === "FAILED" && Date.parse(row.updated_at) + retryAfterMs > nowMs) return { kind: "backoff" } as const;
      // Expired BUILDING (a crashed builder) or FAILED past its retry delay: take over.
      this.db
        .prepare("UPDATE repository_indexes SET status = 'BUILDING', build_owner = ?, build_expires_at = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(owner, expires, now, row.id);
      return { kind: "claimed", id: row.id } as const;
    });
  }

  /** Stores the finished index — only if `owner` still holds the claim. Returns false if it does not (its claim was taken over). */
  complete(id: string, owner: string, index: RepositoryIndex, buildMs: number, symbolCount: number, nowMs: number = Date.now()): boolean {
    const now = new Date(nowMs).toISOString();
    const done = this.db
      .prepare(
        `UPDATE repository_indexes
         SET status = 'READY', index_json = ?, file_count = ?, content_indexed_files = ?, symbol_count = ?, build_ms = ?,
             build_owner = NULL, build_expires_at = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND status = 'BUILDING' AND build_owner = ?`,
      )
      .run(JSON.stringify(index), index.files.length, index.coverage.contentIndexedFiles, symbolCount, buildMs, now, id, owner);
    if (done.changes === 0) return false;
    this.prune(index.revision, id);
    return true;
  }

  fail(id: string, owner: string, error: string, nowMs: number = Date.now()): void {
    this.db
      .prepare("UPDATE repository_indexes SET status = 'FAILED', error = ?, build_owner = NULL, build_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'BUILDING' AND build_owner = ?")
      .run(error.slice(0, 500), new Date(nowMs).toISOString(), id, owner);
  }

  /** The builder was aborted (shutdown / cancel): drop the claim so another worker can build immediately. */
  abandon(id: string, owner: string): void {
    this.db.prepare("DELETE FROM repository_indexes WHERE id = ? AND status = 'BUILDING' AND build_owner = ?").run(id, owner);
  }

  /** Keeps the newest few READY rows of the project owning `keepId`'s row. */
  private prune(_revision: string, keepId: string): void {
    const project = this.db.prepare("SELECT project_id, source_key FROM repository_indexes WHERE id = ?").get(keepId) as { project_id: string; source_key: string } | undefined;
    if (!project) return;
    this.db
      .prepare(
        `DELETE FROM repository_indexes
         WHERE project_id = ? AND source_key = ? AND status = 'READY' AND id NOT IN (
           SELECT id FROM repository_indexes WHERE project_id = ? AND source_key = ? AND status = 'READY' ORDER BY updated_at DESC LIMIT ?
         )`,
      )
      .run(project.project_id, project.source_key, project.project_id, project.source_key, RETAINED_REVISIONS_PER_PROJECT);
  }
}
