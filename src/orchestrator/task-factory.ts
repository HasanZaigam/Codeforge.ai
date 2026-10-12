import { randomUUID } from "node:crypto";
import type { BranchMode, BugFixVerificationContract, Task, TaskRecord } from "../domain/types.js";
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
  /**
   * V1.1 Slice 3 — opt-in bug-fix verification contract (see domain/types.ts
   * BugFixVerificationContract). Omitted/undefined for every ordinary task —
   * every existing call site keeps today's exact behavior (no reproduction,
   * no fix verification). When set, `checkId` must already be an approved,
   * project-configured check; the orchestrator enforces this at execution
   * time (see review/bug-fix-verification.ts) rather than here, so task
   * creation never needs a live Project lookup just to validate this.
   */
  bugFixVerification?: BugFixVerificationContract | null;
  /**
   * Phase 4A — a caller-reserved task id. Omitted (every existing call site) means a fresh random
   * id, exactly as before. The backlog-conversion path reserves the id on the approved TaskProposal
   * BEFORE creating the task, so a crash between "task created" and "proposal marked converted"
   * can be retried without ever inserting a second Task: the primary key makes a duplicate insert
   * structurally impossible, and the retry finds the already-created task and just finalizes. Never
   * reachable from the HTTP API (CreateTaskSchema has no such field).
   */
  id?: string;
  /** The project repository this task works in (TD-62). Absent: the project's primary repository (see TaskRepository.insert). */
  repositoryId?: string | null;
  /** Phase 4A — provenance recorded on the TASK_CREATED event (which backlog item / approved proposal this task came from). Informational only; nothing reads it to make a decision. */
  origin?: { backlogItemId: string; taskProposalId: string };
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
  bugFixVerification: null,
};

/**
 * `EMPTY_TASK_RECORD.bugFixVerification` is always `null` in the shared
 * literal above — this only builds the real value for the one call site
 * that opts in (see `createTask` below).
 */
function initialBugFixVerification(contract: BugFixVerificationContract | null | undefined): TaskRecord["bugFixVerification"] {
  return contract ? { contract, reproduction: null, fixVerification: null } : null;
}

/** The only place a Task row is created — keeps FR-3's contract (goal in, executable task out) in one place. */
export function createTask(taskRepo: TaskRepository, eventRepo: TaskEventRepository, input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: input.id ?? randomUUID(),
    tenantId: input.tenantId,
    projectId: input.projectId,
    repositoryId: input.repositoryId ?? null,
    title: input.title,
    goal: input.goal,
    // Always set explicitly, never relying on the `tasks.status` column's SQL DEFAULT
    // ('TODO' — migrations/001_init.sql, predates BACKLOG's introduction and is now a stale,
    // legacy artifact of the migration's own history, which must not be edited retroactively).
    // This is the ONLY place a Task row is constructed (see this function's own doc comment), and
    // TaskRepository.insert() always writes `task.status` explicitly (never omits the column), so
    // that stale default is never actually reached by any code path.
    status: "BACKLOG",
    taskRecord: { ...EMPTY_TASK_RECORD, bugFixVerification: initialBugFixVerification(input.bugFixVerification) },
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
  eventRepo.append(
    task.id,
    "TASK_CREATED",
    { title: task.title, goal: task.goal, projectId: task.projectId, ...(input.origin ? { origin: input.origin } : {}) },
    now,
  );
  return task;
}
