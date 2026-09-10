import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { CreateProjectSchema, CreateTaskSchema, VerifyGitHubRepositorySchema } from "../schemas.js";
import { toProjectDTO, toTaskDTO } from "../dto.js";
import { asyncHandler } from "../async-handler.js";
import { dependenciesFor, latestEventFor } from "./task-helpers.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";
import type { TaskDependencyRepository } from "../../persistence/repositories/task-dependency-repository.js";

/** Mounted behind requireAuth (see app.ts) — every handler here can assume req.user is set. */
export function projectsRouter(services: ApplicationServices, taskEvents: TaskEventRepository, taskDependencies: TaskDependencyRepository): Router {
  const router = Router();

  router.get(
    "/projects",
    asyncHandler(async (req, res) => {
      res.json({ projects: services.projects.list(req.user!.id).map(toProjectDTO) });
    }),
  );

  router.post(
    "/projects",
    asyncHandler(async (req, res) => {
      const input = CreateProjectSchema.parse(req.body);
      const project = await services.projects.create(input, req.user!.id);
      res.status(201).json({ project: toProjectDTO(project) });
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
      res.json({ project: toProjectDTO(project) });
    }),
  );

  // Populates the "work directly on an existing branch" task-creation UI (see
  // CreateTaskDialog.tsx and SourceControlProvider.listBranches's own doc comment) — read-only,
  // advisory data; never gates anything itself.
  router.get(
    "/projects/:projectId/branches",
    asyncHandler(async (req, res) => {
      const branches = await services.tasks.listBranches(req.params.projectId!, req.user!.id);
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
