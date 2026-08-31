import { apiClient } from "./client.js";
import type { CreateProjectInput, CreateTaskInput, ProjectDTO, TaskDTO } from "./types.js";

/** GET/POST /projects, GET /projects/:id, GET/POST /projects/:id/tasks — see /docs/API.md. */
export const projectsApi = {
  list: () => apiClient.get<{ projects: ProjectDTO[] }>("/projects").then((r) => r.projects),
  get: (projectId: string) => apiClient.get<{ project: ProjectDTO }>(`/projects/${projectId}`).then((r) => r.project),
  create: (input: CreateProjectInput) => apiClient.post<{ project: ProjectDTO }>("/projects", input).then((r) => r.project),
  listTasks: (projectId: string) =>
    apiClient.get<{ tasks: TaskDTO[] }>(`/projects/${projectId}/tasks`).then((r) => r.tasks),
  createTask: (projectId: string, input: CreateTaskInput) =>
    apiClient.post<{ task: TaskDTO }>(`/projects/${projectId}/tasks`, input).then((r) => r.task),
};
