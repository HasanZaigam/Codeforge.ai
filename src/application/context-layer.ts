import type { Task, TaskStatus } from "../domain/types.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import { assertProjectAccess } from "./authorization.js";
import { NotFoundError } from "./errors.js";
import type { TaskService, TaskPullRequestInfo } from "./task-service.js";
import type { ProjectService } from "./project-service.js";
import type { TaskReport } from "../reporting/task-report.js";

export type { TaskPullRequestInfo };

/**
 * Phase 4D — CodeForge Context Layer (see /docs/CHAT.md "Context Layer"). Deterministic, read-only
 * access to CodeForge's OWN operational state, for Chat to query instead of falling back to
 * repository/GitHub guesses. Every method here is a thin, bounded adapter over the EXISTING
 * authoritative services — TaskService.get/listForProject/listEvents/getReport (each already
 * `assertTaskAccess`/`assertProjectAccess`-gated) and ProjectService.getContext. Nothing here is a
 * second task database, a vector store, or a memory system: it queries the same rows the Tasks UI and
 * Task Detail report already read, and returns compact structured summaries — never the full
 * TaskRecord blob, never raw model/tool logs, never an unbounded list.
 */

export const ALL_TASK_STATUSES: TaskStatus[] = ["BACKLOG", "TODO", "WORKING", "NEEDS_INPUT", "REVIEW", "DONE", "FAILED", "CANCELLED"];

/** Hard ceiling on any bounded list this layer returns — the LLM never sees more than this many tasks/events in one call. */
const MAX_LIST_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 10;
const MAX_HISTORY_EVENTS = 20;

export interface ProjectSummary {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  sourceControlProvider: string;
  codingEngine: string;
  workspaceContextAvailable: boolean;
  totalTasks: number;
  taskCounts: Record<TaskStatus, number>;
}

export type TaskCounts = Record<TaskStatus, number>;

export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  branchMode: "new" | "existing";
  workingBranch: string | null;
  baseBranch: string | null;
  hasWorkspace: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  pullRequest: { url: string | null; number: number | null } | null;
}

export interface TaskHistoryEvent {
  type: string;
  at: string;
}

export interface LatestExecutionSummary {
  runId: string;
  role: string;
  modelId: string | null;
  providerId: string | null;
  startedAt: string;
  completedAt: string | null;
  status: string;
  summary: string | null;
  filesChangedCount: number;
  validationOutcome: string | null;
  reviewSummary: string | null;
}

export interface ChangedFilesSummary {
  commitSha: string | null;
  branch: string | null;
  files: string[];
}

export interface ValidationSummary {
  outcome: string | null;
  checks: Array<{ name: string; passed: boolean; outcome: string }>;
  revision: string | null;
  failureReason: string | null;
}

export interface ModelUsageSummary {
  latestModelId: string | null;
  latestProviderId: string | null;
  runCount: number;
  fallbackIndex: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type TaskOriginSummary =
  | { kind: "manual" }
  | { kind: "backlog_proposal"; backlogItemId: string; taskProposalId: string }
  | { kind: "unknown" };

export interface WorkspaceContextSummary {
  purpose: string | null;
  architecture: string[];
  conventions: string[];
  constraints: string[];
  validationGuidance: string[];
}

export interface TaskHandoff {
  title: string;
  currentState: TaskStatus;
  lastModelId: string | null;
  lastProviderId: string | null;
  completedSummary: string | null;
  changedFiles: string[];
  revision: string | null;
  validationOutcome: string | null;
  origin: TaskOriginSummary;
  openIssue: string | null;
  nextAction: string;
}

export interface TaskListFilters {
  status?: TaskStatus;
  sort?: "newest" | "oldest";
  limit?: number;
}

function countByStatus(tasks: Task[]): TaskCounts {
  const counts = Object.fromEntries(ALL_TASK_STATUSES.map((s) => [s, 0])) as TaskCounts;
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}

function toTaskListItem(t: Task): TaskListItem {
  return { id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

function toTaskDetail(t: Task): TaskDetail {
  return {
    id: t.id,
    title: t.title,
    description: t.goal,
    status: t.status,
    branchMode: t.branchMode,
    workingBranch: t.workingBranch,
    baseBranch: t.baseBranch,
    hasWorkspace: t.workspaceId !== null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    pullRequest: t.taskRecord.pullRequest ? { url: t.taskRecord.pullRequest.url, number: t.taskRecord.pullRequest.number } : null,
  };
}

/** "What should a human (or a newly-switched model) do next?" — derived purely from existing status/report fields, never invented. */
function deriveNextAction(task: Task, report: TaskReport): string {
  switch (task.status) {
    case "BACKLOG":
      return "Start the task to begin work.";
    case "TODO":
      return "Waiting to be claimed by the worker.";
    case "WORKING":
      return "Implementation/validation is in progress.";
    case "NEEDS_INPUT":
      return "Waiting on a human answer before work can continue.";
    case "REVIEW":
      return report.pullRequest ? "Waiting on human review of the open Pull Request." : "Waiting on human review.";
    case "DONE":
      return "Complete — no further action needed.";
    case "FAILED":
      return report.failureReason ? `Failed: ${report.failureReason}` : "Failed — see failure reason for details.";
    case "CANCELLED":
      return "Cancelled — no further action will be taken.";
    default:
      return "Unknown state.";
  }
}

import type { BacklogBulkService } from "./backlog-bulk-service.js";
import type { BacklogItem } from "../backlog/backlog-types.js";

export class ContextLayerService {
  constructor(
    private readonly d: {
      projects: ProjectRepository;
      tasks: TaskService;
      projectService: ProjectService;
      bulkService?: BacklogBulkService;
    },
  ) {}

  getProjectSummary(projectId: string, actorId: string): ProjectSummary {
    const project = assertProjectAccess(this.d.projects, projectId, actorId);
    const tasks = this.d.tasks.listForProject(projectId, actorId);
    let workspaceContextAvailable = false;
    try {
      this.d.projectService.getContext(projectId, actorId);
      workspaceContextAvailable = true;
    } catch {
      // No ProjectWorkspace yet — a real, reportable absence, not an error.
    }
    return {
      name: project.name,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      sourceControlProvider: project.sourceControlProvider,
      codingEngine: project.codingEngine,
      workspaceContextAvailable,
      totalTasks: tasks.length,
      taskCounts: countByStatus(tasks),
    };
  }

  getTaskSummary(projectId: string, actorId: string): { total: number; counts: TaskCounts } {
    const tasks = this.d.tasks.listForProject(projectId, actorId);
    return { total: tasks.length, counts: countByStatus(tasks) };
  }

  getTasks(projectId: string, actorId: string, filters: TaskListFilters = {}): TaskListItem[] {
    let tasks = this.d.tasks.listForProject(projectId, actorId); // already DESC by created_at
    if (filters.status) tasks = tasks.filter((t) => t.status === filters.status);
    if (filters.sort === "oldest") tasks = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    else if (filters.sort === "newest") tasks = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = Math.max(1, Math.min(filters.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    return tasks.slice(0, limit).map(toTaskListItem);
  }

  /**
   * Phase 4D.3.2 — a real reported discrepancy: a project with 32 tasks had a legitimate 7-week-old task
   * referenced by title/action ("...make this task from review to done"), but `resolveActionTarget`
   * (chat-intent.ts) was resolving its candidate set through `getTasks({ limit: 20 })` — the SAME
   * display-bounded cap `MAX_LIST_LIMIT` enforces so a model prompt never gets flooded with every task in
   * a project. That cap is correct for anything a model might see, but task-reference RESOLUTION never
   * builds a model prompt from this list at all — it's a pure in-memory string-containment check, and
   * capping it silently excluded the 12 oldest tasks from ever being found by name, no matter how exact
   * the title match would have been. This returns every one of the project's tasks, unbounded, for
   * resolution matching ONLY — never for display, and never consumed to build a prompt. The result of
   * matching against it (zero, one, or an ambiguous handful of titles) is still exactly as bounded as
   * ever by definition; only the SEARCH space was ever supposed to be unbounded.
   */
  getAllTasksForResolution(projectId: string, actorId: string): TaskListItem[] {
    return this.d.tasks.listForProject(projectId, actorId).map(toTaskListItem);
  }

  /** Throws NotFoundError if the task exists but belongs to a DIFFERENT project than `projectId` — a user may own several projects; a Chat conversation scoped to one must never surface another's tasks. */
  private requireTaskInProject(projectId: string, taskId: string, actorId: string): Task {
    const task = this.d.tasks.get(taskId, actorId); // assertTaskAccess — 404s if not owned at all
    if (task.projectId !== projectId) throw new NotFoundError("Task", taskId);
    return task;
  }

  getTaskDetail(projectId: string, taskId: string, actorId: string): TaskDetail {
    return toTaskDetail(this.requireTaskInProject(projectId, taskId, actorId));
  }

  getTaskHistory(projectId: string, taskId: string, actorId: string, limit = MAX_HISTORY_EVENTS): TaskHistoryEvent[] {
    this.requireTaskInProject(projectId, taskId, actorId);
    const events = this.d.tasks.listEvents(taskId, actorId);
    const bounded = Math.max(1, Math.min(limit, MAX_HISTORY_EVENTS));
    return events.slice(-bounded).map((e) => ({ type: e.type, at: e.createdAt }));
  }

  /**
   * Phase 4D.5 — the timestamp this task MOST RECENTLY entered REVIEW, via the real `TASK_MOVED_TO_REVIEW`
   * event (fired by the same `gates_passed` transition REVIEW already requires — see orchestrator.ts).
   * Deliberately NOT `createdAt` (the task may have spent real time in BACKLOG/TODO/WORKING first) or
   * `updatedAt` (bumped by unrelated later writes) — "how long has this been in Review" must be measured
   * from when it actually arrived there. A task can cycle REVIEW -> WORKING -> REVIEW (changes_requested
   * then fixed again), so this takes the LATEST such event — the start of the CURRENT review period, not
   * the first one ever. Returns `null` when no such event exists at all (legacy/edge-case data) so a
   * caller can honestly report "review-age precision unavailable" instead of inventing a timestamp.
   */
  getReviewEnteredAt(projectId: string, taskId: string, actorId: string): string | null {
    this.requireTaskInProject(projectId, taskId, actorId);
    const moved = this.d.tasks.listEvents(taskId, actorId).filter((e) => e.type === "TASK_MOVED_TO_REVIEW");
    return moved.length > 0 ? moved[moved.length - 1]!.createdAt : null;
  }

  /**
   * Phase 4D.5 — Task status and PR status are deliberately separate domains (Objective: "do NOT conflate
   * DONE with MERGED"). Delegates entirely to `TaskService.getPullRequestStatus`, the ONLY place that
   * calls the real `SourceControlProvider` — never a second GitHub client, never inferred from
   * `TaskStatus` or git log text.
   */
  async getTaskPullRequestStatus(projectId: string, taskId: string, actorId: string): Promise<TaskPullRequestInfo> {
    this.requireTaskInProject(projectId, taskId, actorId);
    return this.d.tasks.getPullRequestStatus(taskId, actorId);
  }

  private getReport(projectId: string, taskId: string, actorId: string): { task: Task; report: TaskReport } {
    const task = this.requireTaskInProject(projectId, taskId, actorId);
    const report = this.d.tasks.getReport(taskId, actorId);
    return { task, report };
  }

  getLatestExecution(projectId: string, taskId: string, actorId: string): LatestExecutionSummary | null {
    const { report } = this.getReport(projectId, taskId, actorId);
    const last = report.agentRuns[report.agentRuns.length - 1];
    if (!last) return null;
    return {
      runId: last.id,
      role: last.role,
      modelId: last.modelId,
      providerId: last.providerId,
      startedAt: last.startedAt,
      completedAt: last.completedAt,
      status: last.status,
      summary: last.summary,
      filesChangedCount: last.filesChanged.length,
      validationOutcome: report.validationOutcome,
      reviewSummary: report.reviewSummary,
    };
  }

  getTaskChanges(projectId: string, taskId: string, actorId: string): ChangedFilesSummary {
    const { report } = this.getReport(projectId, taskId, actorId);
    return { commitSha: report.gitEvidence.commitSha, branch: report.gitEvidence.branch, files: report.gitEvidence.changedFiles };
  }

  getTaskValidation(projectId: string, taskId: string, actorId: string): ValidationSummary {
    const { report } = this.getReport(projectId, taskId, actorId);
    return {
      outcome: report.validationOutcome,
      checks: report.checks,
      revision: report.commitSha,
      failureReason: report.failureReason,
    };
  }

  getTaskModelUsage(projectId: string, taskId: string, actorId: string): ModelUsageSummary {
    const { report } = this.getReport(projectId, taskId, actorId);
    const last = report.agentRuns[report.agentRuns.length - 1];
    return {
      latestModelId: last?.modelId ?? null,
      latestProviderId: last?.providerId ?? null,
      runCount: report.agentRuns.length,
      fallbackIndex: last?.fallbackIndex ?? 0,
      inputTokens: report.usage.totals.inputTokens,
      outputTokens: report.usage.totals.outputTokens,
    };
  }

  getTaskOrigin(projectId: string, taskId: string, actorId: string): TaskOriginSummary {
    this.requireTaskInProject(projectId, taskId, actorId);
    const events = this.d.tasks.listEvents(taskId, actorId);
    const created = events.find((e) => e.type === "TASK_CREATED");
    if (!created) return { kind: "unknown" };
    const origin = created.payload.origin as { backlogItemId?: unknown; taskProposalId?: unknown } | undefined;
    if (origin && typeof origin.backlogItemId === "string" && typeof origin.taskProposalId === "string") {
      return { kind: "backlog_proposal", backlogItemId: origin.backlogItemId, taskProposalId: origin.taskProposalId };
    }
    return { kind: "manual" };
  }

  getWorkspaceContext(projectId: string, actorId: string): WorkspaceContextSummary | null {
    try {
      const manifest = this.d.projectService.getContext(projectId, actorId);
      return {
        purpose: manifest.project.description ?? null,
        architecture: manifest.architecture,
        conventions: manifest.conventions,
        constraints: manifest.constraints,
        validationGuidance: manifest.validation.commands,
      };
    } catch {
      return null;
    }
  }

  /** The compact cross-model handoff (Objective 10) — composed entirely from already-authoritative records, never a second memory system. */
  getTaskHandoff(projectId: string, taskId: string, actorId: string): TaskHandoff {
    const { task, report } = this.getReport(projectId, taskId, actorId);
    const last = report.agentRuns[report.agentRuns.length - 1];
    const origin = this.getTaskOrigin(projectId, taskId, actorId);
    let openIssue: string | null = null;
    if (task.status === "NEEDS_INPUT") openIssue = "Waiting on a human answer.";
    else if (task.status === "REVIEW") openIssue = "Human review required.";
    else if (task.status === "FAILED") openIssue = report.failureReason;
    return {
      title: task.title,
      currentState: task.status,
      lastModelId: last?.modelId ?? null,
      lastProviderId: last?.providerId ?? null,
      completedSummary: last?.summary ?? null,
      changedFiles: report.gitEvidence.changedFiles,
      revision: report.commitSha,
      validationOutcome: report.validationOutcome,
      origin,
      openIssue,
      nextAction: deriveNextAction(task, report),
    };
  }

  /**
   * Resolves a free-text task reference to a real, project-scoped task: an exact/prefix id match, a
   * case-insensitive title match, or — if the message names no task at all — `lastTaskId`, the task the
   * conversation most recently discussed (a natural follow-up like "which files changed?" almost always
   * means "...on the task we were just talking about"). Only used by callers that have ALREADY matched a
   * task-scoped intent keyword, so this fallback never fires for an unrelated general question. Returns
   * `null` rather than guessing when nothing resolves at all.
   */
  resolveTaskReference(projectId: string, actorId: string, text: string, lastTaskId: string | null): Task | null {
    const tasks = this.d.tasks.listForProject(projectId, actorId);
    const lower = text.toLowerCase();

    // 1. Exact ID or prefix ID match
    const idMatch = tasks.find((t) => lower.includes(t.id.toLowerCase()) || lower.includes(t.id.slice(0, 8).toLowerCase()));
    if (idMatch) return idMatch;

    // 2. BUG-ID match (e.g. BUG-019, BUG-002, bug 19, bug-19)
    const bugIdMatch = lower.match(/\b(?:bug|issue|task)[\s_-]?(\d+)\b/i);
    if (bugIdMatch) {
      const num = parseInt(bugIdMatch[1]!, 10);
      const foundBug = tasks.find((t) => {
        const titleLower = t.title.toLowerCase();
        const goalLower = t.goal.toLowerCase();
        const pattern = new RegExp(`\\bbug[_-]?0*${num}\\b`, "i");
        return pattern.test(titleLower) || pattern.test(goalLower);
      });
      if (foundBug) return foundBug;
    }

    // 3. Title match — exclude short or generic stop words to prevent false hits on prose
    const COMMON_STOP_WORDS = new Set(["details", "its", "it", "this", "that", "task", "tasks", "failed", "failing", "the", "a", "an", "is", "was", "for", "to", "in", "of", "and", "or", "what", "wrong", "why", "how", "can", "show", "give", "me", "list", "get", "status"]);
    const titleMatch = tasks.find((t) => {
      const cleanTitle = t.title.trim().toLowerCase();
      if (!cleanTitle || COMMON_STOP_WORDS.has(cleanTitle) || cleanTitle.length < 3) return false;
      return lower.includes(cleanTitle);
    });
    if (titleMatch) return titleMatch;

    return lastTaskId ? (tasks.find((t) => t.id === lastTaskId) ?? null) : null;
  }

  getImportedItems(importId: string, actorId: string): BacklogItem[] {
    if (!this.d.bulkService) return [];
    return this.d.bulkService.getItemsForImport(importId, actorId);
  }
}
