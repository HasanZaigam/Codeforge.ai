import { apiClient } from "./client.js";
import type { TaskDTO, TaskEventDTO, TaskReport } from "./types.js";

/** GET /tasks/:id, GET /tasks/:id/events, GET /tasks/:id/report, POST /tasks/:id/cancel — see /docs/API.md. */
export const tasksApi = {
  get: (taskId: string) => apiClient.get<{ task: TaskDTO }>(`/tasks/${taskId}`).then((r) => r.task),
  listEvents: (taskId: string) => apiClient.get<{ events: TaskEventDTO[] }>(`/tasks/${taskId}/events`).then((r) => r.events),
  getReport: (taskId: string) => apiClient.get<{ report: TaskReport }>(`/tasks/${taskId}/report`).then((r) => r.report),
  cancel: (taskId: string) => apiClient.post<{ task: TaskDTO }>(`/tasks/${taskId}/cancel`, {}).then((r) => r.task),
};
