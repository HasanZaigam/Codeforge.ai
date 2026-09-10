import { apiClient } from "./client.js";
import type { BranchStateDTO, DependencyStatusDTO, EditTaskInput, TaskDTO, TaskEventDTO, TaskReport } from "./types.js";

/**
 * GET /tasks/:id, GET /tasks/:id/events, GET /tasks/:id/report, GET /tasks/:id/branch-state, POST
 * /tasks/:id/start, POST /tasks/:id/edit, POST /tasks/:id/cancel, GET/POST/DELETE
 * /tasks/:id/dependencies — see /docs/API.md.
 */
export const tasksApi = {
  get: (taskId: string) => apiClient.get<{ task: TaskDTO }>(`/tasks/${taskId}`).then((r) => r.task),
  listEvents: (taskId: string) => apiClient.get<{ events: TaskEventDTO[] }>(`/tasks/${taskId}/events`).then((r) => r.events),
  getReport: (taskId: string) => apiClient.get<{ report: TaskReport }>(`/tasks/${taskId}/report`).then((r) => r.report),
  getBranchState: (taskId: string) => apiClient.get<{ branchState: BranchStateDTO }>(`/tasks/${taskId}/branch-state`).then((r) => r.branchState),
  /** Releases a BACKLOG task into TODO — the explicit "Start Task" action. Rejects with a clear message (via ApiError) if any dependency isn't DONE yet — see error code INCOMPLETE_DEPENDENCIES. */
  start: (taskId: string) => apiClient.post<{ task: TaskDTO }>(`/tasks/${taskId}/start`, {}).then((r) => r.task),
  /** Edits a BACKLOG task's configuration (title/description/branch settings) — 409 if it's no longer BACKLOG. */
  edit: (taskId: string, input: EditTaskInput) => apiClient.post<{ task: TaskDTO }>(`/tasks/${taskId}/edit`, input).then((r) => r.task),
  cancel: (taskId: string) => apiClient.post<{ task: TaskDTO }>(`/tasks/${taskId}/cancel`, {}).then((r) => r.task),
  /** This task's current explicit dependencies — see /docs/TASK_LIFECYCLE.md "Task dependencies". */
  listDependencies: (taskId: string) =>
    apiClient.get<{ dependencies: DependencyStatusDTO[] }>(`/tasks/${taskId}/dependencies`).then((r) => r.dependencies),
  /** Adds one dependency edge — only while the task is BACKLOG. */
  addDependency: (taskId: string, dependsOnTaskId: string) =>
    apiClient.post<{ dependencies: DependencyStatusDTO[] }>(`/tasks/${taskId}/dependencies`, { dependsOnTaskId }).then((r) => r.dependencies),
  /** Removes one dependency edge — only while the task is BACKLOG. Idempotent. */
  removeDependency: (taskId: string, dependsOnTaskId: string) =>
    apiClient.del<{ dependencies: DependencyStatusDTO[] }>(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`).then((r) => r.dependencies),
};
