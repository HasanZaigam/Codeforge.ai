import { randomUUID } from "node:crypto";
import type { BranchMode, Task, TaskRecord } from "../domain/types.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";

export interface CreateTaskInput {
  tenantId: string;
  projectId: string;
  title: string;
  /** Plain-language description — deliberately not required to be a technical prompt. See PRODUCT_REQUIREMENTS.md FR-3. */
  goal: string;
  createdBy: string | null;
  /** See BranchMode. Defaults to "new" — every existing call site that omits this keeps today's exact behavior. */
  branchMode?: BranchMode;
  /** Mode "new": optional custom branch name. Mode "existing": the required target branch. Already validated/sanitized by the caller (see schemas.ts isSafeBranchName) before this is ever called. */
  workingBranch?: string | null;
  /** Mode "new" only: overrides the project's default branch as the branch to create from. */
  baseBranch?: string | null;
}

const EMPTY_TASK_RECORD: TaskRecord = {
  plan: null,
  decisions: [],
  branchName: null,
  latestDiffRef: null,
  selfFixAttempts: 0,
  workingEpisodes: 0,
  pullRequest: null,
  processedHumanFeedbackIds: [],
  pendingHumanReviewFeedback: null,
};

/** The only place a Task row is created — keeps FR-3's contract (goal in, executable task out) in one place. */
export function createTask(taskRepo: TaskRepository, eventRepo: TaskEventRepository, input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    tenantId: input.tenantId,
    projectId: input.projectId,
    title: input.title,
    goal: input.goal,
    // Always set explicitly, never relying on the `tasks.status` column's SQL DEFAULT
    // ('TODO' — migrations/001_init.sql, predates BACKLOG's introduction and is now a stale,
    // legacy artifact of the migration's own history, which must not be edited retroactively).
    // This is the ONLY place a Task row is constructed (see this function's own doc comment), and
    // TaskRepository.insert() always writes `task.status` explicitly (never omits the column), so
    // that stale default is never actually reached by any code path.
    status: "BACKLOG",
    taskRecord: { ...EMPTY_TASK_RECORD },
    branchMode: input.branchMode ?? "new",
    workingBranch: input.workingBranch ?? null,
    baseBranch: input.baseBranch ?? null,
    currentAgentRunId: null,
    workspaceId: null,
    lockOwner: null,
    lockExpiresAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    lockGeneration: 0,
    nextReviewCheckAt: null,
  };
  taskRepo.insert(task);
  eventRepo.append(task.id, "TASK_CREATED", { title: task.title, goal: task.goal, projectId: task.projectId }, now);
  return task;
}
