import type { HumanInputRequest, Project, ProjectCommands, ProjectRepo, ProjectWorkspace, Task, TaskEvent, TaskEventType, User } from "../domain/types.js";
import type { ProjectContextManifest } from "../project-workspace/project-context-manifest.js";
import type { BranchStateSummary } from "../reporting/branch-state.js";
import type { DependencyStatus } from "../persistence/repositories/task-dependency-repository.js";

/**
 * Read models returned by the API. Never the raw persistence row shape —
 * these are the only representations the future web UI is allowed to
 * depend on (see /docs/API.md and /docs/ARCHITECTURE.md's UI/API boundary).
 * Internal fields (lock owner/expiry, raw task_record_json, workspace path)
 * are intentionally never included.
 */

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

/** Never includes `passwordHash` — see /docs/AUTHENTICATION.md "Password security". */
export function toUserDTO(user: User): UserDTO {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

/** One repository of a project (TD-62). */
export interface ProjectRepoDTO {
  id: string;
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  sourceControlProvider: string;
  owner: string | null;
  repo: string | null;
  commands: ProjectCommands | null;
  createdAt: string;
  updatedAt: string;
}

export function toProjectRepoDTO(repo: ProjectRepo): ProjectRepoDTO {
  return {
    id: repo.id,
    projectId: repo.projectId,
    name: repo.name,
    repoUrl: repo.repoUrl,
    defaultBranch: repo.defaultBranch,
    sourceControlProvider: repo.sourceControlProvider,
    owner: repo.owner,
    repo: repo.repo,
    commands: repo.commands,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

export interface ProjectDTO {
  id: string;
  name: string;
  /** Every repository connected to the project, primary first (TD-62). Empty for a project with none yet. */
  repositories: ProjectRepoDTO[];
  /** The fields below describe the PRIMARY repository (empty when there is none) — kept for older clients. */
  repoUrl: string;
  defaultBranch: string;
  codingEngine: string;
  sourceControlProvider: string;
  /** Non-null only for sourceControlProvider = "github". */
  owner: string | null;
  repo: string | null;
  commandsDeclared: string[];
  commands: ProjectCommands | null;
  createdAt: string;
  updatedAt: string;
}

export function toProjectDTO(project: Project, repositories: ProjectRepo[]): ProjectDTO {
  return {
    id: project.id,
    name: project.name,
    repositories: repositories.map(toProjectRepoDTO),
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    codingEngine: project.codingEngine,
    sourceControlProvider: project.sourceControlProvider,
    owner: project.owner,
    repo: project.repo,
    commandsDeclared: project.commands ? Object.keys(project.commands) : [],
    // The actual declared command strings, not just their names — needed so the frontend's
    // Project Settings screen can render an editable form pre-filled with the real values, not just
    // the "which checks exist" summary `commandsDeclared` gives. See
    // PATCH /projects/:projectId/commands (routes/projects.ts) for how these get set.
    commands: project.commands,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export interface ProjectWorkspaceDTO {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export function toProjectWorkspaceDTO(workspace: ProjectWorkspace): ProjectWorkspaceDTO {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

/**
 * The validated, normalized Project Context Manifest (Phase 3, Slice 5) — see
 * project-context-manifest.ts. Its schema is already the API-safe shape (never a filesystem path,
 * never a secret — see that module's own doc comment), so this is a deliberate identity passthrough
 * rather than a field-by-field re-mapping; kept as a named DTO function anyway for the same reason
 * every other read model in this file goes through one: one obvious place to re-tighten this later
 * if the manifest schema ever grows an internal-only field.
 *
 * Includes `revision` (Phase 3, Slice 7) — the optimistic-concurrency counter a client must echo
 * back on `PUT /projects/:projectId/context` to prove it isn't overwriting a change it hasn't seen
 * yet. See `PUT`'s own doc comment in `api/routes/projects.ts` and
 * `ProjectContextService.replaceManifest`.
 */
export type ProjectContextDTO = ProjectContextManifest;

export function toProjectContextDTO(manifest: ProjectContextManifest): ProjectContextDTO {
  return manifest;
}

export interface TaskDTO {
  id: string;
  projectId: string;
  /** The project repository this task works in (TD-62). */
  repositoryId: string | null;
  title: string;
  description: string;
  status: Task["status"];
  currentActivity: string;
  selfFixAttempts: number;
  branchName: string | null;
  /** See domain/types.ts BranchMode — always "new" for a task created before this field existed. */
  branchMode: Task["branchMode"];
  /** The user-supplied branch input at creation time (custom "new" name, or the required "existing" branch) — null if none was given. Distinct from `branchName`, the orchestrator-derived *actual* branch in use. */
  workingBranch: string | null;
  /** Mode "new" only: the base-branch override, if the user set one. Null means the project's default branch was used. */
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** True only while WORKING with a cancellation requested but not yet confirmed — see /docs/API.md. */
  cancelRequested: boolean;
  /** Set once the task is CANCELLED (or has a pending request) — who asked for it to stop. */
  cancelledBy: string | null;
  /** Set once independent review approves and the platform opens/finds the PR — see /docs/GITHUB_INTEGRATION.md. */
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  /** The latest commit produced for this task, if any (from the platform's own commit, not the coding engine's local git usage). */
  commitSha: string | null;
  /**
   * This task's explicit, user-defined dependencies (see /docs/TASK_LIFECYCLE.md "Task
   * dependencies"), each with the dependency's own live status/title, plus a derived `satisfied`
   * flag (true only when that dependency is DONE). Never a persisted field — computed fresh on
   * every read from `task_dependencies`, the same "derived, read-only" treatment already used for
   * `currentActivity` above. Embedded directly on the task DTO (rather than requiring a second
   * request per task) so the Kanban board can render "Depends on: ..." / "Blocked by: ..." for
   * every card without an N+1 fetch.
   */
  dependencies: DependencyStatusDTO[];
}

export interface DependencyStatusDTO {
  id: string;
  title: string;
  status: Task["status"];
  satisfied: boolean;
}

export function toDependencyStatusDTO(dep: DependencyStatus): DependencyStatusDTO {
  return { id: dep.id, title: dep.title, status: dep.status, satisfied: dep.status === "DONE" };
}

const ACTIVITY_LABELS: Partial<Record<TaskEventType, string>> = {
  TASK_CREATED: "In backlog",
  TASK_RELEASED: "Waiting to start",
  TASK_CLAIMED: "Starting",
  TASK_STARTED: "Starting",
  WORKSPACE_CREATED: "Preparing workspace",
  WORKSPACE_FAILED: "Workspace setup failed",
  AGENT_STARTED: "Implementer working",
  AGENT_COMPLETED: "Implementer finished a pass",
  AGENT_FAILED: "Agent invocation failed",
  VALIDATION_STARTED: "Running tests",
  VALIDATION_COMPLETED: "Tests finished",
  RETRY_STARTED: "Retrying after a failed check",
  REVIEW_STARTED: "Independent review in progress",
  REVIEW_COMPLETED: "Independent review finished",
  REVIEW_CHANGES_REQUESTED: "Reviewer requested changes — fixing",
  NEEDS_INPUT_RAISED: "Waiting for your input",
  NEEDS_INPUT_ANSWERED: "Resuming after your answer",
  TASK_MOVED_TO_REVIEW: "Ready for your review",
  TASK_ACCEPTED: "Accepted",
  TASK_CHANGES_REQUESTED: "Changes requested, resuming",
  TASK_COMPLETED: "Done",
  TASK_FAILED: "Failed",
  CANCEL_REQUESTED: "Cancelling…",
  EXECUTION_CANCELLED: "Execution stopped",
  WORKSPACE_CLEANUP_STARTED: "Cleaning up",
  WORKSPACE_CLEANUP_COMPLETED: "Cleaned up",
  TASK_CANCELLED: "Cancelled",
  BRANCH_CREATED: "Created a branch",
  COMMIT_CREATED: "Committed changes",
  BRANCH_PUSHED: "Pushed to GitHub",
  PULL_REQUEST_CREATED: "Opened a Pull Request",
  SOURCE_CONTROL_FAILED: "Source control operation failed",
  NO_CHANGES_DETECTED: "No repository changes were needed — waiting for your input",
  HUMAN_REVIEW_DETECTED: "New feedback found on the Pull Request",
  HUMAN_REVIEW_CHANGES_REQUESTED: "Changes requested on GitHub — fixing",
  HUMAN_REVIEW_APPROVED: "Approved on GitHub",
  PULL_REQUEST_MERGED: "Pull Request merged on GitHub",
  EXECUTION_LEASE_LOST: "Handed off to another worker process",
  CHAT_ACTION_PERFORMED: "Changed via Chat",
};

function deriveCurrentActivity(task: Task, latestEvent: TaskEvent | undefined): string {
  if (task.status === "DONE") {
    // A task completed via PR-merge sync (see Orchestrator.finalizeMergedPullRequest) gets a more
    // specific activity string than a manually-accepted one — see /docs/TASK_LIFECYCLE.md "PR merge
    // sync" and /docs/UI_ARCHITECTURE.md. `task.taskRecord.pullRequest` is still present (never
    // cleared on completion), so the PR number is always available here when this event fired.
    if (latestEvent?.type === "PULL_REQUEST_MERGED") {
      const number = task.taskRecord.pullRequest?.number;
      return number ? `Completed — PR #${number} merged` : "Completed — Pull Request merged";
    }
    return "Done";
  }
  if (task.status === "CANCELLED") return "Cancelled";
  if (task.status === "BACKLOG") return "In backlog";
  if (task.status === "TODO") return "Waiting to start";
  if (task.status === "WORKING" && task.cancelRequestedAt) return "Cancelling…";
  if (!latestEvent) return "Waiting to start";
  return ACTIVITY_LABELS[latestEvent.type] ?? task.status;
}

export function toTaskDTO(task: Task, latestEvent: TaskEvent | undefined, dependencies: DependencyStatus[] = []): TaskDTO {
  return {
    id: task.id,
    projectId: task.projectId,
    repositoryId: task.repositoryId ?? null,
    title: task.title,
    description: task.goal,
    status: task.status,
    currentActivity: deriveCurrentActivity(task, latestEvent),
    selfFixAttempts: task.taskRecord.selfFixAttempts,
    branchName: task.taskRecord.branchName,
    branchMode: task.branchMode,
    workingBranch: task.workingBranch,
    baseBranch: task.baseBranch,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cancelRequested: task.status === "WORKING" && task.cancelRequestedAt !== null,
    cancelledBy: task.cancelRequestedBy,
    pullRequestUrl: task.taskRecord.pullRequest?.url ?? null,
    pullRequestNumber: task.taskRecord.pullRequest?.number ?? null,
    commitSha: task.taskRecord.latestDiffRef,
    dependencies: dependencies.map(toDependencyStatusDTO),
  };
}

export interface TaskEventDTO {
  id: string;
  type: TaskEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function toTaskEventDTO(event: TaskEvent): TaskEventDTO {
  return { id: event.id, type: event.type, payload: event.payload, createdAt: event.createdAt };
}

export interface HumanInputRequestDTO {
  id: string;
  status: HumanInputRequest["status"];
  discovered: string;
  attempted: string[];
  blocker: string;
  question: string;
  options: HumanInputRequest["options"];
  answer: HumanInputRequest["answer"];
  askedAt: string;
  answeredAt: string | null;
}

export function toHumanInputRequestDTO(request: HumanInputRequest): HumanInputRequestDTO {
  return {
    id: request.id,
    status: request.status,
    discovered: request.discovered,
    attempted: request.attempted,
    blocker: request.blocker,
    question: request.question,
    options: request.options,
    answer: request.answer,
    askedAt: request.askedAt,
    answeredAt: request.answeredAt,
  };
}

/** GET /tasks/:id/branch-state — see /docs/TASK_LIFECYCLE.md "Stale/behind detection" and "Merge/conflict state". */
export interface BranchStateDTO {
  aheadBy: number | null;
  behindBy: number | null;
  comparable: boolean;
  mergeState: BranchStateSummary["mergeState"];
}

export function toBranchStateDTO(summary: BranchStateSummary): BranchStateDTO {
  return { aheadBy: summary.aheadBy, behindBy: summary.behindBy, comparable: summary.comparable, mergeState: summary.mergeState };
}

/** GET/POST /integrations/github — see /docs/API.md. Never includes the token itself. */
export interface GitHubConnectionDTO {
  connected: boolean;
  githubLogin: string | null;
  connectedAt: string | null;
}
