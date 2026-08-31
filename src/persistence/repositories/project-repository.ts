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
