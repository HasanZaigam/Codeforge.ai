import { apiClient } from "./client.js";
import type { HumanAnswer, HumanInputRequestDTO, TaskDTO } from "./types.js";

/** GET/POST /tasks/:id/input — see /docs/API.md. */
export const humanInputApi = {
  get: (taskId: string) => apiClient.get<{ input: HumanInputRequestDTO | null }>(`/tasks/${taskId}/input`).then((r) => r.input),
  submit: (taskId: string, answer: HumanAnswer) =>
    apiClient.post<{ task: TaskDTO }>(`/tasks/${taskId}/input`, answer).then((r) => r.task),
};
