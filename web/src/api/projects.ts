import { apiClient } from "./client.js";
import type {
  CreateProjectInput,
  CreateTaskInput,
  ProjectCommands,
  ProjectContextDTO,
  ProjectDTO,
  ProjectWorkspaceDTO,
  TaskDTO,
  VerifyGitHubRepositoryResult,
} from "./types.js";

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
  /** Phase 3 "Project Workspace" (Slice 1, backend) — a durable, project-scoped workspace record. */
  getWorkspace: (projectId: string) =>
    apiClient.get<{ workspace: ProjectWorkspaceDTO }>(`/projects/${projectId}/workspace`).then((r) => r.workspace),
  /**
   * Phase 3 "Project Context Manifest" (Slice 5, backend; `revision`/optimistic concurrency added
   * Slice 7). Never 404s solely because a manifest wasn't provisioned yet — see /docs/API.md.
   */
  getContext: (projectId: string) =>
    apiClient.get<{ context: ProjectContextDTO }>(`/projects/${projectId}/context`).then((r) => r.context),
  /**
   * Full replacement (no partial update) — `input.revision` must be the revision the caller most
   * recently loaded. Rejects with 409 `PROJECT_CONTEXT_CONFLICT` (stale revision) or 409
   * `PROJECT_CONTEXT_LOCKED` (a concurrent update is in flight) — see ProjectContextPanel, which is
   * the only caller expected to handle those. See /docs/API.md.
   */
  updateContext: (projectId: string, input: ProjectContextDTO) =>
    apiClient.put<{ context: ProjectContextDTO }>(`/projects/${projectId}/context`, input).then((r) => r.context),
  /**
   * Declares/edits build/test/lint/typecheck after the project already exists — the only way to
   * set these today (project creation's own `commands` field has no frontend UI). Full replacement
   * of the whole `commands` object — an omitted field clears that check. See ProjectSettingsPage.
   */
  updateCommands: (projectId: string, commands: ProjectCommands) =>
    apiClient.patch<{ project: ProjectDTO }>(`/projects/${projectId}/commands`, { commands }).then((r) => r.project),
  /**
   * Permanently deletes the project and everything scoped to it. Rejects with 409
   * `PROJECT_HAS_ACTIVE_TASKS` if any task is still queued/executing/awaiting review — see
   * ProjectSettingsPage's Danger Zone, the only caller.
   */
  delete: (projectId: string) => apiClient.del<void>(`/projects/${projectId}`),
};
