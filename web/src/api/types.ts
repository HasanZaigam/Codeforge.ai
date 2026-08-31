/**
 * Wire types for the backend API, hand-kept in sync with /docs/API.md.
 * These are plain data shapes, not business logic — the frontend never
 * re-derives task status or lifecycle rules; it only renders what the API
 * returns. See /docs/UI_ARCHITECTURE.md "API integration".
 */

export type TaskStatus = "TODO" | "WORKING" | "NEEDS_INPUT" | "REVIEW" | "DONE" | "FAILED" | "CANCELLED";

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
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

export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  currentActivity: string;
  selfFixAttempts: number;
  branchName: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** True only while WORKING with a cancellation requested but not yet confirmed. */
  cancelRequested: boolean;
  /** Set once cancellation was requested — who asked for it to stop. */
  cancelledBy: string | null;
  /** Set once independent review approves and the platform opens/finds the PR. */
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  /** The latest commit produced for this task, if any. */
  commitSha: string | null;
}

export type TaskEventType =
  | "TASK_CREATED"
  | "TASK_CLAIMED"
  | "TASK_STARTED"
  | "WORKSPACE_CREATED"
  | "WORKSPACE_FAILED"
  | "AGENT_STARTED"
  | "AGENT_COMPLETED"
  | "AGENT_FAILED"
  | "VALIDATION_STARTED"
  | "VALIDATION_COMPLETED"
  | "RETRY_STARTED"
  | "REVIEW_STARTED"
  | "REVIEW_COMPLETED"
  | "NEEDS_INPUT_RAISED"
  | "NEEDS_INPUT_ANSWERED"
  | "TASK_MOVED_TO_REVIEW"
  | "TASK_ACCEPTED"
  | "TASK_CHANGES_REQUESTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "CANCEL_REQUESTED"
  | "EXECUTION_CANCELLED"
  | "WORKSPACE_CLEANUP_STARTED"
  | "WORKSPACE_CLEANUP_COMPLETED"
  | "TASK_CANCELLED"
  | "BRANCH_CREATED"
  | "COMMIT_CREATED"
  | "BRANCH_PUSHED"
  | "PULL_REQUEST_CREATED"
  | "SOURCE_CONTROL_FAILED";

export interface TaskEventDTO {
  id: string;
  type: TaskEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface InputOption {
  label: string;
  description: string;
}

export interface HumanAnswer {
  selectedOption: string | null;
  freeText: string;
}

export interface HumanInputRequestDTO {
  id: string;
  status: "open" | "answered";
  discovered: string;
  attempted: string[];
  blocker: string;
  question: string;
  options: InputOption[];
  answer: HumanAnswer | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface TaskReport {
  title: string;
  whatWasWrong: string;
  whatChanged: string;
  filesChanged: number;
  checks: Array<{ name: string; passed: boolean }>;
  reviewFindings: Array<{ severity: string; category: string; summary: string }>;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  pullRequest: { url: string | null; number: number | null; branch: string | null; baseBranch: string } | null;
  commitSha: string | null;
}

interface CreateProjectCommon {
  name: string;
  defaultBranch?: string;
  codingEngine?: string;
  commands?: { build?: string; test?: string; lint?: string; typecheck?: string };
}

export interface CreateGitHubProjectInput extends CreateProjectCommon {
  sourceControlProvider: "github";
  owner: string;
  repo: string;
}

export interface CreateLocalGitProjectInput extends CreateProjectCommon {
  sourceControlProvider: "local-git";
  repoUrl: string;
}

export type CreateProjectInput = CreateGitHubProjectInput | CreateLocalGitProjectInput;

export interface CreateTaskInput {
  title: string;
  description: string;
}

/** GET/POST /integrations/github — never includes the token itself. */
export interface GitHubConnectionDTO {
  connected: boolean;
  githubLogin: string | null;
  connectedAt: string | null;
}
