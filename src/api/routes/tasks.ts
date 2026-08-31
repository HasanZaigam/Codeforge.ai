import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { SubmitInputSchema } from "../schemas.js";
import { toHumanInputRequestDTO, toTaskDTO, toTaskEventDTO } from "../dto.js";
import { asyncHandler } from "../async-handler.js";
import { latestEventFor } from "./task-helpers.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";

/**
 * Mounted behind requireAuth (see app.ts) — every handler here can assume
 * req.user is set, and every service call below is scoped to req.user.id
 * (see /docs/AUTHENTICATION.md "Authorization model") — a user can only
 * reach tasks belonging to a project they own.
 *
 * Endpoints intentionally NOT included, and why (see /docs/API.md):
 *  - POST /tasks/:id/start   — creation already leaves the task in TODO for the worker to pick up;
 *                              a separate "start" call would just be a race with the poller.
 *  - POST /tasks/:id/resume  — resuming is a side effect of POST /tasks/:id/input, not a separate
 *                              action; there is nothing to resume without an answer.
 *
 * POST /tasks/:id/cancel (added in Step 5, see TECHNICAL_DECISIONS.md TD-24) is an explicit
 * domain command, not a status write — there is no PATCH /tasks/:id accepting an arbitrary
 * `status` field, and never will be; every lifecycle transition goes through a named
 * Orchestrator method with its own legality rules (see task-state-machine.ts).
 */
export function tasksRouter(services: ApplicationServices, taskEvents: TaskEventRepository): Router {
  const router = Router();

  router.get(
    "/tasks/:taskId",
    asyncHandler(async (req, res) => {
      const task = services.tasks.get(req.params.taskId!, req.user!.id);
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id)) });
    }),
  );

  router.get(
    "/tasks/:taskId/events",
    asyncHandler(async (req, res) => {
      const events = services.tasks.listEvents(req.params.taskId!, req.user!.id);
      res.json({ events: events.map(toTaskEventDTO) });
    }),
  );

  router.get(
    "/tasks/:taskId/report",
    asyncHandler(async (req, res) => {
      const report = services.tasks.getReport(req.params.taskId!, req.user!.id);
      res.json({ report });
    }),
  );

  router.get(
    "/tasks/:taskId/input",
    asyncHandler(async (req, res) => {
      const request = services.humanInput.getOpenRequest(req.params.taskId!, req.user!.id);
      res.json({ input: request ? toHumanInputRequestDTO(request) : null });
    }),
  );

  router.post(
    "/tasks/:taskId/input",
    asyncHandler(async (req, res) => {
      const answer = SubmitInputSchema.parse(req.body);
      const task = services.humanInput.submitAnswer(
        req.params.taskId!,
        { selectedOption: answer.selectedOption ?? null, freeText: answer.freeText },
        req.user!.id,
      );
      // Answering resumes the task (NEEDS_INPUT -> WORKING) but does not execute it inline —
      // the worker's next poll claims and continues it, same as any other WORKING task.
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id)) });
    }),
  );

  router.post(
    "/tasks/:taskId/cancel",
    asyncHandler(async (req, res) => {
      // Idempotent (repeated calls against an already-CANCELLED task succeed as a no-op) and
      // never itself terminates a process — see Orchestrator.requestCancellation's doc comment.
      const task = await services.tasks.cancelTask(req.params.taskId!, req.user!.id);
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id)) });
    }),
  );

  return router;
}
