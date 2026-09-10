import { apiClient } from "./client.js";
import type { CreateProjectInput, CreateTaskInput, ProjectDTO, TaskDTO, VerifyGitHubRepositoryResult } from "./types.js";

/** GET/POST /projects, GET /projects/:id, GET/POST /projects/:id/tasks — see /docs/API.md. */
export const projectsApi = {
  list: () => apiClient.get<{ projects: ProjectDTO[] }>("/projects").then((r) => r.projects),
  get: (projectId: string) => apiClient.get<{ project: ProjectDTO }>(`/projects/${projectId}`).then((r) => r.project),
  create: (input: CreateProjectInput) => apiClient.post<{ project: ProjectDTO }>("/projects", input).then((r) => r.project),
  /** The "Validate repository" step of the URL-paste connection flow — a real GitHub API check, not just URL-shape validation. See ProjectService.verifyGitHubRepositoryUrl. */
  verifyGitHubRepo: (repoUrl: string) => apiClient.post<VerifyGitHubRepositoryResult>("/projects/verify-github-repo", { repoUrl }),
  listTasks: (projectId: string) =>
    apiClient.get<{ tasks: TaskDTO[] }>(`/projects/${projectId}/tasks`).then((r) => r.tasks),
  createTask: (projectId: string, input: CreateTaskInput) =>
    apiClient.post<{ task: TaskDTO }>(`/projects/${projectId}/tasks`, input).then((r) => r.task),
  /** Real remote branch names, for the "work directly on an existing branch" task-creation picker. Best-effort for local-git projects — see SourceControlProvider.listBranches. */
  listBranches: (projectId: string) => apiClient.get<{ branches: string[] }>(`/projects/${projectId}/branches`).then((r) => r.branches),
};
