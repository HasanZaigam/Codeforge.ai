import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { CreateProjectSchema, CreateTaskSchema } from "../schemas.js";
import { toProjectDTO, toTaskDTO } from "../dto.js";
import { asyncHandler } from "../async-handler.js";
import { latestEventFor } from "./task-helpers.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";

/** Mounted behind requireAuth (see app.ts) — every handler here can assume req.user is set. */
export function projectsRouter(services: ApplicationServices, taskEvents: TaskEventRepository): Router {
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

  router.get(
    "/projects/:projectId",
    asyncHandler(async (req, res) => {
      const project = services.projects.get(req.params.projectId!, req.user!.id);
      res.json({ project: toProjectDTO(project) });
    }),
  );

  router.get(
    "/projects/:projectId/tasks",
    asyncHandler(async (req, res) => {
      const tasks = services.tasks.listForProject(req.params.projectId!, req.user!.id);
      res.json({ tasks: tasks.map((t) => toTaskDTO(t, latestEventFor(taskEvents, t.id))) });
    }),
  );

  router.post(
    "/projects/:projectId/tasks",
    asyncHandler(async (req, res) => {
      const input = CreateTaskSchema.parse(req.body);
      // Task execution is deliberately NOT triggered here — creation only persists a TODO task;
      // the background worker discovers and claims it. See PRODUCT_REQUIREMENTS.md FR-4 and API.md.
      const task = services.tasks.create({ projectId: req.params.projectId!, ...input }, req.user!.id);
      res.status(201).json({ task: toTaskDTO(task, undefined) });
    }),
  );

  return router;
}
