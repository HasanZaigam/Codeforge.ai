import type { HumanInputRequest, Project, Task, TaskEvent, TaskEventType, User } from "../domain/types.js";

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

export interface ProjectDTO {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  codingEngine: string;
  sourceControlProvider: string;
  /** Non-null only for sourceControlProvider = "github". */
  owner: string | null;
  repo: string | null;
  commandsDeclared: string[];
  createdAt: string;
  updatedAt: string;
}

export function toProjectDTO(project: Project): ProjectDTO {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    codingEngine: project.codingEngine,
    sourceControlProvider: project.sourceControlProvider,
    owner: project.owner,
    repo: project.repo,
    commandsDeclared: project.commands ? Object.keys(project.commands) : [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: Task["status"];
  currentActivity: string;
  selfFixAttempts: number;
  branchName: string | null;
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
}

const ACTIVITY_LABELS: Partial<Record<TaskEventType, string>> = {
  TASK_CREATED: "Waiting to start",
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
};

function deriveCurrentActivity(task: Task, latestEvent: TaskEvent | undefined): string {
  if (task.status === "DONE") return "Done";
  if (task.status === "CANCELLED") return "Cancelled";
  if (task.status === "TODO") return "Waiting to start";
  if (task.status === "WORKING" && task.cancelRequestedAt) return "Cancelling…";
  if (!latestEvent) return "Waiting to start";
  return ACTIVITY_LABELS[latestEvent.type] ?? task.status;
}

export function toTaskDTO(task: Task, latestEvent: TaskEvent | undefined): TaskDTO {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.goal,
    status: task.status,
    currentActivity: deriveCurrentActivity(task, latestEvent),
    selfFixAttempts: task.taskRecord.selfFixAttempts,
    branchName: task.taskRecord.branchName,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cancelRequested: task.status === "WORKING" && task.cancelRequestedAt !== null,
    cancelledBy: task.cancelRequestedBy,
    pullRequestUrl: task.taskRecord.pullRequest?.url ?? null,
    pullRequestNumber: task.taskRecord.pullRequest?.number ?? null,
    commitSha: task.taskRecord.latestDiffRef,
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

/** GET/POST /integrations/github — see /docs/API.md. Never includes the token itself. */
export interface GitHubConnectionDTO {
  connected: boolean;
  githubLogin: string | null;
  connectedAt: string | null;
}
