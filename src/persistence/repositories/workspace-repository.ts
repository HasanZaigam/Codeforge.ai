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
  active_generation: number;
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

  /**
   * Smallest-safe fencing around workspace reuse (see /docs/SECURITY_ARCHITECTURE.md,
   * migrations/009_lock_generation.sql): claims this workspace directory for
   * `generation`, strictly-increasing only — a generation lower than or
   * equal to whatever is already recorded loses the claim. Called by
   * Orchestrator.provisionWorkspace right before handing a (possibly
   * reused) "ready" workspace back to its execution path, so two different
   * execution generations can never both believe they're the current,
   * legitimate writer of the same on-disk checkout at once: whichever loses
   * this UPDATE must treat it as lease-lost and stop before touching the
   * filesystem. Does not itself provide per-generation isolation (still one
   * directory per task, not one per generation) — see provisionWorkspace's
   * own doc comment for why that's an intentionally narrow, non-redesigning
   * fix. Returns true iff this call's generation is now the recorded owner.
   */
  claimForGeneration(id: string, generation: number): boolean {
    const result = this.db
      .prepare("UPDATE workspaces SET active_generation = ? WHERE id = ? AND active_generation < ?")
      .run(generation, id, generation);
    return result.changes > 0;
  }

  /**
   * V1.1 Slice 4 — true iff `generation` is ALREADY the recorded owner (not merely eligible to
   * become it). Added so Orchestrator.provisionWorkspace's reuse path can treat "this generation
   * already claimed this workspace" as a no-op success rather than calling `claimForGeneration`
   * again — which, by design (see that method's own doc comment: "strictly-increasing only"), fails
   * a SECOND call with the SAME generation, since `active_generation < generation` is false once
   * `active_generation` already equals it. That distinction never mattered before this slice (a
   * generation was previously claimed here at most once, ever); it does now that an
   * infrastructure-retried episode can legitimately re-enter provisioning multiple times within the
   * SAME generation (see orchestrator.ts's runEpisodeWithInfrastructureRetry). Read-only — never
   * itself a claim, and deliberately doesn't change `claimForGeneration`'s own strictly-increasing
   * semantics, which tests/concurrency.test.ts pins down for a genuinely different generation.
   */
  isClaimedForGeneration(id: string, generation: number): boolean {
    const row = this.db.prepare("SELECT active_generation FROM workspaces WHERE id = ?").get(id) as { active_generation: number } | undefined;
    return row !== undefined && row.active_generation === generation;
  }
}
