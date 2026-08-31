import type { DatabaseSync } from "node:sqlite";
import type { Workspace, WorkspaceStatus } from "../../domain/types.js";

interface WorkspaceRow {
  id: string;
  task_id: string;
  provider: string;
  path: string;
  repo_url: string;
  branch: string;
  base_commit: string | null;
  status: string;
  created_at: string;
  destroyed_at: string | null;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    path: row.path,
    repoUrl: row.repo_url,
    branch: row.branch,
    baseCommit: row.base_commit,
    status: row.status as WorkspaceStatus,
    createdAt: row.created_at,
    destroyedAt: row.destroyed_at,
  };
}

export class WorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(workspace: Workspace): void {
    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, task_id, provider, path, repo_url, branch, base_commit, status, created_at, destroyed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        workspace.taskId,
        workspace.provider,
        workspace.path,
        workspace.repoUrl,
        workspace.branch,
        workspace.baseCommit,
        workspace.status,
        workspace.createdAt,
        workspace.destroyedAt,
      );
  }

  findByTaskId(taskId: string): Workspace | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  updateStatus(id: string, status: WorkspaceStatus, destroyedAt: string | null): void {
    this.db
      .prepare("UPDATE workspaces SET status = ?, destroyed_at = ? WHERE id = ?")
      .run(status, destroyedAt, id);
  }
}
