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
  | "REVIEW_CHANGES_REQUESTED"
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
  | "SOURCE_CONTROL_FAILED"
  | "HUMAN_REVIEW_DETECTED"
  | "HUMAN_REVIEW_CHANGES_REQUESTED"
  | "HUMAN_REVIEW_APPROVED";

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
  /** The Reviewer's own prose assessment (Markdown) — shown alongside reviewFindings, which stay empty unless the engine emits structured findings. */
  reviewSummary: string | null;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  pullRequest: { url: string | null; number: number | null; branch: string | null; baseBranch: string } | null;
  commitSha: string | null;
  /** Present only when status is FAILED. */
  failureReason: string | null;
  agentRuns: AgentRunHistoryItemDTO[];
  durations: ExecutionDurationsDTO;
  recoveredFromCrash: boolean;
  failureContext: FailureContextDTO | null;
}

export type AgentRunTrigger = "initial" | "self_fix_retry" | "ai_review_fix" | "human_review_fix" | "review";
export type AgentRunStatus = "running" | "completed" | "failed" | "timeout" | "cancelled" | "interrupted";

export interface AgentRunHistoryItemDTO {
  id: string;
  role: "implementer" | "reviewer";
  attemptNumber: number;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  startedAt: string;
  completedAt: string | null;
  summary: string | null;
  filesChanged: string[];
  confidence: "high" | "medium" | "low" | null;
  findings: Array<{ severity: string; category: string; summary: string }> | null;
  verdict: "approved" | "rejected" | null;
  error: string | null;
  humanReviewFeedback: { reviewerLogin: string; comments: string } | null;
  resumedAfterInterruption: boolean;
}

export interface ExecutionDurationsDTO {
  totalMs: number | null;
  implementationMs: number | null;
  reviewMs: number | null;
  validationMs: number | null;
  waitingForHumanReviewMs: number | null;
}

export interface FailureContextDTO {
  stage: string;
  failedRole: "implementer" | "reviewer" | null;
  attemptNumber: number | null;
  recoveredFromCrash: boolean;
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
