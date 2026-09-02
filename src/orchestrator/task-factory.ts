import { randomUUID } from "node:crypto";
import type { Task, TaskRecord } from "../domain/types.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";

export interface CreateTaskInput {
  tenantId: string;
  projectId: string;
  title: string;
  /** Plain-language description — deliberately not required to be a technical prompt. See PRODUCT_REQUIREMENTS.md FR-3. */
  goal: string;
  createdBy: string | null;
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
    status: "TODO",
    taskRecord: { ...EMPTY_TASK_RECORD },
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
  };
  taskRepo.insert(task);
  eventRepo.append(task.id, "TASK_CREATED", { title: task.title, goal: task.goal, projectId: task.projectId }, now);
  return task;
}
