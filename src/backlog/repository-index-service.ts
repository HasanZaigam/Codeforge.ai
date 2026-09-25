import { randomUUID } from "node:crypto";
import type { Project } from "../domain/types.js";
import type { RepositoryIndexRepository } from "../persistence/repositories/repository-index-repository.js";
import { buildRepositoryIndex, countSymbols, DEFAULT_INDEX_BUILD_LIMITS, INDEX_SCHEMA_VERSION, indexMismatch, sourceKeyOf, type IndexBuildLimits, type RepositoryIndex } from "./repository-index.js";
import type { RepositorySession } from "./repository-structure.js";

/**
 * How an analysis attempt got (or did not get) an index — recorded on the analysis so a reader can tell
 * "selected with the index" from "selected by file name only, and why":
 *   used                 a READY index for exactly this revision was found (`built: false`) or just built (`built: true`)
 *   building_elsewhere   another worker holds a live build claim — this analysis proceeds WITHOUT it (never waits, never duplicates the build)
 *   backoff              a recent build for this revision failed — not retried yet
 *   no_revision          the repository session could not name a commit, so an index could not be bound to anything
 *   rejected             a stored index failed the revision/source/schema check and was not used
 *   failed               building it failed (reason is a short, non-secret message)
 *   disabled             indexing is not configured
 */
export type IndexState = "used" | "building_elsewhere" | "backoff" | "no_revision" | "rejected" | "failed" | "disabled";

export interface IndexAccess {
  state: IndexState;
  index: RepositoryIndex | null;
  built: boolean;
  /** Short, non-secret explanation for the non-`used` states. */
  reason: string | null;
}

export const NO_INDEX: IndexAccess = { state: "disabled", index: null, built: false, reason: "no repository index configured" };

export interface RepositoryIndexServiceOptions {
  limits?: IndexBuildLimits;
  /** Lease on a build claim. Must exceed the build deadline; an expired claim (crashed builder) can be taken over. */
  buildLeaseMs?: number;
  /** After a FAILED build for a revision, don't try again for this long. */
  retryAfterMs?: number;
}

/**
 * Lazily provides the revision-bound index to an analysis attempt (Phase 4A.3). There is no separate
 * indexing worker: the index is built, once per revision, inside an existing analysis job (so the worker's
 * lease/heartbeat/cancel/concurrency cap all apply), and coordinated through the `repository_indexes` row —
 * a second worker that arrives while a build is live degrades to name-only selection rather than waiting or
 * building it again. Distinct projects never share a row, and the key includes the exact commit SHA.
 */
export class RepositoryIndexService {
  private readonly limits: IndexBuildLimits;
  private readonly buildLeaseMs: number;
  private readonly retryAfterMs: number;
  private readonly owner = `indexer-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly store: RepositoryIndexRepository,
    options: RepositoryIndexServiceOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_INDEX_BUILD_LIMITS;
    this.buildLeaseMs = options.buildLeaseMs ?? this.limits.deadlineMs * 2 + 60_000;
    this.retryAfterMs = options.retryAfterMs ?? 10 * 60_000;
  }

  async obtain(project: Pick<Project, "id" | "repoUrl" | "defaultBranch">, session: RepositorySession, signal: AbortSignal): Promise<IndexAccess> {
    const revision = session.revision;
    if (!revision) return { state: "no_revision", index: null, built: false, reason: "the repository session did not report a commit, so an index cannot be bound to a revision" };
    const sourceKey = sourceKeyOf(project);
    const key = { projectId: project.id, sourceKey, revision, schemaVersion: INDEX_SCHEMA_VERSION };

    const cached = this.store.find(key);
    if (cached) return this.checked(cached, revision, sourceKey, false);

    // Concurrent attempts in one process need no separate guard: the row claim below is atomic, so the loser
    // gets `busy` (⇒ `building_elsewhere`) and never waits on — or inherits the abort of — the winner's build.
    return this.buildOnce(key, session, signal);
  }

  private async buildOnce(key: { projectId: string; sourceKey: string; revision: string; schemaVersion: number }, session: RepositorySession, signal: AbortSignal): Promise<IndexAccess> {
    const claim = this.store.tryBeginBuild(key, this.owner, this.buildLeaseMs, this.retryAfterMs);
    if (claim.kind === "ready") {
      const found = this.store.find(key);
      return found ? this.checked(found, key.revision, key.sourceKey, false) : { state: "failed", index: null, built: false, reason: "index row was ready but unreadable" };
    }
    if (claim.kind === "busy") return { state: "building_elsewhere", index: null, built: false, reason: "another worker is building the index for this revision" };
    if (claim.kind === "backoff") return { state: "backoff", index: null, built: false, reason: "a recent index build for this revision failed; not retried yet" };

    const started = Date.now();
    try {
      const index = await buildRepositoryIndex(session, key.sourceKey, signal, this.limits);
      if (!this.store.complete(claim.id, this.owner, index, Date.now() - started, countSymbols(index))) {
        return { state: "failed", index: null, built: false, reason: "the build claim was lost before the index could be stored" };
      }
      return this.checked(index, key.revision, key.sourceKey, true);
    } catch (err) {
      if (signal.aborted) {
        this.store.abandon(claim.id, this.owner);
        throw err;
      }
      const reason = err instanceof Error ? err.message.slice(0, 300) : "index build failed";
      this.store.fail(claim.id, this.owner, reason);
      return { state: "failed", index: null, built: false, reason };
    }
  }

  private checked(index: RepositoryIndex, revision: string, sourceKey: string, built: boolean): IndexAccess {
    const mismatch = indexMismatch(index, { revision, sourceKey });
    return mismatch ? { state: "rejected", index: null, built: false, reason: mismatch } : { state: "used", index, built, reason: null };
  }
}
