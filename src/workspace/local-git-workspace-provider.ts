import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProvisionWorkspaceRequest, WorkspaceProvider } from "./workspace-provider.js";
import type { GitCredential, Workspace } from "../domain/types.js";
import type { WorkspaceRepository } from "../persistence/repositories/workspace-repository.js";
import { CancellationError } from "../domain/errors.js";
import { gitCredentialEnv } from "../source-control/git-credential-env.js";

const execFileAsync = promisify(execFile);

/**
 * MVP WorkspaceProvider: a plain local git clone/worktree per task under
 * `<root>/<taskId>`, with no container/VM isolation.
 *
 * DOCUMENTED SECURITY BOUNDARY (see /docs/SECURITY_ARCHITECTURE.md): this
 * implementation does NOT sandbox the code it checks out — anything a
 * subsequent CodingEngine invocation runs (build/test commands, the engine
 * itself) executes with the same OS-level privileges as the platform
 * process. This is acceptable for local development against trusted fixture
 * repositories only. Before running this against untrusted or
 * internet-facing project repositories, this provider must be replaced with
 * a container-based implementation (the `WorkspaceProvider` interface is
 * exactly the seam that swap happens behind — no caller changes).
 */
export class LocalGitWorkspaceProvider implements WorkspaceProvider {
  readonly key = "local-git";

  constructor(
    private readonly rootDir: string,
    private readonly workspaceRepo: WorkspaceRepository,
  ) {}

  async provision(request: ProvisionWorkspaceRequest, signal?: AbortSignal, credential?: GitCredential | null): Promise<Workspace> {
    const existing = this.workspaceRepo.findByTaskId(request.taskId);
    if (existing && existing.status === "ready") {
      return existing; // idempotent: retried provisioning reuses the existing workspace
    }

    if (signal?.aborted) throw new CancellationError();

    const path = join(this.rootDir, request.taskId);
    await rm(path, { recursive: true, force: true }); // clean slate if a prior attempt partially provisioned
    await mkdir(path, { recursive: true });

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      taskId: request.taskId,
      provider: this.key,
      path,
      repoUrl: request.repoUrl,
      branch: request.taskBranch,
      baseCommit: null,
      status: "provisioning",
      createdAt: now,
      destroyedAt: null,
    };
    this.workspaceRepo.insert(workspace);

    try {
      const env = { ...process.env, ...gitCredentialEnv(credential) };
      await execFileAsync(
        "git",
        ["clone", "--branch", request.baseBranch, "--single-branch", request.repoUrl, path],
        { signal, env },
      );
      // Mode "existing" (see ProvisionWorkspaceRequest.mode doc comment): `baseBranch` already
      // equals `taskBranch` here — the clone above checked it out directly, so there is nothing
      // left to create. Mode "new" (default, and the only behavior that existed before branch
      // modes did): create the isolated task branch from the just-cloned base branch.
      if (request.mode !== "existing") {
        await execFileAsync("git", ["checkout", "-b", request.taskBranch], { cwd: path, signal });
      }
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path, signal });
      const baseCommit = stdout.trim();

      workspace.baseCommit = baseCommit;
      workspace.status = "ready";
      this.workspaceRepo.updateStatus(workspace.id, "ready", null);
      return workspace;
    } catch (err) {
      if (signal?.aborted) {
        // `execFileAsync`'s own `signal` option already killed the git process — this is
        // cancellation, not a provisioning failure. Leave the row "provisioning": the
        // Orchestrator's cancellation cleanup will tear down the partial clone directory.
        throw new CancellationError();
      }
      this.workspaceRepo.updateStatus(workspace.id, "failed", null);
      throw err;
    }
  }

  async destroy(workspace: Workspace): Promise<void> {
    await rm(workspace.path, { recursive: true, force: true });
    this.workspaceRepo.updateStatus(workspace.id, "torn_down", new Date().toISOString());
  }
}
