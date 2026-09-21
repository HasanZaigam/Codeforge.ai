import type { ProjectWorkspaceFsManager } from "./project-workspace-fs-manager.js";
import { ProjectWorkspaceFileNotFoundError, ProjectWorkspaceFileTooLargeError } from "./project-workspace-fs-manager.js";
import {
  PROJECT_CONTEXT_MANIFEST_FILENAME,
  MAX_PROJECT_CONTEXT_MANIFEST_BYTES,
  defaultProjectContextManifest,
  parseProjectContextManifestText,
  validateProjectContextManifest,
  ProjectContextManifestCorruptError,
  ProjectContextManifestTooLargeError,
  ProjectContextConflictError,
  type ProjectContextManifest,
} from "./project-context-manifest.js";

/** Sibling lock file used to serialize `replaceManifest` calls for a given ProjectWorkspace — see `ProjectWorkspaceFsManager.withExclusiveLock` and `replaceManifest`'s own doc comment. Not a manifest itself; never validated against the manifest schema. */
const PROJECT_CONTEXT_LOCK_FILENAME = ".project-context.json.lock";

/**
 * Phase 3, Slice 5 — reads, creates, and replaces a ProjectWorkspace's Project Context Manifest
 * (see project-context-manifest.ts's own doc comment for what the manifest is and isn't).
 *
 * Deliberately does NOT:
 *  - perform project/user authorization — every method here takes a bare `workspaceId`, not a
 *    `projectId`/`actorId` pair; the caller (ProjectService, behind `assertProjectAccess`) is
 *    responsible for confirming the caller may act on that ProjectWorkspace first, same
 *    "intentionally dumb" posture as ProjectWorkspaceFsManager itself.
 *  - touch the filesystem directly — every read/write goes through the injected
 *    `ProjectWorkspaceFsManager`, so this class has no idea how (or where) `PROJECT_WORKSPACE_ROOT`
 *    is laid out on disk.
 *  - access `WORKSPACES_ROOT`, task execution workspaces, GitHub, or any AI/coding-engine call.
 */
export class ProjectContextService {
  constructor(private readonly fs: ProjectWorkspaceFsManager) {}

  /**
   * Idempotent: if a manifest already exists for this ProjectWorkspace, it is read, validated, and
   * returned completely unchanged — no user-authored content (instructions, architecture notes,
   * conventions, etc.) is ever reset or overwritten by calling this again. Only when no manifest
   * exists yet does this create and persist a default one (project name only, every other field
   * empty). This is the only path that ever creates a manifest — called both at project-creation
   * time and lazily on first read of a pre-Slice-5 (or migration-011-backfilled) ProjectWorkspace
   * that has a directory but no manifest yet.
   */
  ensureManifest(workspaceId: string, projectName: string): ProjectContextManifest {
    try {
      return this.readManifest(workspaceId);
    } catch (err) {
      if (err instanceof ProjectWorkspaceFileNotFoundError) {
        const manifest: ProjectContextManifest = { ...defaultProjectContextManifest(projectName), updatedAt: new Date().toISOString() };
        this.persist(workspaceId, manifest);
        return manifest;
      }
      throw err;
    }
  }

  /**
   * Reads and validates the manifest currently on disk. Throws `ProjectWorkspaceFileNotFoundError`
   * (from the underlying fs manager) if none exists yet — callers that want "create if missing"
   * semantics use `ensureManifest` instead. A manifest found on disk that fails validation throws
   * `ProjectContextManifestCorruptError` — distinct from the "client submitted invalid content" case
   * (`ProjectContextManifestInvalidError`, thrown by `replaceManifest`) because this can only mean
   * something outside this API wrote (or corrupted) the file directly; it is never the requesting
   * caller's own fault.
   */
  readManifest(workspaceId: string): ProjectContextManifest {
    let raw: string;
    try {
      raw = this.fs.readFile(workspaceId, PROJECT_CONTEXT_MANIFEST_FILENAME);
    } catch (err) {
      // The manifest's own size ceiling (MAX_PROJECT_CONTEXT_MANIFEST_BYTES) is far below the
      // general per-file limit the fs manager enforces — if a file bigger than the manifest's own
      // limit but still under the general one ever ends up at this path (only possible by writing
      // it outside this API, since replaceManifest checks its own limit first), report it in
      // manifest-specific terms rather than leaking the fs manager's generic file-size error.
      if (err instanceof ProjectWorkspaceFileTooLargeError) {
        throw new ProjectContextManifestTooLargeError(null, MAX_PROJECT_CONTEXT_MANIFEST_BYTES);
      }
      throw err;
    }
    try {
      return parseProjectContextManifestText(raw);
    } catch (err) {
      throw new ProjectContextManifestCorruptError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Phase 3, Slice 7 — validates `input` (an HTTP `PUT` body, required to include the `revision`
   * the caller believes is current — see `ProjectContextManifestInputSchema`'s own doc comment)
   * and, only if both the content AND the revision check pass, atomically replaces the on-disk
   * manifest with the next revision. Optimistic concurrency control: `input.revision` is compared
   * against the manifest's ACTUAL current revision (re-read fresh, inside the lock below — never
   * a stale value from before this call started); a mismatch throws `ProjectContextConflictError`
   * and writes nothing, so a stale client can never silently overwrite a newer version. On success
   * the persisted revision is always `currentOnDisk.revision + 1` — never the client-submitted
   * value verbatim, which only ever serves as the "expected" half of the compare-and-swap.
   *
   * RACE CLOSED VIA A REAL LOCK, NOT read-then-write: the entire
   * read-current -> compare-revision -> construct-next -> validate-size -> atomically-write
   * sequence runs inside `ProjectWorkspaceFsManager.withExclusiveLock` — see that method's own doc
   * comment for exactly what guarantee this does (and does not) provide across OS processes. Two
   * concurrent callers that both read revision 5 can never both succeed: whichever acquires the
   * lock first reads 5, writes 6, and releases; the second then reads the FRESH current value
   * (6, not its own stale 5), sees the mismatch, and is rejected with `ProjectContextConflictError`
   * instead of clobbering the first caller's update.
   *
   * Invalid input throws `ProjectContextManifestInvalidError` *before* the lock is even acquired
   * (no need to serialize a request that was always going to fail). Oversized (but otherwise valid
   * and revision-matched) input throws `ProjectContextManifestTooLargeError`, still before any
   * write. In every failure case (invalid input, size, conflict, or a lock/write failure), the
   * previously-stored manifest and its revision are left completely untouched.
   */
  replaceManifest(workspaceId: string, input: unknown): ProjectContextManifest {
    const candidate = validateProjectContextManifest(input);

    return this.fs.withExclusiveLock(workspaceId, PROJECT_CONTEXT_LOCK_FILENAME, () => {
      const current = this.readManifest(workspaceId);
      if (current.revision !== candidate.revision) {
        throw new ProjectContextConflictError(current.revision);
      }

      const next: ProjectContextManifest = { ...candidate, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      const serialized = serialize(next);
      const byteLength = Buffer.byteLength(serialized, "utf-8");
      if (byteLength > MAX_PROJECT_CONTEXT_MANIFEST_BYTES) {
        throw new ProjectContextManifestTooLargeError(byteLength, MAX_PROJECT_CONTEXT_MANIFEST_BYTES);
      }
      this.fs.writeFile(workspaceId, PROJECT_CONTEXT_MANIFEST_FILENAME, serialized);
      return next;
    });
  }

  private persist(workspaceId: string, manifest: ProjectContextManifest): void {
    this.fs.writeFile(workspaceId, PROJECT_CONTEXT_MANIFEST_FILENAME, serialize(manifest));
  }
}

function serialize(manifest: ProjectContextManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
