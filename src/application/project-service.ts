import { randomUUID } from "node:crypto";
import { scopeProjectToRepo, type Project, type ProjectCommands, type ProjectRepo, type ProjectWorkspace } from "../domain/types.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import { isDuplicateRepoNameViolation, type ProjectRepoRepository } from "../persistence/repositories/project-repo-repository.js";
import type { ProjectWorkspaceRepository } from "../persistence/repositories/project-workspace-repository.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { ProjectWorkspaceFsManager } from "../project-workspace/project-workspace-fs-manager.js";
import type { ProjectContextService } from "../project-workspace/project-context-service.js";
import type { ProjectContextManifest } from "../project-workspace/project-context-manifest.js";
import type { GitHubIntegrationService } from "./github-integration-service.js";
import { assertProjectAccess } from "./authorization.js";
import {
  DuplicateRepositoryNameError,
  InvalidRepositoryError,
  LocalGitProjectsDisabledError,
  NotFoundError,
  ProjectHasActiveTasksError,
  ProjectWorkspaceMissingError,
  RepositoryInUseError,
} from "./errors.js";
import { resolveRepositoryFor } from "./repository-resolution.js";
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

/** A project with no repository yet — repositories are connected afterwards (TD-62). */
export interface CreateEmptyProjectInput extends CreateProjectCommon {
  sourceControlProvider?: undefined;
}

export type CreateProjectInput = CreateGitHubProjectInput | CreateLocalGitProjectInput | CreateEmptyProjectInput;

/** Connecting one repository to an existing project. `name` defaults to the repository's own name. */
export type AddRepositoryInput =
  | { sourceControlProvider: "github"; name?: string; owner: string; repo: string; defaultBranch?: string }
  | { sourceControlProvider: "local-git"; name?: string; repoUrl: string; defaultBranch?: string };

function defaultRepoName(input: AddRepositoryInput): string {
  if (input.name?.trim()) return input.name.trim();
  if (input.sourceControlProvider === "github") return input.repo;
  const last = input.repoUrl.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return last.replace(/\.git$/, "") || "repository";
}

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
    private readonly tasks: TaskRepository,
    private readonly projectRepos: ProjectRepoRepository,
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

    // Verify the optional first repository BEFORE persisting anything, so a bad repository never
    // leaves an orphaned, repository-less project behind (same posture as before TD-62).
    const firstRepo = input.sourceControlProvider ? await this.prepareRepository(ownerId, input) : null;

    const project: Project = {
      ...base,
      repositoryId: null,
      repoUrl: "",
      defaultBranch: "",
      sourceControlProvider: "",
      owner: null,
      repo: null,
    };
    this.projects.insert(project);
    if (firstRepo) this.projectRepos.insert({ ...firstRepo, projectId: project.id, commands: input.commands ?? null });

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

    return this.projects.findById(project.id)!;
  }

  // ---------------------------------------------------------------------
  // Repositories (TD-62)
  // ---------------------------------------------------------------------

  listRepositories(projectId: string, actorId: string): ProjectRepo[] {
    assertProjectAccess(this.projects, projectId, actorId);
    return this.projectRepos.listByProject(projectId);
  }

  getRepository(projectId: string, repositoryId: string, actorId: string): ProjectRepo {
    assertProjectAccess(this.projects, projectId, actorId);
    const repo = this.projectRepos.findById(repositoryId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundError("ProjectRepo", repositoryId);
    return repo;
  }

  /** The project as seen from one of its repositories — what anything repository-bound must use. */
  scopedProject(projectId: string, repositoryId: string | null | undefined, actorId: string): Project {
    const project = assertProjectAccess(this.projects, projectId, actorId);
    return scopeProjectToRepo(project, resolveRepositoryFor(this.projectRepos.listByProject(projectId), repositoryId));
  }

  /** Connects one more repository. GitHub repositories are verified with a real API call first, exactly like project creation. */
  async addRepository(projectId: string, actorId: string, input: AddRepositoryInput): Promise<ProjectRepo> {
    assertProjectAccess(this.projects, projectId, actorId);
    const repo = { ...(await this.prepareRepository(actorId, input)), projectId };
    const existing = this.projectRepos.listByProject(projectId);
    if (existing.some((r) => r.name.toLowerCase() === repo.name.toLowerCase())) throw new DuplicateRepositoryNameError(repo.name);
    if (existing.some((r) => r.repoUrl === repo.repoUrl)) {
      throw new InvalidRepositoryError(`${repo.repoUrl} is already connected to this project.`);
    }
    try {
      this.projectRepos.insert(repo);
    } catch (err) {
      if (isDuplicateRepoNameViolation(err)) throw new DuplicateRepositoryNameError(repo.name);
      throw err;
    }
    return this.projectRepos.findById(repo.id)!;
  }

  /** Renames a repository and/or changes its default branch (a GitHub branch is checked to exist first). */
  async updateRepository(
    projectId: string,
    repositoryId: string,
    actorId: string,
    input: { name?: string; defaultBranch?: string },
  ): Promise<ProjectRepo> {
    const repo = this.getRepository(projectId, repositoryId, actorId);
    const name = input.name?.trim() || repo.name;
    const defaultBranch = input.defaultBranch?.trim() || repo.defaultBranch;
    if (name.toLowerCase() !== repo.name.toLowerCase() && this.projectRepos.listByProject(projectId).some((r) => r.id !== repo.id && r.name.toLowerCase() === name.toLowerCase())) {
      throw new DuplicateRepositoryNameError(name);
    }
    if (defaultBranch !== repo.defaultBranch && repo.sourceControlProvider === "github" && repo.owner && repo.repo) {
      const branch = await this.github.clientForUser(actorId).getBranch(repo.owner, repo.repo, defaultBranch);
      if (!branch) throw new InvalidRepositoryError(`Branch "${defaultBranch}" does not exist in ${repo.owner}/${repo.repo}`);
    }
    try {
      this.projectRepos.update(repo.id, { name, defaultBranch }, new Date().toISOString());
    } catch (err) {
      if (isDuplicateRepoNameViolation(err)) throw new DuplicateRepositoryNameError(name);
      throw err;
    }
    return this.projectRepos.findById(repo.id)!;
  }

  /** Full replacement of one repository's validation commands — same semantics as the project-level updateCommands. */
  updateRepositoryCommands(projectId: string, repositoryId: string, actorId: string, commands: ProjectCommands): ProjectRepo {
    const repo = this.getRepository(projectId, repositoryId, actorId);
    this.projectRepos.updateCommands(repo.id, commands, new Date().toISOString());
    return this.projectRepos.findById(repo.id)!;
  }

  /** Disconnects a repository from the project. Refused while any task or backlog item targets it. Touches nothing on GitHub. */
  removeRepository(projectId: string, repositoryId: string, actorId: string): void {
    const repo = this.getRepository(projectId, repositoryId, actorId);
    const usage = this.projectRepos.countUsage(repo.id);
    if (usage.tasks > 0 || usage.backlogItems > 0) throw new RepositoryInUseError(repo.name, usage);
    this.projectRepos.delete(repo.id);
  }

  /** Verifies (GitHub) or policy-checks (local-git) a repository and returns the row to insert — persists nothing. */
  private async prepareRepository(ownerId: string, input: AddRepositoryInput): Promise<ProjectRepo> {
    const now = new Date().toISOString();
    const common = { id: randomUUID(), projectId: "", name: defaultRepoName(input), commands: null, createdAt: now, updatedAt: now };
    if (input.sourceControlProvider === "github") {
      const { repoUrl, owner, repo, defaultBranch } = await this.verifyGitHubRepository(ownerId, input);
      return { ...common, sourceControlProvider: "github", repoUrl, owner, repo, defaultBranch };
    }
    // Enforced here, not just in the request schema, so it can't be bypassed by any request
    // shape — see /docs/GITHUB_INTEGRATION.md "Local git / plain-git testing" and
    // ALLOW_LOCAL_GIT_PROJECTS in /docs/DEPLOYMENT.md.
    if (!isLocalGitProjectsAllowed()) throw new LocalGitProjectsDisabledError();
    return { ...common, sourceControlProvider: "local-git", repoUrl: input.repoUrl, owner: null, repo: null, defaultBranch: input.defaultBranch ?? "main" };
  }

  get(id: string, actorId: string): Project {
    return assertProjectAccess(this.projects, id, actorId);
  }

  /**
   * Declares/edits the project's build/test/lint/typecheck commands after creation — the only
   * mechanism to set them today, since `create()`'s own `commands` input has no corresponding
   * frontend UI yet. Full replacement, not a per-key merge: a field omitted from `commands` clears
   * that check (see runValidation's own doc comment — an undeclared check is *skipped*, not
   * failed, so leaving everything unset means a task gets no automated validation at all).
   */
  updateCommands(projectId: string, actorId: string, commands: ProjectCommands): Project {
    assertProjectAccess(this.projects, projectId, actorId);
    const now = new Date().toISOString();
    this.projects.updateCommands(projectId, commands, now);
    return assertProjectAccess(this.projects, projectId, actorId);
  }

  /**
   * Permanently deletes the project and everything scoped to it (see
   * ProjectRepository.deleteCascade). Blocked with `ProjectHasActiveTasksError` (409) if any task
   * is TODO/WORKING/NEEDS_INPUT (genuinely queued or executing) or REVIEW (an open Pull Request
   * still awaiting a human decision) — the caller must cancel or finish those first; this never
   * force-cancels anything on their behalf. BACKLOG/DONE/FAILED/CANCELLED tasks never block a
   * delete. Does not touch GitHub (no PR/branch is deleted there) or any filesystem workspace
   * directory — see ProjectRepository.deleteCascade's own doc comment for that scope boundary.
   */
  delete(projectId: string, actorId: string): void {
    assertProjectAccess(this.projects, projectId, actorId);
    const blockingStatuses = new Set(["TODO", "WORKING", "NEEDS_INPUT", "REVIEW"]);
    const blocking = this.tasks.listByProject(projectId).filter((t) => blockingStatuses.has(t.status));
    if (blocking.length > 0) {
      throw new ProjectHasActiveTasksError(blocking.map((t) => t.title));
    }
    this.projects.deleteCascade(projectId);
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
   *
   * On success, also bumps the owning ProjectWorkspace's own `updatedAt` (see
   * ProjectWorkspaceRepository.touchUpdatedAt) to the exact same timestamp the manifest itself was
   * just stamped with — the manifest is content that lives inside this ProjectWorkspace, so a saved
   * edit is a real update to it too, reflected in the Workspace Details screen the frontend already
   * shows. Never touched on a rejected write (invalid input, conflict, lock, oversized) — only a
   * genuinely successful save changes anything.
   */
  updateContext(projectId: string, actorId: string, input: unknown): ProjectContextManifest {
    assertProjectAccess(this.projects, projectId, actorId);
    const workspace = this.projectWorkspaces.findByProjectId(projectId);
    if (!workspace) throw new ProjectWorkspaceMissingError(projectId);
    const updated = this.projectContext.replaceManifest(workspace.id, input);
    if (updated.updatedAt) this.projectWorkspaces.touchUpdatedAt(workspace.id, updated.updatedAt);
    return updated;
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
