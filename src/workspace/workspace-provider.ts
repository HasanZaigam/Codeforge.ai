import type { GitCredential, Workspace } from "../domain/types.js";

export interface ProvisionWorkspaceRequest {
  taskId: string;
  repoUrl: string;
  /**
   * The branch to clone from. Mode "new": the base branch a new `taskBranch`
   * is created from. Mode "existing": identical to `taskBranch` itself — the
   * clone checks out the target branch directly, and no new branch is ever
   * created (see `mode`).
   */
  baseBranch: string;
  /** Deterministic per-task branch name so re-provisioning after a crash is idempotent. */
  taskBranch: string;
  /**
   * "new" (default, omitted = "new" for backward compatibility): create
   * `taskBranch` from `baseBranch`, exactly as this always worked before
   * branch-mode existed. "existing": check out `taskBranch` directly (it
   * already exists on the remote) — never creates or renames a branch. See
   * /docs/TASK_LIFECYCLE.md "Branch modes".
   */
  mode?: "new" | "existing";
}

/**
 * Provisions and tears down the isolated environment a task's agent
 * invocations read/write. One workspace per task; concurrent tasks never
 * share a path, so two tasks can never accidentally modify the same
 * checkout (see /docs/ARCHITECTURE.md layer 10, /docs/SECURITY_ARCHITECTURE.md).
 *
 * Deliberately provider-agnostic about credentials: it accepts an opaque
 * `GitCredential` (resolved by the project's `SourceControlProvider`, see
 * source-control-provider.ts) purely to authenticate the clone of a private
 * repository — it never persists it to the workspace's git config, and has
 * no idea whether it came from GitHub, GitLab, or nothing at all. See
 * /docs/GITHUB_INTEGRATION.md "Credential exposure boundary".
 */
export interface WorkspaceProvider {
  readonly key: string;
  /**
   * Idempotent: calling again for a taskId that already has a ready
   * workspace returns it unchanged. `signal`, if aborted while cloning is
   * in progress, should stop the underlying process and reject with
   * CancellationError (see /domain/errors.ts) rather than leaving it running.
   */
  provision(request: ProvisionWorkspaceRequest, signal?: AbortSignal, credential?: GitCredential | null): Promise<Workspace>;
  destroy(workspace: Workspace): Promise<void>;
}
