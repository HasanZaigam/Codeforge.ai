import { randomUUID } from "node:crypto";
import type { Project, ProjectCommands, ProjectWorkspace } from "../domain/types.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { ProjectWorkspaceRepository } from "../persistence/repositories/project-workspace-repository.js";
import type { ProjectWorkspaceFsManager } from "../project-workspace/project-workspace-fs-manager.js";
import type { ProjectContextService } from "../project-workspace/project-context-service.js";
import type { ProjectContextManifest } from "../project-workspace/project-context-manifest.js";
import type { GitHubIntegrationService } from "./github-integration-service.js";
import { assertProjectAccess } from "./authorization.js";
import { InvalidRepositoryError, LocalGitProjectsDisabledError, ProjectWorkspaceMissingError } from "./errors.js";
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
    private readonly projectWorkspaces: ProjectWorkspaceRepository,
    private readonly projectWorkspaceFs: ProjectWorkspaceFsManager,
    private readonly projectContext: ProjectContextService,
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

    // Phase 3 — Project Workspace, Slice 1: eager creation, converged after the github/local-git
    // branch above so it happens exactly once regardless of provider (see
    // domain/types.ts ProjectWorkspace's own doc comment for why this is a distinct concept from
    // the existing task-execution Workspace). Project-insert and workspace-insert are two separate
    // statements — this codebase has no cross-statement transactions (see persistence/db.ts) — but
    // `UNIQUE(project_id)` on project_workspaces (migrations/011_project_workspace.sql) is the
    // structural backstop against ever ending up with two, so no transaction wrapper is introduced
    // just for this.
    const workspace: ProjectWorkspace = {
      id: randomUUID(),
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
    };
    this.projectWorkspaces.insert(workspace);

    // Phase 3 — Slice 3: provision the persistent, project-scoped filesystem directory for the
    // ProjectWorkspace row just inserted. Deliberately after the DB insert, not wrapped together
    // with it: this codebase has no cross-statement transactions (same posture as the
    // project/ProjectWorkspace insert pair above), so a filesystem failure here surfaces as a clear
    // thrown error (ProjectWorkspaceProvisionError) without corrupting or duplicating either DB row
    // — a subsequent getWorkspace() call self-heals by retrying provisioning (see below).
    this.projectWorkspaceFs.ensureWorkspace(workspace.id);

    // Phase 3 — Slice 5: establish the default Project Context Manifest for the ProjectWorkspace
    // just provisioned. Same posture as the filesystem-provisioning step above — no cross-statement
    // transaction, a failure here surfaces as a clear thrown error, and a subsequent getContext()
    // call self-heals via ensureManifest's own idempotency (see ProjectContextService).
    this.projectContext.ensureManifest(workspace.id, project.name);

    return project;
  }

  get(id: string, actorId: string): Project {
    return assertProjectAccess(this.projects, id, actorId);
  }

  /**
   * Returns the caller's project's `ProjectWorkspace`. `create()` always creates exactly one
   * eagerly, so a missing row here is a genuinely exceptional, diagnosable data-integrity gap
   * (see ProjectWorkspaceMissingError's own doc comment for why) — never lazily auto-created here,
   * which would silently mask whatever produced the gap.
   */
  getWorkspace(projectId: string, actorId: string): ProjectWorkspace {
    assertProjectAccess(this.projects, projectId, actorId);
    const workspace = this.projectWorkspaces.findByProjectId(projectId);
    if (!workspace) throw new ProjectWorkspaceMissingError(projectId);
    // Idempotently (re-)provisions the directory if it's missing — the only real-world case this
    // ever does anything is a row backfilled by migrations/011_project_workspace.sql for a project
    // that existed before Slice 3 shipped (never provisioned at creation time), or self-healing
    // after a prior create()'s filesystem step failed. A row whose directory already exists is left
    // completely untouched — see ProjectWorkspaceFsManager.ensureWorkspace's own doc comment.
    // Synchronous (mkdirSync under the hood) so this stays a synchronous method like every other
    // read on this service, rather than forcing an async signature change onto its route/tests.
    this.projectWorkspaceFs.ensureWorkspace(workspace.id);
    return workspace;
  }

  list(actorId: string): Project[] {
    return this.projects.listByOwner(actorId);
  }

  /**
   * Phase 3, Slice 5 — returns the caller's project's Project Context Manifest, creating the
   * default one first if none exists yet (the only real-world case: a ProjectWorkspace whose
   * directory predates this slice, or a migration-011-backfilled project — see
   * ProjectContextService.ensureManifest's own doc comment). Authorization happens here, at the
   * application boundary, exactly like `getWorkspace` — `ProjectContextService` itself performs
   * none.
   */
  getContext(projectId: string, actorId: string): ProjectContextManifest {
    const project = assertProjectAccess(this.projects, projectId, actorId);
    const workspace = this.projectWorkspaces.findByProjectId(projectId);
    if (!workspace) throw new ProjectWorkspaceMissingError(projectId);
    return this.projectContext.ensureManifest(workspace.id, project.name);
  }

  /**
   * Phase 3, Slices 5 & 7 — validates and atomically replaces the caller's project's Project
   * Context Manifest. `input` is untrusted, caller-supplied data (an HTTP PUT body) — see
   * ProjectContextService.replaceManifest for the validate-before-write guarantee that keeps an
   * invalid submission from ever touching the previously-stored manifest, and for the
   * revision-checked optimistic-concurrency guarantee (throws `ProjectContextConflictError`,
   * mapped to `409` — see error-middleware.ts) that keeps a stale submission from silently
   * overwriting a newer one.
   */
  updateContext(projectId: string, actorId: string, input: unknown): ProjectContextManifest {
    assertProjectAccess(this.projects, projectId, actorId);
    const workspace = this.projectWorkspaces.findByProjectId(projectId);
    if (!workspace) throw new ProjectWorkspaceMissingError(projectId);
    return this.projectContext.replaceManifest(workspace.id, input);
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
