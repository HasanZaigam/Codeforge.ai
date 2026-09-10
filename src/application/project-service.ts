import { randomUUID } from "node:crypto";
import type { Project, ProjectCommands } from "../domain/types.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { GitHubIntegrationService } from "./github-integration-service.js";
import { assertProjectAccess } from "./authorization.js";
import { InvalidRepositoryError, LocalGitProjectsDisabledError } from "./errors.js";
import { GitHubNotFoundError } from "../integrations/github/github-client.js";
import { isLocalGitProjectsAllowed } from "../config/startup-config.js";
import { parseGitHubRepoUrl } from "../api/schemas.js";

interface CreateProjectCommon {
  name: string;
  codingEngine?: string;
  commands?: ProjectCommands;
}

export interface CreateGitHubProjectInput extends CreateProjectCommon {
  sourceControlProvider: "github";
  owner: string;
  repo: string;
  /** If omitted, the repository's own default branch (from GitHub) is used — never silently guessed otherwise. See /docs/GITHUB_INTEGRATION.md "Base branch". */
  defaultBranch?: string;
}

export interface CreateLocalGitProjectInput extends CreateProjectCommon {
  sourceControlProvider: "local-git";
  repoUrl: string;
  defaultBranch?: string;
}

export type CreateProjectInput = CreateGitHubProjectInput | CreateLocalGitProjectInput;

/**
 * Thin translation layer over ProjectRepository. Project connection is
 * config, not orchestration — there is no domain workflow to delegate to
 * here, which is why this service has no dependency on the Orchestrator.
 * See /docs/PRODUCT_REQUIREMENTS.md FR-1.
 *
 * Every read/write is scoped to the authenticated caller (`ownerId`/
 * `actorId`) — see /docs/AUTHENTICATION.md "Authorization model". There is
 * no unscoped `list()`/`get()` reachable from the API.
 *
 * For `sourceControlProvider: "github"`, `create()` never trusts the
 * client-supplied owner/repo blindly — see /docs/GITHUB_INTEGRATION.md
 * "Repository connection": it calls GitHub (with the caller's own connected
 * credential) to confirm the repository exists, is accessible, and the
 * requested branch (or the repository's real default branch) exists,
 * before ever persisting the project or touching a workspace.
 */
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly github: GitHubIntegrationService,
  ) {}

  async create(input: CreateProjectInput, ownerId: string): Promise<Project> {
    const now = new Date().toISOString();
    const base: Pick<Project, "id" | "tenantId" | "ownerId" | "name" | "codingEngine" | "commands" | "createdAt" | "updatedAt"> = {
      id: randomUUID(),
      tenantId: "default",
      ownerId,
      name: input.name,
      codingEngine: input.codingEngine ?? (process.env.CODING_ENGINE ?? "opencode"),
      commands: input.commands ?? null,
      createdAt: now,
      updatedAt: now,
    };

    let project: Project;
    if (input.sourceControlProvider === "github") {
      const { repoUrl, owner, repo, defaultBranch } = await this.verifyGitHubRepository(ownerId, input);
      project = { ...base, sourceControlProvider: "github", repoUrl, owner, repo, defaultBranch };
    } else {
      // Enforced here, not just in the request schema, so it can't be bypassed by any request
      // shape — see /docs/GITHUB_INTEGRATION.md "Local git / plain-git testing" and
      // ALLOW_LOCAL_GIT_PROJECTS in /docs/DEPLOYMENT.md.
      if (!isLocalGitProjectsAllowed()) {
        throw new LocalGitProjectsDisabledError();
      }
      project = {
        ...base,
        sourceControlProvider: "local-git",
        repoUrl: input.repoUrl,
        owner: null,
        repo: null,
        defaultBranch: input.defaultBranch ?? "main",
      };
    }

    this.projects.insert(project);
    return project;
  }

  get(id: string, actorId: string): Project {
    return assertProjectAccess(this.projects, id, actorId);
  }

  list(actorId: string): Project[] {
    return this.projects.listByOwner(actorId);
  }

  /**
   * The "Validate repository" step of the URL-paste project-connection flow
   * (see /docs/GITHUB_INTEGRATION.md "Repository connection" and
   * web/src/components/projects/CreateProjectDialog.tsx). Parses/normalizes
   * `repoUrl` server-side (never trusts client-side URL parsing alone — see
   * schemas.ts `parseGitHubRepoUrl`), then makes the exact same real GitHub
   * API calls `create()` itself would make to confirm the repository exists,
   * is accessible with the caller's connected credential, and the requested
   * (or repository-default) branch exists — so a caller can be honest that
   * this checked live GitHub reachability/permissions, not just URL shape.
   * Returns everything the UI needs to render the derived identity and an
   * auto-suggested (but always user-editable) project name.
   */
  async verifyGitHubRepositoryUrl(
    ownerId: string,
    repoUrl: string,
    defaultBranch?: string,
  ): Promise<{ repoUrl: string; owner: string; repo: string; defaultBranch: string; suggestedName: string }> {
    const parsed = parseGitHubRepoUrl(repoUrl);
    if (!parsed) {
      throw new InvalidRepositoryError(
        "That doesn't look like a GitHub repository URL. Expected something like https://github.com/owner/repo.",
      );
    }
    const verified = await this.verifyGitHubRepository(ownerId, { owner: parsed.owner, repo: parsed.repo, defaultBranch });
    return { ...verified, suggestedName: verified.repo };
  }

  private async verifyGitHubRepository(
    ownerId: string,
    input: { owner: string; repo: string; defaultBranch?: string },
  ): Promise<{ repoUrl: string; owner: string; repo: string; defaultBranch: string }> {
    const client = this.github.clientForUser(ownerId); // throws GitHubNotConnectedError if not connected — see error-middleware.ts
    let repository;
    try {
      repository = await client.getRepository(input.owner, input.repo);
    } catch (err) {
      // A missing/inaccessible repo is a client input problem (400), not an upstream failure (502).
      if (err instanceof GitHubNotFoundError) throw new InvalidRepositoryError(err.message);
      throw err;
    }

    const branch = input.defaultBranch ?? repository.defaultBranch;
    const branchInfo = await client.getBranch(input.owner, input.repo, branch);
    if (!branchInfo) {
      throw new InvalidRepositoryError(`Branch "${branch}" does not exist in ${input.owner}/${input.repo}`);
    }

    return { repoUrl: `https://github.com/${input.owner}/${input.repo}.git`, owner: input.owner, repo: input.repo, defaultBranch: branch };
  }
}
