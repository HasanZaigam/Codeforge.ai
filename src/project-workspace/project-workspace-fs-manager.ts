import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";

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
}

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

export class ProjectWorkspacePathError extends Error {
  constructor(workspaceId: string) {
    super(`Refusing to resolve an unsafe ProjectWorkspace id "${workspaceId}" to a filesystem path.`);
    this.name = "ProjectWorkspacePathError";
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
