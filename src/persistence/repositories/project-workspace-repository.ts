import type { DatabaseSync } from "node:sqlite";
import type { ProjectWorkspace } from "../../domain/types.js";

interface ProjectWorkspaceRow {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

function rowToProjectWorkspace(row: ProjectWorkspaceRow): ProjectWorkspace {
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistence for `ProjectWorkspace` (see domain/types.ts's own doc comment — the Phase 3,
 * project-scoped concept, NOT the existing task-scoped `Workspace`/`WorkspaceRepository`). One row
 * per project, enforced by `UNIQUE(project_id)` on `project_workspaces`
 * (migrations/011_project_workspace.sql) — that constraint, not any logic in this class, is what
 * prevents a project from ever ending up with two. Same "intentionally dumb" posture every other
 * repository in this codebase follows (see TaskDependencyRepository's own doc comment): no
 * authorization logic here — callers (ProjectService) are responsible for access checks.
 */
export class ProjectWorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(workspace: ProjectWorkspace): void {
    this.db
      .prepare(
        `INSERT INTO project_workspaces (id, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(workspace.id, workspace.projectId, workspace.createdAt, workspace.updatedAt);
  }

  findByProjectId(projectId: string): ProjectWorkspace | null {
    const row = this.db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").get(projectId) as
      | ProjectWorkspaceRow
      | undefined;
    return row ? rowToProjectWorkspace(row) : null;
  }

  /**
   * Bumps this row's own `updated_at` — called by ProjectService.updateContext whenever the
   * ProjectWorkspace's Project Context Manifest is successfully saved, since the manifest is
   * content that lives inside this ProjectWorkspace. Deliberately narrow (id, not projectId): the
   * caller already holds the specific ProjectWorkspace row this write targets, same as every other
   * write in this class taking exactly the identifiers it needs and nothing more.
   */
  touchUpdatedAt(id: string, now: string): void {
    this.db.prepare("UPDATE project_workspaces SET updated_at = ? WHERE id = ?").run(now, id);
  }
}
