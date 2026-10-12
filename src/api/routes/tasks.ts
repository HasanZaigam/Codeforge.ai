import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { AddDependencySchema, EditTaskSchema, SubmitInputSchema } from "../schemas.js";
import { toBranchStateDTO, toDependencyStatusDTO, toHumanInputRequestDTO, toTaskDTO, toTaskEventDTO } from "../dto.js";
import { asyncHandler } from "../async-handler.js";
import { dependenciesFor, latestEventFor } from "./task-helpers.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";
import type { TaskDependencyRepository } from "../../persistence/repositories/task-dependency-repository.js";
import { SelfDependencyError } from "../../application/errors.js";

/**
 * Mounted behind requireAuth (see app.ts) — every handler here can assume
 * req.user is set, and every service call below is scoped to req.user.id
 * (see /docs/AUTHENTICATION.md "Authorization model") — a user can only
 * reach tasks belonging to a project they own.
 *
 * Endpoints intentionally NOT included, and why (see /docs/API.md):
 *  - POST /tasks/:id/resume  — resuming is a side effect of POST /tasks/:id/input, not a separate
 *                              action; there is nothing to resume without an answer.
 *
 * POST /tasks/:id/start (added for the BACKLOG -> TODO release gate — see
 * /docs/TASK_LIFECYCLE.md "Task lifecycle") is the one exception to the "creation already leaves
 * the task ready for the worker" note above: task creation now leaves a task in BACKLOG, which the
 * worker never polls, specifically so a human has to take this explicit action before anything
 * runs.
 *
 * POST /tasks/:id/cancel (added in Step 5, see TECHNICAL_DECISIONS.md TD-24) is an explicit
 * domain command, not a status write — there is no PATCH /tasks/:id accepting an arbitrary
 * `status` field, and never will be; every lifecycle transition goes through a named
 * Orchestrator method with its own legality rules (see task-state-machine.ts).
 *
 * POST /tasks/:id/edit is the one narrow exception to "task fields are fixed after creation": it
 * updates only a BACKLOG task's editable *configuration* (title/goal/branchMode/workingBranch/
 * baseBranch) via TaskService.editBacklogTask — never `status`, never anything else. It is
 * deliberately its own named action route (mirroring `start`/`cancel`), not a generic PATCH, so it
 * can never be mistaken for — or later widened into — the generic status-accepting PATCH this file
 * explicitly rejects above. Server-side-gated to `status === "BACKLOG"` exactly; any other status
 * throws TaskNotEditableError, mapped to 409 TASK_NOT_EDITABLE by error-middleware.ts.
 *
 * GET/POST/DELETE /tasks/:taskId/dependencies (see /docs/TASK_LIFECYCLE.md "Task dependencies")
 * manage a task's explicit, user-defined dependency edges — one action-verb-shaped resource per
 * edge, mirroring this router's existing convention rather than a whole-set-replacing PUT: POST
 * adds one edge, DELETE removes one, both server-side-gated to status === "BACKLOG" exactly like
 * /edit above. GET is unrestricted (dependencies stay visible, just immutable, once a task leaves
 * BACKLOG).
 */
export function tasksRouter(services: ApplicationServices, taskEvents: TaskEventRepository, taskDependencies: TaskDependencyRepository): Router {
  const router = Router();

  router.get(
    "/tasks/:taskId",
    asyncHandler(async (req, res) => {
      const task = services.tasks.get(req.params.taskId!, req.user!.id);
      // The task detail screen has no project loaded, so it gets its repository's name here (TD-62).
      const repository = services.projects.listRepositories(task.projectId, req.user!.id).find((r) => r.id === task.repositoryId);
      res.json({
        task: { ...toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)), repositoryName: repository?.name ?? null },
      });
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
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)) });
    }),
  );

  router.post(
    "/tasks/:taskId/start",
    asyncHandler(async (req, res) => {
      // Releases a BACKLOG task into TODO. 404 if the task doesn't exist/isn't accessible (via
      // assertTaskAccess); a task not currently in BACKLOG (already started, or terminal) throws
      // InvalidTransitionError, which error-middleware.ts maps to 409 INVALID_STATE_TRANSITION —
      // the same shape every other illegal transition in this API produces, never a silent no-op.
      const task = services.tasks.startTask(req.params.taskId!, req.user!.id);
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)) });
    }),
  );

  router.post(
    "/tasks/:taskId/edit",
    asyncHandler(async (req, res) => {
      // Edits a BACKLOG task's configuration only — see this file's own doc comment above. 409
      // TASK_NOT_EDITABLE if the task has already left BACKLOG.
      const input = EditTaskSchema.parse(req.body);
      const task = await services.tasks.editBacklogTask(req.params.taskId!, input, req.user!.id);
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)) });
    }),
  );

  router.post(
    "/tasks/:taskId/cancel",
    asyncHandler(async (req, res) => {
      // Idempotent (repeated calls against an already-CANCELLED task succeed as a no-op) and
      // never itself terminates a process — see Orchestrator.requestCancellation's doc comment.
      const task = await services.tasks.cancelTask(req.params.taskId!, req.user!.id);
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)) });
    }),
  );

  router.get(
    "/tasks/:taskId/branch-state",
    asyncHandler(async (req, res) => {
      // Detection only, computed on demand (never persisted, never gates execution) — see
      // /docs/TASK_LIFECYCLE.md "Stale/behind detection" and "Merge/conflict state".
      const state = await services.tasks.getBranchState(req.params.taskId!, req.user!.id);
      res.json({ branchState: toBranchStateDTO(state) });
    }),
  );

  router.post(
    "/tasks/:taskId/check-review-feedback",
    asyncHandler(async (req, res) => {
      // On-demand equivalent of the worker's own automatic poll (see /docs/TASK_LIFECYCLE.md
      // "Human review feedback loop") — safe to call repeatedly, a no-op unless there's new,
      // unprocessed human feedback on the task's PR.
      const task = await services.tasks.checkReviewFeedback(req.params.taskId!, req.user!.id);
      res.json({ task: toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)) });
    }),
  );

  router.get(
    "/tasks/:taskId/dependencies",
    asyncHandler(async (req, res) => {
      const dependencies = services.tasks.listDependencies(req.params.taskId!, req.user!.id);
      res.json({ dependencies: dependencies.map(toDependencyStatusDTO) });
    }),
  );

  router.post(
    "/tasks/:taskId/dependencies",
    asyncHandler(async (req, res) => {
      // Adds one dependency edge — only while the task is BACKLOG (409 TASK_NOT_EDITABLE
      // otherwise). Rejects self-dependency (400), cross-project (400), a duplicate edge (409), and
      // anything that would create a cycle — direct or indirect (409) — see TaskService.addDependency.
      const input = AddDependencySchema.parse(req.body);
      // Cheap, non-duplicative early rejection: both IDs needed for a self-dependency check are
      // already available right here from the request shape alone (URL param + body), with no DB
      // access and no relationship to prove beyond a single string comparison — unlike cross-project
      // validation, which genuinely requires resolving both tasks' project ownership and stays
      // TaskService-only (see addDependency), or the cycle check, which needs the full graph. This is
      // defense in depth, not a replacement: TaskService.addDependency's own self-dependency check
      // (authoritative) is unchanged below.
      if (req.params.taskId === input.dependsOnTaskId) {
        throw new SelfDependencyError();
      }
      const dependencies = await services.tasks.addDependency(req.params.taskId!, input.dependsOnTaskId, req.user!.id);
      res.status(201).json({ dependencies: dependencies.map(toDependencyStatusDTO) });
    }),
  );

  router.delete(
    "/tasks/:taskId/dependencies/:dependsOnTaskId",
    asyncHandler(async (req, res) => {
      // Removes one dependency edge — only while the task is BACKLOG. Idempotent: removing an edge
      // that doesn't exist (while still BACKLOG) succeeds as a no-op, never a 404.
      const dependencies = services.tasks.removeDependency(req.params.taskId!, req.params.dependsOnTaskId!, req.user!.id);
      res.json({ dependencies: dependencies.map(toDependencyStatusDTO) });
    }),
  );

  return router;
}
