import { apiClient } from "./client.js";
import type {
  AddRepositoryInput,
  ProjectTokenUsageDTO,
  CreateProjectInput,
  ProjectRepoDTO,
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
  listBranches: (projectId: string, repositoryId?: string) =>
    apiClient
      .get<{ branches: string[] }>(`/projects/${projectId}/branches${repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ""}`)
      .then((r) => r.branches),
  /** This month's token usage for the project, against its optional budget. */
  getTokenUsage: (projectId: string) =>
    apiClient.get<{ usage: ProjectTokenUsageDTO }>(`/projects/${projectId}/token-usage`).then((r) => r.usage),
  /** Sets (or, with null, removes) the project's monthly token budget. Display only — work is never blocked. */
  setTokenBudget: (projectId: string, monthlyTokens: number | null) =>
    apiClient.put<{ usage: ProjectTokenUsageDTO }>(`/projects/${projectId}/token-budget`, { monthlyTokens }).then((r) => r.usage),
  /** Connects another repository to the project. A GitHub repository is verified with a real API call first. */
  addRepository: (projectId: string, input: AddRepositoryInput) =>
    apiClient.post<{ repository: ProjectRepoDTO }>(`/projects/${projectId}/repositories`, input).then((r) => r.repository),
  updateRepository: (projectId: string, repositoryId: string, input: { name?: string; defaultBranch?: string }) =>
    apiClient.patch<{ repository: ProjectRepoDTO }>(`/projects/${projectId}/repositories/${repositoryId}`, input).then((r) => r.repository),
  /** Full replacement of one repository's validation commands. */
  updateRepositoryCommands: (projectId: string, repositoryId: string, commands: ProjectCommands) =>
    apiClient
      .patch<{ repository: ProjectRepoDTO }>(`/projects/${projectId}/repositories/${repositoryId}/commands`, { commands })
      .then((r) => r.repository),
  /** Rejects with 409 REPOSITORY_IN_USE while any task or backlog item still targets it. */
  removeRepository: (projectId: string, repositoryId: string) => apiClient.del<void>(`/projects/${projectId}/repositories/${repositoryId}`),
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
   * the only caller expected to handle those. See /docs/API.md. `updatedAt` is deliberately excluded
   * from the input type — it's server-computed only, never something a caller sends.
   */
  updateContext: (projectId: string, input: Omit<ProjectContextDTO, "updatedAt">) =>
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
