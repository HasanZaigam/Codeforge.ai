import type { ProjectWorkspaceRepository } from "../persistence/repositories/project-workspace-repository.js";
import type { ProjectContextService } from "../project-workspace/project-context-service.js";
import { renderProjectContextSection } from "./project-context-section.js";

/**
 * Phase 3, Slice 6 — the sole place the Orchestrator loads a project's persistent Project Context
 * Manifest for AI task execution. Deterministic lookup chain, exactly as designed:
 *
 *   task -> project -> ProjectWorkspace -> ProjectContextService -> validated Project Context
 *
 * Never reads `.project-context.json` directly and never touches the filesystem itself — both the
 * `ProjectWorkspace` lookup (`ProjectWorkspaceRepository`) and the manifest read
 * (`ProjectContextService`, which itself only ever goes through `ProjectWorkspaceFsManager`) reuse
 * the exact same components Slice 5's HTTP `GET/PUT /projects/:projectId/context` routes use — no
 * second implementation, no scanning the task's own repository files for "project context".
 *
 * Failure behavior (see domain/types.ts ContextBundle.projectContext's own doc comment):
 *  - No `ProjectWorkspace` row at all (a project created before Slice 3, or a data-integrity gap):
 *    returns `null` — the task proceeds with no project context section, exactly as it did before
 *    this slice existed. Logged, never thrown.
 *  - No manifest yet for an existing `ProjectWorkspace` (a project that predates Slice 5, or a
 *    migration-011-backfilled project): `ProjectContextService.ensureManifest` self-heals by
 *    creating and returning the default manifest — see that method's own doc comment. This is the
 *    SAME self-healing behavior Slice 5's `ProjectService.getContext` already relies on, reused
 *    here rather than duplicated.
 *  - A manifest exists but fails validation (`ProjectContextManifestCorruptError` — a server-side
 *    data-integrity condition, never caused by this loader or by the requesting task): caught here,
 *    logged with the project id and reason, and treated exactly like "no context available" —
 *    `null`. Malformed on-disk content is never reinterpreted as valid instructions, and a corrupt
 *    manifest never fails the task itself (project context is additive, not required).
 *  - Any other unexpected failure (e.g. a filesystem provisioning error) is handled the same way:
 *    logged, degraded to `null`, task execution continues unaffected.
 */
export function loadProjectContextSection(
  projectId: string,
  projectName: string,
  projectWorkspaces: ProjectWorkspaceRepository,
  projectContext: ProjectContextService,
): string | null {
  const workspace = projectWorkspaces.findByProjectId(projectId);
  if (!workspace) {
    console.warn(`[project-context] project ${projectId} has no ProjectWorkspace — proceeding without project context for this run.`);
    return null;
  }

  try {
    const manifest = projectContext.ensureManifest(workspace.id, projectName);
    return renderProjectContextSection(manifest);
  } catch (err) {
    console.warn(
      `[project-context] failed to load project context for project ${projectId}: ${err instanceof Error ? err.message : String(err)} — proceeding without it.`,
    );
    return null;
  }
}
