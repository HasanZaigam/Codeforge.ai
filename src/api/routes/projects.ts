import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import {
  AddRepositorySchema,
  CreateProjectSchema,
  CreateTaskSchema,
  UpdateProjectCommandsSchema,
  TokenBudgetSchema,
  UpdateRepositorySchema,
  VerifyGitHubRepositorySchema,
} from "../schemas.js";
import { toProjectDTO, toProjectRepoDTO, toProjectWorkspaceDTO, toProjectContextDTO, toTaskDTO } from "../dto.js";
import type { Project } from "../../domain/types.js";
import { asyncHandler } from "../async-handler.js";
import { dependenciesFor, latestEventFor } from "./task-helpers.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";
import type { TaskDependencyRepository } from "../../persistence/repositories/task-dependency-repository.js";

/** Mounted behind requireAuth (see app.ts) — every handler here can assume req.user is set. */
export function projectsRouter(services: ApplicationServices, taskEvents: TaskEventRepository, taskDependencies: TaskDependencyRepository): Router {
  const router = Router();
  const projectDTO = (project: Project, actorId: string) => toProjectDTO(project, services.projects.listRepositories(project.id, actorId));

  router.get(
    "/projects",
    asyncHandler(async (req, res) => {
      res.json({ projects: services.projects.list(req.user!.id).map((p) => projectDTO(p, req.user!.id)) });
    }),
  );

  // Creates a project — with no repository (connect them afterwards, TD-62), or with its first one in
  // the same call (the original single-repository shape, still accepted).
  router.post(
    "/projects",
    asyncHandler(async (req, res) => {
      const input = CreateProjectSchema.parse(req.body);
      const project = await services.projects.create(input, req.user!.id);
      res.status(201).json({ project: projectDTO(project, req.user!.id) });
    }),
  );

  // The "Validate repository" step of the URL-paste connection flow (see
  // /docs/GITHUB_INTEGRATION.md "Repository connection") — a real GitHub API check (repo
  // existence/access + branch existence), never just URL-shape validation. Read-only: creates
  // nothing. Mounted before project creation so the UI can show the derived owner/repo/default
  // branch and an editable suggested name before the user commits to "Connect project".
  router.post(
    "/projects/verify-github-repo",
    asyncHandler(async (req, res) => {
      const input = VerifyGitHubRepositorySchema.parse(req.body);
      const result = await services.projects.verifyGitHubRepositoryUrl(req.user!.id, input.repoUrl);
      res.json(result);
    }),
  );

  router.get(
    "/projects/:projectId",
    asyncHandler(async (req, res) => {
      const project = services.projects.get(req.params.projectId!, req.user!.id);
      res.json({ project: projectDTO(project, req.user!.id) });
    }),
  );

  // Declares/edits build/test/lint/typecheck after the project already exists — see
  // ProjectService.updateCommands's own doc comment for why this exists (it was previously
  // impossible to set these at all outside project creation, which itself has no frontend UI for
  // them either). Full replacement of the `commands` object, not a per-key merge.
  router.patch(
    "/projects/:projectId/commands",
    asyncHandler(async (req, res) => {
      const input = UpdateProjectCommandsSchema.parse(req.body);
      const project = services.projects.updateCommands(req.params.projectId!, req.user!.id, input.commands);
      res.json({ project: projectDTO(project, req.user!.id) });
    }),
  );

  // ---- Token usage this month + optional budget (TD-63) -----------------------------------------

  router.get(
    "/projects/:projectId/token-usage",
    asyncHandler(async (req, res) => {
      res.json({ usage: services.tokenUsage.projectUsage(req.params.projectId!, req.user!.id) });
    }),
  );

  router.put(
    "/projects/:projectId/token-budget",
    asyncHandler(async (req, res) => {
      const input = TokenBudgetSchema.parse(req.body);
      res.json({ usage: services.tokenUsage.setProjectBudget(req.params.projectId!, req.user!.id, input.monthlyTokens) });
    }),
  );

  // ---- Repositories of a project (TD-62) -------------------------------------------------------

  router.get(
    "/projects/:projectId/repositories",
    asyncHandler(async (req, res) => {
      res.json({ repositories: services.projects.listRepositories(req.params.projectId!, req.user!.id).map(toProjectRepoDTO) });
    }),
  );

  // Connects another repository. A GitHub repository is verified with a real API call first.
  router.post(
    "/projects/:projectId/repositories",
    asyncHandler(async (req, res) => {
      const input = AddRepositorySchema.parse(req.body);
      const repository = await services.projects.addRepository(req.params.projectId!, req.user!.id, input);
      res.status(201).json({ repository: toProjectRepoDTO(repository) });
    }),
  );

  router.patch(
    "/projects/:projectId/repositories/:repositoryId",
    asyncHandler(async (req, res) => {
      const input = UpdateRepositorySchema.parse(req.body);
      const repository = await services.projects.updateRepository(req.params.projectId!, req.params.repositoryId!, req.user!.id, input);
      res.json({ repository: toProjectRepoDTO(repository) });
    }),
  );

  // Full replacement of one repository's validation commands.
  router.patch(
    "/projects/:projectId/repositories/:repositoryId/commands",
    asyncHandler(async (req, res) => {
      const input = UpdateProjectCommandsSchema.parse(req.body);
      const repository = services.projects.updateRepositoryCommands(req.params.projectId!, req.params.repositoryId!, req.user!.id, input.commands);
      res.json({ repository: toProjectRepoDTO(repository) });
    }),
  );

  // Disconnects a repository — 409 REPOSITORY_IN_USE while any task or backlog item targets it.
  router.delete(
    "/projects/:projectId/repositories/:repositoryId",
    asyncHandler(async (req, res) => {
      services.projects.removeRepository(req.params.projectId!, req.params.repositoryId!, req.user!.id);
      res.status(204).end();
    }),
  );

  // Permanently deletes the project and everything scoped to it — see ProjectService.delete's own
  // doc comment for the active-task guard (409 PROJECT_HAS_ACTIVE_TASKS) and exactly what this
  // does and does not clean up.
  router.delete(
    "/projects/:projectId",
    asyncHandler(async (req, res) => {
      services.projects.delete(req.params.projectId!, req.user!.id);
      res.status(204).end();
    }),
  );

  // Phase 3 — Project Workspace, Slice 1. System-created only in this phase: no POST/PUT/PATCH/
  // DELETE for this resource. OWNER-ONLY, same as every other /projects/:projectId route —
  // ProjectService.getWorkspace does the assertProjectAccess check itself.
  router.get(
    "/projects/:projectId/workspace",
    asyncHandler(async (req, res) => {
      const workspace = services.projects.getWorkspace(req.params.projectId!, req.user!.id);
      res.json({ workspace: toProjectWorkspaceDTO(workspace) });
    }),
  );

  // Phase 3 — Project Context Manifest, Slice 5. OWNER-ONLY, same as every other
  // /projects/:projectId route. Deliberately narrow: this is the manifest contract only, not a
  // general file API (see docs/API.md) — ProjectService.getContext lazily creates the default
  // manifest for a ProjectWorkspace that doesn't have one yet (e.g. a migration-011-backfilled
  // project), so this never 404s just because a manifest wasn't provisioned yet.
  router.get(
    "/projects/:projectId/context",
    asyncHandler(async (req, res) => {
      const context = services.projects.getContext(req.params.projectId!, req.user!.id);
      res.json({ context: toProjectContextDTO(context) });
    }),
  );

  // Full replacement, not a partial PATCH — see ProjectContextService.replaceManifest: the
  // submitted body is validated in full before anything is written, so an invalid PUT can never
  // partially overwrite a previously-valid manifest. Phase 3, Slice 7 — optimistic concurrency: the
  // body must include the `revision` the caller believes is current (normally the value it just
  // got back from GET); a stale/mismatched revision is rejected with 409 PROJECT_CONTEXT_CONFLICT
  // (currentRevision in the error body) rather than silently overwriting a newer version.
  router.put(
    "/projects/:projectId/context",
    asyncHandler(async (req, res) => {
      const context = services.projects.updateContext(req.params.projectId!, req.user!.id, req.body);
      res.json({ context: toProjectContextDTO(context) });
    }),
  );

  // Populates the "work directly on an existing branch" task-creation UI (see
  // CreateTaskDialog.tsx and SourceControlProvider.listBranches's own doc comment) — read-only,
  // advisory data; never gates anything itself.
  router.get(
    "/projects/:projectId/branches",
    asyncHandler(async (req, res) => {
      const repositoryId = typeof req.query.repositoryId === "string" && req.query.repositoryId ? req.query.repositoryId : undefined;
      const branches = await services.tasks.listBranches(req.params.projectId!, req.user!.id, repositoryId);
      res.json({ branches });
    }),
  );

  router.get(
    "/projects/:projectId/tasks",
    asyncHandler(async (req, res) => {
      const tasks = services.tasks.listForProject(req.params.projectId!, req.user!.id);
      res.json({ tasks: tasks.map((t) => toTaskDTO(t, latestEventFor(taskEvents, t.id), dependenciesFor(taskDependencies, t.id))) });
    }),
  );

  router.post(
    "/projects/:projectId/tasks",
    asyncHandler(async (req, res) => {
      const input = CreateTaskSchema.parse(req.body);
      // Task execution is deliberately NOT triggered here — creation only persists a TODO task;
      // the background worker discovers and claims it. See PRODUCT_REQUIREMENTS.md FR-4 and API.md.
      const task = await services.tasks.create({ projectId: req.params.projectId!, ...input }, req.user!.id);
      res.status(201).json({ task: toTaskDTO(task, undefined, dependenciesFor(taskDependencies, task.id)) });
    }),
  );

  return router;
}
