import type { DatabaseSync } from "node:sqlite";
import type { Project, ProjectCommands } from "../../domain/types.js";

interface ProjectRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  coding_engine: string;
  source_control_provider: string;
  owner: string | null;
  repo: string | null;
  commands_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    name: row.name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    codingEngine: row.coding_engine,
    sourceControlProvider: row.source_control_provider,
    owner: row.owner,
    repo: row.repo,
    commands: row.commands_json ? (JSON.parse(row.commands_json) as ProjectCommands) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects
          (id, tenant_id, owner_id, name, repo_url, default_branch, coding_engine,
           source_control_provider, owner, repo, commands_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.tenantId,
        project.ownerId,
        project.name,
        project.repoUrl,
        project.defaultBranch,
        project.codingEngine,
        project.sourceControlProvider,
        project.owner,
        project.repo,
        project.commands ? JSON.stringify(project.commands) : null,
        project.createdAt,
        project.updatedAt,
      );
  }

  findById(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  }

  /** Persists commands discovered at runtime so future tasks don't re-discover them. See CONTEXT_ARCHITECTURE.md. */
  updateCommands(id: string, commands: ProjectCommands, now: string): void {
    this.db
      .prepare("UPDATE projects SET commands_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(commands), now, id);
  }

  /**
   * Deletes a project and everything scoped to it — its tasks and every row that in turn belongs
   * to one of those tasks (events, agent runs, ephemeral workspace records, human input requests,
   * dependency edges), plus its `project_workspaces` row. Deliberately sequential DELETEs in
   * child-before-parent order (foreign keys are enforced — see persistence/db.ts's `PRAGMA
   * foreign_keys = ON`), not wrapped in an explicit transaction — this codebase has no
   * cross-statement transactions anywhere (see e.g. ProjectService.create's own doc comment on the
   * same posture); a failure partway through is a diagnosable partial-delete, not silently masked.
   * Callers must check ProjectService.delete's active-task guard *before* calling this — this
   * method itself performs no such check, so it must never be called directly from a route.
   *
   * Does NOT touch the filesystem — neither the project's persistent ProjectWorkspace directory
   * (`PROJECT_WORKSPACE_ROOT/<workspaceId>`) nor any of its tasks' ephemeral workspace directories
   * (`WORKSPACES_ROOT/<taskId>`) are removed. Left as a known limitation (see docs/API.md) rather
   * than adding a new recursive-filesystem-delete code path — an orphaned directory costs disk
   * space, not correctness or safety, and can be reclaimed manually if it matters for a given
   * deployment.
   */
  deleteCascade(projectId: string): void {
    // Phase 4A — the backlog domain, deleted children-first and BEFORE tasks (task_proposals.task_id
    // references tasks). Everything is scoped by project_id, so nothing outside this project is touched.
    this.db.prepare("DELETE FROM backlog_events WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM task_proposals WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM backlog_relationships WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM backlog_analysis_jobs WHERE project_id = ?").run(projectId); // before analyses: jobs reference them
    this.db.prepare("DELETE FROM backlog_analyses WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM backlog_items WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM repository_indexes WHERE project_id = ?").run(projectId);

    const taskIds = (this.db.prepare("SELECT id FROM tasks WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id);
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM task_events WHERE task_id IN (${placeholders})`).run(...taskIds);
      this.db.prepare(`DELETE FROM agent_runs WHERE task_id IN (${placeholders})`).run(...taskIds);
      this.db.prepare(`DELETE FROM workspaces WHERE task_id IN (${placeholders})`).run(...taskIds);
      this.db.prepare(`DELETE FROM human_input_requests WHERE task_id IN (${placeholders})`).run(...taskIds);
      this.db
        .prepare(`DELETE FROM task_dependencies WHERE task_id IN (${placeholders}) OR depends_on_task_id IN (${placeholders})`)
        .run(...taskIds, ...taskIds);
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    }
    this.db.prepare("DELETE FROM project_workspaces WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }

  /** All projects — used only internally (e.g. by tests); the API always scopes by owner. See listByOwner. */
  list(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }

  /** The access-scoped listing every authenticated request actually uses — see /docs/AUTHENTICATION.md "Authorization model". */
  listByOwner(ownerId: string): Project[] {
    const rows = this.db
      .prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC")
      .all(ownerId) as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }
}
