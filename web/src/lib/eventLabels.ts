import type { TaskEventType } from "../api/index.js";

/**
 * Converts internal TaskEvent types into the plain language a developer
 * expects — see /docs/UI_ARCHITECTURE.md "Activity timeline" and the
 * product principle that the user should feel they delegated work to an
 * autonomous developer, not that they're reading orchestration internals.
 */
export const EVENT_LABELS: Record<TaskEventType, string> = {
  TASK_CREATED: "Task created",
  TASK_RELEASED: "Started — released for work",
  TASK_CLAIMED: "Picked up for work",
  TASK_STARTED: "Started working",
  WORKSPACE_CREATED: "Prepared a workspace",
  WORKSPACE_FAILED: "Could not prepare a workspace",
  AGENT_STARTED: "AI developer started working",
  AGENT_COMPLETED: "AI developer finished a pass",
  AGENT_FAILED: "AI developer hit an unexpected error",
  VALIDATION_STARTED: "Running tests",
  VALIDATION_COMPLETED: "Tests finished",
  RETRY_STARTED: "Automatically fixing a test failure",
  REVIEW_STARTED: "Running an independent code review",
  REVIEW_COMPLETED: "Independent review finished",
  REVIEW_CHANGES_REQUESTED: "Reviewer requested changes — AI developer is fixing them",
  NEEDS_INPUT_RAISED: "Your decision is required",
  NEEDS_INPUT_ANSWERED: "Continuing with your answer",
  TASK_MOVED_TO_REVIEW: "Ready for your review",
  TASK_ACCEPTED: "Marked as done",
  TASK_CHANGES_REQUESTED: "Changes requested — resuming",
  TASK_COMPLETED: "Task completed",
  TASK_FAILED: "Task failed",
  CANCEL_REQUESTED: "Cancellation requested",
  EXECUTION_CANCELLED: "Execution stopped",
  WORKSPACE_CLEANUP_STARTED: "Cleaning up the workspace",
  WORKSPACE_CLEANUP_COMPLETED: "Workspace cleaned up",
  TASK_CANCELLED: "Task cancelled",
  BRANCH_CREATED: "Created a branch",
  COMMIT_CREATED: "Committed changes",
  BRANCH_PUSHED: "Pushed to GitHub",
  PULL_REQUEST_CREATED: "Opened a Pull Request",
  SOURCE_CONTROL_FAILED: "Source control operation failed",
  NO_CHANGES_DETECTED: "No repository changes were needed — your decision is required",
  HUMAN_REVIEW_DETECTED: "New feedback found on the Pull Request",
  HUMAN_REVIEW_CHANGES_REQUESTED: "Changes requested on GitHub — AI developer is fixing them",
  HUMAN_REVIEW_APPROVED: "Approved on GitHub",
  PULL_REQUEST_MERGED: "Pull Request merged on GitHub — task completed",
  EXECUTION_LEASE_LOST: "Handed off to another worker process",
  CHAT_ACTION_PERFORMED: "Changed via Chat",
};

export function labelForEvent(type: TaskEventType): string {
  return EVENT_LABELS[type] ?? type;
}
