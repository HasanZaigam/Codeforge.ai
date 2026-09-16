import { mkdirSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync, existsSync, renameSync, rmSync, openSync, closeSync, type Stats } from "node:fs";
import { resolve, sep, dirname, normalize, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Filesystem persistence for the `ProjectWorkspace` domain concept (see domain/types.ts's own doc
 * comment, migrations/011_project_workspace.sql, ProjectWorkspaceRepository) — Phase 3, Slice 3.
 *
 * DELIBERATELY NOT src/workspace/*: that module is the existing, unrelated task-execution
 * `Workspace` abstraction (one ephemeral git clone per task, torn down on completion/cancellation —
 * see LocalGitWorkspaceProvider). A `ProjectWorkspace` is a persistent, project-scoped directory
 * with an entirely different lifecycle (created once alongside the project, never torn down by task
 * execution), so it gets its own root directory (`PROJECT_WORKSPACE_ROOT`, never `WORKSPACES_ROOT`)
 * and its own manager here rather than reusing or extending that code.
 *
 * No authorization logic here by design — same "intentionally dumb" posture as
 * ProjectWorkspaceRepository. Callers (ProjectService, behind assertProjectAccess) are responsible
 * for confirming the caller may act on a given ProjectWorkspace before ever reaching this class.
 *
 * Phase 3, Slice 4 adds safe relative-path file operations (`resolveFilePath`/`readFile`/
 * `writeFile`/`listDirectory`) on top of the directory this class already manages — the safe
 * primitive future project-context/RAG/MCP/AI-chat layers will build on, NOT a file-manager
 * product in its own right (no HTTP endpoints are added in this slice; see docs/API.md for why).
 * Two independent layers of defense: `assertSafeRelativePath` rejects unsafe path *strings*
 * (absolute paths, `..` traversal, Windows-style paths) before they ever reach `path.resolve`, and
 * `assertNoSymlinksInPath` separately guards against a symlink *physically present* inside a
 * ProjectWorkspace pointing outside it — lexical validation alone cannot catch that, since the
 * string itself can look perfectly safe (e.g. `safe-link/passwd`) while resolving through a symlink
 * to anywhere on disk.
 */
export class ProjectWorkspaceFsManager {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /**
   * Resolves the on-disk directory for a given ProjectWorkspace id, without touching the
   * filesystem. Not exposed over HTTP anywhere in this slice (no file-browser/upload API exists
   * yet) — this exists so callers within the backend (ProjectService today) can find the directory
   * without re-deriving the path-joining logic themselves.
   *
   * `workspaceId` is expected to be the ProjectWorkspace's own row id (a `randomUUID()` — see
   * ProjectService.create), never a project name or repository name, precisely so this never has to
   * sanitize human-chosen strings. `assertSafeWorkspaceId` + the resolved-path containment check
   * below are still enforced unconditionally, as defense in depth against a caller ever passing
   * something else (a malicious/malformed id, "../../etc", an absolute path, etc.) — see
   * /docs/SECURITY_ARCHITECTURE.md.
   */
  resolveDirectory(workspaceId: string): string {
    assertSafeWorkspaceId(workspaceId);
    const dir = resolve(this.rootDir, workspaceId);
    if (dir !== this.rootDir && !dir.startsWith(this.rootDir + sep)) {
      throw new ProjectWorkspacePathError(workspaceId);
    }
    return dir;
  }

  /**
   * Idempotently ensures the ProjectWorkspace's directory exists, creating it if missing and
   * leaving it untouched (never deleted/recreated) if it already exists — safe to call repeatedly
   * (project creation, and again lazily whenever a pre-existing ProjectWorkspace row is read — see
   * ProjectService.getWorkspace) without ever losing whatever a viewer/future feature has since
   * written into it. `mkdirSync(..., { recursive: true })` is itself idempotent and never touches
   * existing contents, so no separate "does it already exist" check is needed here.
   *
   * Synchronous, matching this codebase's existing persistence-layer convention (`node:sqlite`
   * `DatabaseSync` is itself synchronous throughout every repository) — directory creation is a
   * single cheap syscall, and staying synchronous means ProjectService.getWorkspace (an otherwise
   * synchronous read) doesn't need an async signature change that would ripple into its route
   * handler and existing tests.
   */
  ensureWorkspace(workspaceId: string): string {
    const dir = this.resolveDirectory(workspaceId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new ProjectWorkspaceProvisionError(workspaceId, err);
    }
    return dir;
  }

  /**
   * Phase 3, Slice 4: resolves a caller-supplied RELATIVE path to an absolute path inside a
   * ProjectWorkspace, without touching the filesystem. Pure lexical safety — `readFile`/`writeFile`/
   * `listDirectory` layer real (symlink-aware) containment checks on top of this before ever
   * touching disk; see `assertNoSymlinksInPath`'s own doc comment for why lexical safety alone is
   * not enough.
   *
   * Never returns (or is derived from) anything but this manager's own root + workspaceId +
   * relativePath — no caller-controlled project/repo name ever reaches a filesystem path. Not
   * exposed over HTTP in this slice (see this module's top-of-file doc comment on that decision).
   */
  resolveFilePath(workspaceId: string, relativePath: string): string {
    const workspaceDir = this.resolveDirectory(workspaceId);
    assertSafeRelativePath(relativePath);
    const target = resolve(workspaceDir, relativePath);
    if (target !== workspaceDir && !target.startsWith(workspaceDir + sep)) {
      throw new ProjectWorkspacePathError(relativePath);
    }
    return target;
  }

  /**
   * Reads a UTF-8 text file from inside a ProjectWorkspace. Fails clearly (never a bare
   * ENOENT/EISDIR) for a missing file, a directory, or a file over `MAX_PROJECT_WORKSPACE_READ_BYTES`
   * — checked via a cheap `statSync` *before* ever reading file content, so an oversized file is
   * never loaded into memory just to be rejected.
   */
  readFile(workspaceId: string, relativePath: string): string {
    const workspaceDir = this.ensureWorkspace(workspaceId);
    const target = this.resolveFilePath(workspaceId, relativePath);
    assertNoSymlinksInPath(workspaceDir, target);

    const stat = statOrNotFound(target, relativePath);
    if (stat.isDirectory()) {
      throw new ProjectWorkspaceFileNotFoundError(relativePath, "is a directory, not a file");
    }
    if (!stat.isFile()) {
      throw new ProjectWorkspaceFileNotFoundError(relativePath);
    }
    if (stat.size > MAX_PROJECT_WORKSPACE_READ_BYTES) {
      throw new ProjectWorkspaceFileTooLargeError(relativePath, stat.size, MAX_PROJECT_WORKSPACE_READ_BYTES);
    }
    return readFileSync(target, "utf-8");
  }

  /**
   * Writes UTF-8 text content to a file inside a ProjectWorkspace, creating missing parent
   * directories and creating/overwriting only the target file — never touches anything else under
   * the ProjectWorkspace (see this module's Slice 4 tests: "writing src/a/b.txt may create src/ and
   * src/a/ but must not affect anything else"). Content over `MAX_PROJECT_WORKSPACE_WRITE_BYTES` is
   * rejected before any filesystem write happens.
   *
   * Atomic (Slice 5): the new content is written to a temporary sibling file inside the same
   * ProjectWorkspace directory, then moved into place with a single `renameSync` — never a
   * truncate-then-write of the real target. `rename` within the same filesystem is atomic, so a
   * reader never observes a partially-written file, and a failure partway through (e.g. disk full
   * while writing the temp file) leaves any previously-existing content at `target` completely
   * untouched. The temp file is cleaned up on failure and never left behind on success — see this
   * module's Slice 5 atomicity tests. Used by every caller of `writeFile`, not just
   * ProjectContextService — a generic, reusable primitive rather than a manifest-specific one.
   */
  writeFile(workspaceId: string, relativePath: string, content: string): string {
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_PROJECT_WORKSPACE_WRITE_BYTES) {
      throw new ProjectWorkspaceWriteTooLargeError(relativePath, byteLength, MAX_PROJECT_WORKSPACE_WRITE_BYTES);
    }

    const workspaceDir = this.ensureWorkspace(workspaceId);
    const target = this.resolveFilePath(workspaceId, relativePath);
    assertNoSymlinksInPath(workspaceDir, target);

    if (existsSync(target) && lstatSync(target).isDirectory()) {
      throw new ProjectWorkspacePathError(relativePath);
    }

    // Safe now: assertNoSymlinksInPath already proved no symlink exists anywhere along the
    // existing prefix of `target`, so recursive mkdir can only create plain new directories or
    // walk through already-verified plain ones — it can never be redirected through a symlink.
    mkdirSync(dirname(target), { recursive: true });

    const tempTarget = `${target}.tmp-${randomUUID()}`;
    try {
      writeFileSync(tempTarget, content, "utf-8");
      renameSync(tempTarget, target);
    } catch (err) {
      try {
        rmSync(tempTarget, { force: true });
      } catch {
        // Best-effort cleanup only — the original `err` is what the caller needs to see.
      }
      throw err;
    }
    return target;
  }

  /**
   * Lists the immediate entries of a ProjectWorkspace directory (or the ProjectWorkspace root
   * itself when `relativePath` is omitted). Never returns absolute filesystem paths — only
   * `{ name, type }` per entry, sorted by name for deterministic results. Symlink entries are
   * excluded entirely (see `assertNoSymlinksInPath`'s doc comment for this manager's "no symlinks"
   * policy) rather than classified as file or directory.
   */
  listDirectory(workspaceId: string, relativePath?: string): ProjectWorkspaceFileEntry[] {
    const workspaceDir = this.ensureWorkspace(workspaceId);
    const target = relativePath === undefined ? workspaceDir : this.resolveFilePath(workspaceId, relativePath);
    assertNoSymlinksInPath(workspaceDir, target);

    const stat = statOrNotFound(target, relativePath ?? ".");
    if (!stat.isDirectory()) {
      throw new ProjectWorkspacePathError(relativePath ?? ".");
    }

    return readdirSync(target, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry): ProjectWorkspaceFileEntry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Phase 3, Slice 7 — runs `fn` while holding an exclusive, filesystem-backed lock scoped to
   * `(workspaceId, lockFileName)`, so concurrent read-modify-write sequences against the same file
   * (e.g. ProjectContextService's revision-checked replace) can never interleave. Reuses this
   * manager's own safe path resolution — the lock file lives inside the same ProjectWorkspace
   * directory, subject to the same containment/symlink rules as every other file here.
   *
   * MECHANISM: `open(path, "wx")` (`O_CREAT | O_EXCL`) atomically fails with `EEXIST` if the lock
   * file already exists — a single OS syscall, not a read-then-write our own code could race on.
   * On a real local POSIX filesystem (this platform's documented single-host deployment target —
   * see /docs/DEPLOYMENT.md) this genuinely serializes concurrent holders **across OS processes**,
   * not just within one — closing the exact race a bare in-memory/in-process lock could not close.
   *
   * HONEST LIMITATION: `O_EXCL`'s atomicity guarantee is a property of local filesystems (ext4,
   * APFS, etc.), not of network filesystems in general — NFS in particular has a long-documented
   * history of unreliable `O_EXCL` semantics across separate clients. If `PROJECT_WORKSPACE_ROOT`
   * is ever moved onto shared network storage (out of scope today — see /docs/DEPLOYMENT.md "What
   * would change before horizontal scaling"), this specific guarantee would need re-verification
   * against that filesystem's actual semantics; it is not re-verified here. No claim is made beyond
   * that boundary.
   *
   * Bounded retry, not a queue: acquisition polls up to `maxAttempts` times with a fixed delay,
   * throwing `ProjectWorkspaceLockTimeoutError` if the lock is still held after that — a genuinely
   * stuck/crashed holder never blocks a caller forever. The wait is a real (synchronous) block on
   * this thread via `Atomics.wait`, acceptable only because contention is expected to be rare and
   * each critical section here is a few filesystem syscalls, not seconds of work.
   */
  withExclusiveLock<T>(workspaceId: string, lockFileName: string, fn: () => T, options: { maxAttempts?: number; retryDelayMs?: number } = {}): T {
    const workspaceDir = this.ensureWorkspace(workspaceId);
    const lockPath = this.resolveFilePath(workspaceId, lockFileName);
    assertNoSymlinksInPath(workspaceDir, lockPath);

    const maxAttempts = options.maxAttempts ?? 50;
    const retryDelayMs = options.retryDelayMs ?? 20;

    let fd: number | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fd = openSync(lockPath, "wx");
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (attempt === maxAttempts) throw new ProjectWorkspaceLockTimeoutError(lockFileName);
        sleepSync(retryDelayMs);
      }
    }

    try {
      return fn();
    } finally {
      if (fd !== null) closeSync(fd);
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort cleanup only — never masks whatever fn() threw/returned.
      }
    }
  }
}

/** A synchronous, event-loop-blocking sleep — see `withExclusiveLock`'s own doc comment on why this trade-off is acceptable here (short, rare, bounded contention only). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Thrown when `withExclusiveLock` could not acquire the lock within its bounded retry budget — e.g. a crashed process left a stale lock file, or (in principle) another process is legitimately still mid-write. Never a filesystem path in the message. */
export class ProjectWorkspaceLockTimeoutError extends Error {
  constructor(lockFileName: string) {
    super(`Timed out waiting for the "${lockFileName}" lock — another update may still be in progress. Try again.`);
    this.name = "ProjectWorkspaceLockTimeoutError";
  }
}

/** Read model returned by `listDirectory` — never a filesystem-specific absolute path. */
export interface ProjectWorkspaceFileEntry {
  name: string;
  type: "file" | "directory";
}

/** Maximum size of a file `readFile` will load into memory. Deliberately a plain source constant
 * (not an env var) — see this module's Slice 4 doc comment: this is a safety guard against
 * accidental huge reads, not a tunable production knob, so it doesn't need the startup-config
 * validation machinery every real env var here goes through. */
export const MAX_PROJECT_WORKSPACE_READ_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Maximum size of content `writeFile` will accept, checked before any filesystem write happens. */
export const MAX_PROJECT_WORKSPACE_WRITE_BYTES = 5 * 1024 * 1024; // 5 MiB

const SAFE_WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Whitelist-only: letters, digits, `-`, `_`. Rejects path separators, `..`, absolute-path leading
 * `/`, and anything else that isn't a plain path-safe token before it ever reaches `path.resolve`.
 * A `randomUUID()` (the only real caller today) always matches this.
 */
function assertSafeWorkspaceId(workspaceId: string): void {
  if (!workspaceId || !SAFE_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new ProjectWorkspacePathError(workspaceId);
  }
}

/**
 * Whitelist-first relative-path validation for Slice 4's file operations (`resolveFilePath` and
 * everything built on it). Rejects, before the string ever reaches `path.resolve`:
 *  - empty/blank input
 *  - NUL bytes
 *  - backslashes (Windows-style separators/drive paths — e.g. `C:\Windows\file.txt` — this
 *    codebase only ever runs on POSIX per LocalGitWorkspaceProvider's own documented boundary, so a
 *    literal backslash can never be a legitimate path segment)
 *  - a Windows-style drive-letter prefix (`C:...`) even without backslashes
 *  - a POSIX absolute path (leading `/`)
 *  - `.` or `..` as the whole path, or as any normalized path segment (catches `a/../../etc` too)
 *
 * The resolved-path containment check in `resolveFilePath` (comparing against the ProjectWorkspace
 * directory) is a second, independent layer on top of this — see that method's own doc comment.
 */
function assertSafeRelativePath(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new ProjectWorkspacePathError(String(relativePath));
  }
  if (relativePath.includes("\0") || relativePath.includes("\\")) {
    throw new ProjectWorkspacePathError(relativePath);
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new ProjectWorkspacePathError(relativePath);
  }
  const normalized = normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.split(sep).includes("..")) {
    throw new ProjectWorkspacePathError(relativePath);
  }
}

/**
 * Real (not just lexical) containment check against symlink escape — see this module's Slice 4
 * design note: lexical path validation alone is not sufficient, since a symlink physically present
 * inside a ProjectWorkspace (e.g. `safe-link -> /etc`) can point anywhere on disk regardless of how
 * safe the *string* `safe-link/passwd` looks.
 *
 * CHOSEN POLICY: no symlinks at all, anywhere along a resolved path, for any Slice 4 file
 * operation — not just ones that would escape the ProjectWorkspace. This is deliberately simpler
 * and strictly safer than trying to distinguish "safe, internal-only" symlinks from escaping ones
 * (which would require resolving *where* the link points and re-checking containment, and doing so
 * correctly for every intermediate path component, not just the final one). A ProjectWorkspace
 * created and written to only through this manager never contains a symlink in the first place, so
 * this only ever rejects a symlink an operator/other process placed there directly.
 *
 * Walks from `workspaceDir` down each path segment of `fullPath`, `lstat`-ing every segment that
 * actually exists (stopping at the first segment that doesn't — nothing beneath a nonexistent
 * segment can exist either, so there is nothing further to check; `writeFile` goes on to create
 * exactly those missing segments as plain new directories).
 */
function assertNoSymlinksInPath(workspaceDir: string, fullPath: string): void {
  const relativeSegments = fullPath === workspaceDir ? [] : fullPath.slice(workspaceDir.length + 1).split(sep);
  let current = workspaceDir;
  for (const segment of relativeSegments) {
    current = `${current}${sep}${segment}`;
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new ProjectWorkspaceSymlinkEscapeError(current.slice(workspaceDir.length + 1));
    }
  }
}

/** `statSync`, translating a missing path into the domain-specific "not found" error instead of a bare ENOENT. */
function statOrNotFound(target: string, relativePath: string): Stats {
  try {
    return statSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectWorkspaceFileNotFoundError(relativePath);
    }
    throw err;
  }
}

export class ProjectWorkspacePathError extends Error {
  constructor(workspaceId: string) {
    super(`Refusing to resolve an unsafe ProjectWorkspace path "${workspaceId}" to a filesystem path.`);
    this.name = "ProjectWorkspacePathError";
  }
}

/** Never includes the resolved absolute path — only the caller-supplied relative path — so this is always safe to log or (if ever surfaced over HTTP in a future slice) return to a client. */
export class ProjectWorkspaceFileNotFoundError extends Error {
  constructor(relativePath: string, detail?: string) {
    super(`ProjectWorkspace file "${relativePath}" was not found${detail ? ` (${detail})` : ""}.`);
    this.name = "ProjectWorkspaceFileNotFoundError";
  }
}

export class ProjectWorkspaceFileTooLargeError extends Error {
  constructor(relativePath: string, actualBytes: number, maxBytes: number) {
    super(`ProjectWorkspace file "${relativePath}" is ${actualBytes} bytes, exceeding the ${maxBytes}-byte read limit.`);
    this.name = "ProjectWorkspaceFileTooLargeError";
  }
}

export class ProjectWorkspaceWriteTooLargeError extends Error {
  constructor(relativePath: string, actualBytes: number, maxBytes: number) {
    super(`Refusing to write ${actualBytes} bytes to ProjectWorkspace file "${relativePath}": exceeds the ${maxBytes}-byte write limit.`);
    this.name = "ProjectWorkspaceWriteTooLargeError";
  }
}

/** Never includes an absolute filesystem path — only the offending path relative to the ProjectWorkspace root — so this stays safe to log or expose. */
export class ProjectWorkspaceSymlinkEscapeError extends Error {
  constructor(relativeOffendingPath: string) {
    super(`Refusing to follow symlink at ProjectWorkspace path "${relativeOffendingPath}" — symlinks are not permitted inside a ProjectWorkspace.`);
    this.name = "ProjectWorkspaceSymlinkEscapeError";
  }
}

/**
 * Wraps the underlying filesystem error (permissions, disk full, etc.) so callers/logs get a clear,
 * diagnosable message naming the affected ProjectWorkspace instead of a bare ENOENT/EACCES. The
 * ProjectWorkspace DB row is never touched by this class, so a thrown error here always leaves the
 * database exactly as it was — see ProjectService.create's own doc comment on why that's acceptable
 * without a compensating transaction.
 */
export class ProjectWorkspaceProvisionError extends Error {
  constructor(workspaceId: string, cause: unknown) {
    super(`Failed to provision the filesystem directory for ProjectWorkspace ${workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ProjectWorkspaceProvisionError";
    this.cause = cause;
  }
}
