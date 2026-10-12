import type { DatabaseSync } from "node:sqlite";
import { scopeProjectToRepo, type Project, type ProjectCommands, type ProjectRepo } from "../../domain/types.js";
import { ProjectRepoRepository } from "./project-repo-repository.js";
import { runInTransaction } from "../transaction.js";

interface ProjectRow {
  id: string;
  /** From the joined PRIMARY project_repos row (TD-62) — null when the project has no repository yet. */
  primary_repo_id: string | null;
  primary_repo_url: string | null;
  primary_default_branch: string | null;
  primary_source_control_provider: string | null;
  primary_owner: string | null;
  primary_repo: string | null;
  primary_commands_json: string | null;
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

// The legacy repository columns on `projects` are never read (see migration 028) — a Project's
// repository fields come from its primary project_repos row, or are empty when it has none.
function rowToProject(row: ProjectRow): Project {
  const hasRepo = row.primary_repo_id !== null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    name: row.name,
    repositoryId: row.primary_repo_id,
    repoUrl: hasRepo ? row.primary_repo_url! : "",
    defaultBranch: hasRepo ? row.primary_default_branch! : "",
    codingEngine: row.coding_engine,
    sourceControlProvider: hasRepo ? row.primary_source_control_provider! : "",
    owner: hasRepo ? row.primary_owner : null,
    repo: hasRepo ? row.primary_repo : null,
    commands: hasRepo && row.primary_commands_json ? (JSON.parse(row.primary_commands_json) as ProjectCommands) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_PROJECT = `
  SELECT p.*, r.id AS primary_repo_id, r.repo_url AS primary_repo_url, r.default_branch AS primary_default_branch,
         r.source_control_provider AS primary_source_control_provider, r.owner AS primary_owner, r.repo AS primary_repo,
         r.commands_json AS primary_commands_json
  FROM projects p
  LEFT JOIN project_repos r ON r.id = (SELECT id FROM project_repos WHERE project_id = p.id ORDER BY created_at, rowid LIMIT 1)`;

export class ProjectRepository {
  private readonly repos: ProjectRepoRepository;

  constructor(private readonly db: DatabaseSync) {
    this.repos = new ProjectRepoRepository(db);
  }

  /** The project's repositories, primary first (TD-62). */
  listRepos(projectId: string): ProjectRepo[] {
    return this.repos.listByProject(projectId);
  }

  /**
   * The project as seen from ONE of its repositories (TD-62) — what every repository-bound code path
   * (task execution, branch/PR reads, backlog analysis) must use. `repositoryId` null/absent means the
   * primary repository (the only one, for any project created before multi-repository projects). A
   * repositoryId that doesn't belong to the project returns null rather than silently falling back.
   */
  findScoped(projectId: string, repositoryId: string | null | undefined): Project | null {
    const project = this.findById(projectId);
    if (!project || !repositoryId) return project;
    const repo = this.repos.findById(repositoryId);
    if (!repo || repo.projectId !== projectId) return null;
    return scopeProjectToRepo(project, repo);
  }

  /**
   * Inserts the project. When it carries repository fields (`repoUrl` non-empty) — every project created
   * before multi-repository projects existed, and the single-call "project + its one repository" shape
   * tests and the CLI tools still use — that repository is inserted too, as the project's primary one.
   * The legacy repository columns on `projects` get empty values otherwise; they're never read.
   */
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
    if (project.repoUrl) {
      this.db
        .prepare(
          `INSERT INTO project_repos
            (id, project_id, name, repo_url, default_branch, source_control_provider, owner, repo, commands_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.repositoryId ?? project.id,
          project.id,
          project.repo || "repository",
          project.repoUrl,
          project.defaultBranch,
          project.sourceControlProvider,
          project.owner,
          project.repo,
          project.commands ? JSON.stringify(project.commands) : null,
          project.createdAt,
          project.updatedAt,
        );
    }
  }

  findById(id: string): Project | null {
    const row = this.db.prepare(`${SELECT_PROJECT} WHERE p.id = ?`).get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  }

  /**
   * Persists commands on the project's PRIMARY repository — the pre-multi-repository API shape.
   * Commands are per repository now (ProjectRepoRepository.updateCommands); this stays only so the
   * project-level endpoint keeps meaning what it always meant for a single-repository project.
   */
  updateCommands(id: string, commands: ProjectCommands, now: string): void {
    this.db
      .prepare(
        `UPDATE project_repos SET commands_json = ?, updated_at = ?
         WHERE id = (SELECT id FROM project_repos WHERE project_id = ? ORDER BY created_at, rowid LIMIT 1)`,
      )
      .run(JSON.stringify(commands), now, id);
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
  }

  /**
   * Deletes a project and everything scoped to it, children before parents (foreign keys are enforced
   * — see persistence/db.ts's `PRAGMA foreign_keys = ON`), inside ONE transaction: either every row
   * goes or none does, so a failure can never leave a half-deleted project behind.
   *
   * The order follows the foreign-key graph; tests/project-delete.test.ts asserts that every table
   * holding a `project_id` is covered, so a new project-scoped table can't silently start blocking
   * deletes again (it did once: chat and bulk-import tables added after this method was written made
   * every project that had ever opened its Overview undeletable).
   *
   * Callers must check ProjectService.delete's active-task guard *before* calling this — this method
   * itself performs no such check, so it must never be called directly from a route.
   *
   * Does NOT touch the filesystem — neither the project's persistent ProjectWorkspace directory
   * (`PROJECT_WORKSPACE_ROOT/<workspaceId>`) nor any of its tasks' ephemeral workspace directories
   * (`WORKSPACES_ROOT/<taskId>`) are removed. Left as a known limitation (see docs/API.md) rather
   * than adding a new recursive-filesystem-delete code path — an orphaned directory costs disk
   * space, not correctness or safety, and can be reclaimed manually if it matters for a given
   * deployment.
   */
  deleteCascade(projectId: string): void {
    runInTransaction(this.db, () => {
      const del = (sql: string, ...params: string[]) => this.db.prepare(sql).run(...params);

      // Chat (references tasks, backlog imports and bulk jobs — so it goes first).
      del("DELETE FROM chat_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE project_id = ?)", projectId);
      del("DELETE FROM chat_conversations WHERE project_id = ?", projectId);

      // Bulk backlog import/analysis (Phase 4B) and human adjudication (Phase 4B.1+).
      del("DELETE FROM backlog_bulk_job_items WHERE bulk_job_id IN (SELECT id FROM backlog_bulk_jobs WHERE project_id = ?)", projectId);
      del("DELETE FROM backlog_bulk_jobs WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_import_rows WHERE import_id IN (SELECT id FROM backlog_imports WHERE project_id = ?)", projectId);
      del("DELETE FROM backlog_imports WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_review_judgments WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_relationship_judgments WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_adjudication_baselines WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_operation_events WHERE project_id = ?", projectId);

      // The backlog domain (Phase 4A), BEFORE tasks: task_proposals.task_id references tasks.
      del("DELETE FROM backlog_events WHERE project_id = ?", projectId);
      del("DELETE FROM task_proposals WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_relationships WHERE project_id = ?", projectId);
      del("DELETE FROM claim_verification_jobs WHERE project_id = ?", projectId); // before analyses/items: jobs reference both
      del("DELETE FROM claim_verifications WHERE project_id = ?", projectId); // before analyses: records reference them
      del("DELETE FROM backlog_analysis_jobs WHERE project_id = ?", projectId); // before analyses: jobs reference them
      del("DELETE FROM backlog_analyses WHERE project_id = ?", projectId);
      del("DELETE FROM backlog_items WHERE project_id = ?", projectId);
      del("DELETE FROM repository_indexes WHERE project_id = ?", projectId);

      // Tasks and everything that belongs to one of them.
      const taskScope = "SELECT id FROM tasks WHERE project_id = ?";
      del(`DELETE FROM task_events WHERE task_id IN (${taskScope})`, projectId);
      del(`DELETE FROM agent_runs WHERE task_id IN (${taskScope})`, projectId);
      del(`DELETE FROM workspaces WHERE task_id IN (${taskScope})`, projectId);
      del(`DELETE FROM human_input_requests WHERE task_id IN (${taskScope})`, projectId);
      del(`DELETE FROM task_dependencies WHERE task_id IN (${taskScope}) OR depends_on_task_id IN (${taskScope})`, projectId, projectId);
      del("DELETE FROM tasks WHERE project_id = ?", projectId);

      del("DELETE FROM project_workspaces WHERE project_id = ?", projectId);
      del("DELETE FROM project_repos WHERE project_id = ?", projectId); // after tasks/backlog items: they reference it
      del("DELETE FROM projects WHERE id = ?", projectId);
    });
  }

  /** All projects — used only internally (e.g. by tests); the API always scopes by owner. See listByOwner. */
  list(): Project[] {
    const rows = this.db.prepare(`${SELECT_PROJECT} ORDER BY p.created_at DESC`).all() as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }

  /** The access-scoped listing every authenticated request actually uses — see /docs/AUTHENTICATION.md "Authorization model". */
  listByOwner(ownerId: string): Project[] {
    const rows = this.db
      .prepare(`${SELECT_PROJECT} WHERE p.owner_id = ? ORDER BY p.created_at DESC`)
      .all(ownerId) as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }
}
