import type { DatabaseSync } from "node:sqlite";
import type { ProjectCommands, ProjectRepo } from "../../domain/types.js";

interface ProjectRepoRow {
  id: string;
  project_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  source_control_provider: string;
  owner: string | null;
  repo: string | null;
  commands_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRepo(row: ProjectRepoRow): ProjectRepo {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    sourceControlProvider: row.source_control_provider,
    owner: row.owner,
    repo: row.repo,
    commands: row.commands_json ? (JSON.parse(row.commands_json) as ProjectCommands) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True iff `err` is the UNIQUE(project_id, name) violation on project_repos — a duplicate repository label within one project. */
export function isDuplicateRepoNameViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed:\s*project_repos\.project_id,\s*project_repos\.name/i.test(err.message);
}

/**
 * The repositories connected to each project (TD-62). Ordered by connection time everywhere: the
 * first one is the project's PRIMARY repository — the fallback for anything that predates
 * multi-repository projects or doesn't name a repository explicitly.
 */
export class ProjectRepoRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(repo: ProjectRepo): void {
    this.db
      .prepare(
        `INSERT INTO project_repos
          (id, project_id, name, repo_url, default_branch, source_control_provider, owner, repo, commands_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo.id,
        repo.projectId,
        repo.name,
        repo.repoUrl,
        repo.defaultBranch,
        repo.sourceControlProvider,
        repo.owner,
        repo.repo,
        repo.commands ? JSON.stringify(repo.commands) : null,
        repo.createdAt,
        repo.updatedAt,
      );
  }

  findById(id: string): ProjectRepo | null {
    const row = this.db.prepare("SELECT * FROM project_repos WHERE id = ?").get(id) as ProjectRepoRow | undefined;
    return row ? rowToRepo(row) : null;
  }

  listByProject(projectId: string): ProjectRepo[] {
    const rows = this.db
      .prepare("SELECT * FROM project_repos WHERE project_id = ? ORDER BY created_at, rowid")
      .all(projectId) as unknown as ProjectRepoRow[];
    return rows.map(rowToRepo);
  }

  findPrimary(projectId: string): ProjectRepo | null {
    return this.listByProject(projectId)[0] ?? null;
  }

  update(id: string, fields: { name: string; defaultBranch: string }, now: string): void {
    this.db.prepare("UPDATE project_repos SET name = ?, default_branch = ?, updated_at = ? WHERE id = ?").run(fields.name, fields.defaultBranch, now, id);
  }

  updateCommands(id: string, commands: ProjectCommands, now: string): void {
    this.db.prepare("UPDATE project_repos SET commands_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(commands), now, id);
  }

  /** How many tasks and backlog items still point at this repository — a repository in use can't be removed. */
  countUsage(id: string): { tasks: number; backlogItems: number } {
    const tasks = (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE repository_id = ?").get(id) as { n: number }).n;
    const backlogItems = (this.db.prepare("SELECT COUNT(*) AS n FROM backlog_items WHERE repository_id = ?").get(id) as { n: number }).n;
    return { tasks, backlogItems };
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM project_repos WHERE id = ?").run(id);
  }
}
