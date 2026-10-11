import type { BranchComparisonStatus, BranchMode, BugFixVerificationContract, Task, TaskEvent } from "../domain/types.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";
import type { AgentRunRepository } from "../persistence/repositories/agent-run-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { SourceControlProviderRegistry } from "../source-control/source-control-provider.js";
import { createTask } from "../orchestrator/task-factory.js";
import { buildTaskReport, type TaskReport } from "../reporting/task-report.js";
import { assertProjectAccess, assertTaskAccess } from "./authorization.js";
import {
  BranchInUseError,
  CircularDependencyError,
  CrossProjectDependencyError,
  DuplicateDependencyError,
  InvalidBranchSelectionError,
  NotFoundError,
  SelfDependencyError,
  TaskNotEditableError,
} from "./errors.js";
import { isActiveExistingBranchConstraintViolation } from "../persistence/repositories/task-repository.js";
import {
  isDuplicateDependencyViolation,
  type DependencyEdge,
  type DependencyStatus,
  type TaskDependencyRepository,
} from "../persistence/repositories/task-dependency-repository.js";
import { deriveBranchState, type BranchStateSummary } from "../reporting/branch-state.js";
import type { Project } from "../domain/types.js";

/**
 * True iff adding the edge `taskId -> dependsOnTaskId` (task depends on dependsOnTaskId) would
 * create a cycle in the project's dependency graph — i.e. `dependsOnTaskId` can already reach
 * `taskId` by following existing "depends on" edges (directly or indirectly). Real graph
 * reachability (BFS), not just a direct-pair check — see /docs/TASK_LIFECYCLE.md "Task
 * dependencies" — "Circular dependency" rule, requirement 8 (indirect cycles must be rejected too).
 */
export function wouldCreateCycle(taskId: string, dependsOnTaskId: string, existingEdges: DependencyEdge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of existingEdges) {
    if (!adjacency.has(edge.taskId)) adjacency.set(edge.taskId, []);
    adjacency.get(edge.taskId)!.push(edge.dependsOnTaskId);
  }
  // Simulate the proposed edge before traversing, so a direct A->B / B->A pair is caught exactly
  // like an indirect A->B->C->A chain — both are just "can dependsOnTaskId reach taskId."
  if (!adjacency.has(taskId)) adjacency.set(taskId, []);
  adjacency.get(taskId)!.push(dependsOnTaskId);

  const visited = new Set<string>();
  const stack = [...(adjacency.get(taskId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === taskId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  /** Plain-language description — the API never requires a technical prompt. See PRODUCT_REQUIREMENTS.md FR-3. */
  description: string;
  /** See domain/types.ts BranchMode. Defaults to "new". */
  branchMode?: BranchMode;
  /** Mode "new" only: optional custom branch name (else auto-derived). Already charset-validated by CreateTaskSchema. */
  branchName?: string;
  /** Mode "new" only: overrides the project's default branch as the branch to create from. */
  baseBranch?: string;
  /** Mode "existing" only: the branch to work directly on (required by CreateTaskSchema when branchMode is "existing"). */
  existingBranch?: string;
  /**
   * Explicit, user-selected dependency task ids (see /docs/TASK_LIFECYCLE.md "Task dependencies").
   * Always safe at creation time — a brand-new task cannot yet be any other task's dependency, so
   * no circular-dependency check is needed here, only same-project + existence (see `create()`).
   */
  dependencyIds?: string[];
  /**
   * V1.1 Slice 3 — opt-in bug-fix verification contract (see
   * task-factory.ts's CreateTaskInput and domain/types.ts
   * BugFixVerificationContract). Not yet exposed over HTTP (see
   * /docs/PLATFORM_GAPS.md GAP-016's Slice 3 note) — reachable today via
   * this service directly (CLI/tests), same as several other internal-only
   * task-creation options.
   */
  bugFixVerification?: BugFixVerificationContract | null;
  /**
   * Phase 4A — internal-only (never reachable from the HTTP API, whose CreateTaskSchema has neither
   * field): a caller-reserved task id and the backlog provenance recorded on TASK_CREATED. Used
   * solely by BacklogService's proposal conversion — see task-factory.ts CreateTaskInput.
   */
  id?: string;
  origin?: { backlogItemId: string; taskProposalId: string };
}

/**
 * The same field set as CreateTaskInput, minus `projectId` (an edit can
 * never move a task to a different project) — see TaskService.editBacklogTask.
 */
export type EditTaskInput = Omit<CreateTaskInput, "projectId">;

/** Phase 4D.5 — see TaskService.getPullRequestStatus's own doc comment for why this is a separate, explicit shape from `BranchStateSummary`'s `mergeState`. */
export type TaskPullRequestState = "OPEN" | "MERGED" | "CLOSED_NOT_MERGED";

export interface TaskPullRequestInfo {
  hasPullRequest: boolean;
  /** False only when `hasPullRequest` is true but the live provider fetch itself failed — distinct from "no PR exists at all" (`hasPullRequest: false`, `available: true`). */
  available: boolean;
  number: number | null;
  url: string | null;
  provider: string | null;
  state: TaskPullRequestState | null;
  error: string | null;
}

/**
 * Translates task requests into domain operations. Task *creation* is the
 * only write this service performs directly (inserting a TODO task is not
 * an orchestration decision); everything that moves a task forward —
 * claiming, execution, state transitions — belongs to the Orchestrator and
 * is never duplicated here. See /docs/ARCHITECTURE.md layers 4/5.
 *
 * Every method takes the authenticated `actorId` and enforces access via
 * `assertProjectAccess`/`assertTaskAccess` before touching anything — see
 * /docs/AUTHENTICATION.md "Authorization model". Tasks have no owner field
 * of their own; access is entirely derived from the owning project.
 */
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly taskEvents: TaskEventRepository,
    private readonly agentRuns: AgentRunRepository,
    private readonly projects: ProjectRepository,
    private readonly orchestrator: Orchestrator,
    private readonly sourceControlProviders: SourceControlProviderRegistry,
    private readonly dependencies: TaskDependencyRepository,
  ) {}

  /**
   * Creates a task with an explicit branch-mode choice (see
   * /docs/TASK_LIFECYCLE.md "Branch modes"). Default ("new", the only
   * behavior that existed before branch modes did) needs no validation
   * beyond the schema's own charset check. "existing" is validated here,
   * before a Task row is ever inserted:
   *   1. Reject outright if another active (non-terminal) task in this
   *      project is already working directly on the same branch — the
   *      platform has no mechanism to serialize concurrent pushes to one
   *      branch, so this is prevented rather than silently risking it (Part
   *      E of this milestone's brief).
   *   2. Confirm the branch actually exists on the remote — best-effort for
   *      local-git (advisory listing only, see LocalGitSourceControlProvider.listBranches),
   *      but a hard gate for GitHub (a real, checkable fact).
   * "new" mode additionally rejects a custom branch name identical to its
   * own base branch (creating a branch identical to what it would be
   * created from is never meaningful, and — worse — would make the
   * subsequent `git checkout -b` target the base branch itself instead of an
   * isolated copy).
   */
  async create(input: CreateTaskInput, actorId: string): Promise<Task> {
    const project = assertProjectAccess(this.projects, input.projectId, actorId);
    const branchMode: BranchMode = input.branchMode ?? "new";

    try {
      const { workingBranch, baseBranch } = await this.resolveBranchSelection(project, branchMode, input);
      const task = createTask(this.tasks, this.taskEvents, {
        tenantId: project.tenantId,
        projectId: project.id,
        title: input.title,
        goal: input.description,
        createdBy: actorId,
        branchMode,
        workingBranch,
        baseBranch,
        bugFixVerification: input.bugFixVerification,
        id: input.id,
        origin: input.origin,
      });
      // A brand-new task can't yet create a cycle (nothing can depend on it before it exists) — only
      // existence + same-project need checking. Dedupe the input so a repeated id is a silent no-op,
      // not a DuplicateDependencyError surprise on the very first save.
      const dependencyIds = [...new Set(input.dependencyIds ?? [])];
      for (const dependsOnTaskId of dependencyIds) {
        const depTask = this.tasks.findById(dependsOnTaskId);
        if (!depTask) throw new NotFoundError("Task", dependsOnTaskId);
        if (depTask.projectId !== project.id) throw new CrossProjectDependencyError();
        this.dependencies.addIfBacklog(task.id, dependsOnTaskId, new Date().toISOString());
      }
      return task;
    } catch (err) {
      // Closes the race the pre-check inside resolveBranchSelection can't fully close on its own:
      // two requests both passing that check before either has inserted its row. The DB's own
      // unique partial index (migrations/007_branch_race_closure.sql) is the real defense — one
      // of the two concurrent INSERTs always loses here, and this turns that into the exact same
      // user-facing BranchInUseError the pre-check throws for the non-racing case, never a raw
      // SQLite error. See TaskRepository.isActiveExistingBranchConstraintViolation.
      if (branchMode === "existing" && isActiveExistingBranchConstraintViolation(err)) {
        const winner = this.tasks.listActiveUsingExistingBranch(project.id, input.existingBranch!)[0];
        throw new BranchInUseError(input.existingBranch!, winner?.title ?? "another task");
      }
      throw err;
    }
  }

  /**
   * Edits a BACKLOG task's configuration (title/goal/branch selection) — the
   * narrow, explicitly-guarded operation referenced in src/api/routes/tasks.ts's
   * doc comment: never a generic status write, and rejected outright once
   * the task has left BACKLOG (see TaskNotEditableError). Reuses exactly the
   * same branch-selection validation `create()` uses (via
   * `resolveBranchSelection`), excluding this task itself from the
   * "existing branch already in use" check — it's obviously allowed to keep
   * (or re-select) the branch it's already configured to use.
   */
  async editBacklogTask(taskId: string, input: EditTaskInput, actorId: string): Promise<Task> {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    if (task.status !== "BACKLOG") {
      throw new TaskNotEditableError(task.status);
    }
    const project = this.projects.findById(task.projectId)!; // known-accessible via assertTaskAccess above
    const branchMode: BranchMode = input.branchMode ?? "new";

    try {
      const { workingBranch, baseBranch } = await this.resolveBranchSelection(project, branchMode, input, taskId);
      const now = new Date().toISOString();
      const updated = this.tasks.updateBacklogConfig(
        taskId,
        { title: input.title, goal: input.description, branchMode, workingBranch, baseBranch },
        now,
      );
      if (!updated) {
        // Lost a race with something else moving the task out of BACKLOG between the access/status
        // check above and this write (e.g. a concurrent "Start Task" or cancel) — surfaced the same
        // way as the up-front check, never a silent no-op.
        const fresh = this.tasks.findById(taskId);
        throw new TaskNotEditableError(fresh?.status ?? "unknown");
      }
      return this.tasks.findById(taskId)!;
    } catch (err) {
      if (branchMode === "existing" && isActiveExistingBranchConstraintViolation(err)) {
        const winner = this.tasks.listActiveUsingExistingBranch(project.id, input.existingBranch!).find((t) => t.id !== taskId);
        throw new BranchInUseError(input.existingBranch!, winner?.title ?? "another task");
      }
      throw err;
    }
  }

  /**
   * Shared branch-selection validation for both task creation and BACKLOG
   * task editing (see `create()` and `editBacklogTask()`) — kept in exactly
   * one place so the two operations can never drift:
   *   1. "existing" mode: reject if another active (non-terminal) task in
   *      this project already works directly on the same branch (excluding
   *      `excludeTaskId` itself, when editing), then confirm the branch
   *      actually exists on the remote (best-effort for local-git, a hard
   *      gate for GitHub — see SourceControlProvider.listBranches).
   *   2. "new" mode: reject a custom branch name identical to its own base
   *      branch.
   * Throws BranchInUseError / InvalidBranchSelectionError; never touches
   * persistence itself — callers still own the actual write (and its own
   * race-closure retry against the DB's unique index).
   */
  private async resolveBranchSelection(
    project: Project,
    branchMode: BranchMode,
    input: { branchName?: string; baseBranch?: string; existingBranch?: string },
    excludeTaskId?: string,
  ): Promise<{ workingBranch: string | null; baseBranch: string | null }> {
    if (branchMode === "existing") {
      const branch = input.existingBranch!; // guaranteed present by CreateTaskSchema/EditTaskSchema's refine
      const conflicting = this.tasks.listActiveUsingExistingBranch(project.id, branch).find((t) => t.id !== excludeTaskId);
      if (conflicting) {
        throw new BranchInUseError(branch, conflicting.title);
      }

      const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
      const controller = new AbortController();
      const knownBranches = await scProvider.listBranches(project, controller.signal);
      // An empty result from a provider that can't reliably enumerate branches (local-git's
      // best-effort git ls-remote) is treated as "couldn't verify," not "no branches exist" — see
      // listBranches's own doc comment. Any non-empty result IS treated as authoritative, GitHub's
      // real API listing included.
      if (knownBranches.length > 0 && !knownBranches.includes(branch)) {
        throw new InvalidBranchSelectionError(
          `Branch "${branch}" was not found in this repository. It may have been renamed or deleted — refresh the branch list and try again.`,
        );
      }
      return { workingBranch: branch, baseBranch: null };
    }

    const effectiveBase = (input.baseBranch?.trim() || project.defaultBranch).trim();
    if (input.branchName && input.branchName === effectiveBase) {
      throw new InvalidBranchSelectionError(
        `Branch name "${input.branchName}" cannot be the same as the base branch "${effectiveBase}" — choose a different name for the new branch.`,
      );
    }
    return { workingBranch: input.branchName ?? null, baseBranch: input.baseBranch ?? null };
  }

  /** See SourceControlProvider.listBranches's own doc comment — advisory UI data for the "existing branch" picker. */
  async listBranches(projectId: string, actorId: string): Promise<string[]> {
    const project = assertProjectAccess(this.projects, projectId, actorId);
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
    const controller = new AbortController();
    return scProvider.listBranches(project, controller.signal);
  }

  /**
   * Stale/behind + merge/conflict state for a task's branch — read on demand
   * for display only (see /docs/TASK_LIFECYCLE.md "Stale/behind detection"
   * and "Merge/conflict state"); never gates or drives task execution. A
   * task with no branch yet (still TODO) or whose provider read fails
   * reports the honest "can't tell" shape rather than throwing — this is
   * advisory UI data, the same policy `listBranches` already follows.
   */
  async getBranchState(taskId: string, actorId: string): Promise<BranchStateSummary> {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    const project = this.projects.findById(task.projectId); // already known-accessible via assertTaskAccess above
    const branch = task.taskRecord.branchName ?? task.workingBranch;
    if (!project || !branch) {
      return deriveBranchState(null, null, null);
    }

    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
    const controller = new AbortController();
    // Mirrors Orchestrator.runWorkingEpisode's own `pullRequestBaseBranch` derivation (see its doc
    // comment): "existing" mode always merges to the project's default branch; "new" mode compares
    // against whatever base it was branched from.
    const baseBranch = task.branchMode === "new" ? (task.baseBranch ?? project.defaultBranch) : project.defaultBranch;
    const pr = task.taskRecord.pullRequest;

    const [prStatus, comparison] = await Promise.all([
      pr ? scProvider.getPullRequestStatus(project, pr, controller.signal).catch(() => null) : Promise.resolve(null),
      scProvider
        .getBranchStatus(project, branch, baseBranch, controller.signal)
        .catch((): BranchComparisonStatus => ({ comparable: false, aheadBy: null, behindBy: null })),
    ]);
    return deriveBranchState(pr, prStatus, comparison);
  }

  /**
   * Phase 4D.5 — the real GitHub (or other provider) Pull Request state for a task, kept DELIBERATELY
   * separate from `TaskStatus`: a task can be `DONE` with its PR merged OR unmerged (human-confirmed
   * completion never checks the PR at all — see `completeTaskByHuman`), and a task can be `REVIEW` with
   * its PR open, closed-without-merging, or already merged (the next poll/on-demand check will catch up).
   * Reuses the EXACT SAME `sourceControlProviders` registry and `getPullRequestStatus` call
   * `getBranchState`/`finalizeMergedPullRequest` already use — never a second GitHub client. Unlike
   * `getBranchState` (which folds "no PR" and "the live fetch failed" into the same `mergeState:
   * "UNKNOWN"`), this distinguishes them explicitly, since Chat needs to say something different for each
   * ("No PR is associated with this task" vs. "GitHub is currently unavailable").
   */
  async getPullRequestStatus(taskId: string, actorId: string): Promise<TaskPullRequestInfo> {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    const pr = task.taskRecord.pullRequest;
    if (!pr) {
      return { hasPullRequest: false, available: true, number: null, url: null, provider: null, state: null, error: null };
    }
    const project = this.projects.findById(task.projectId); // already known-accessible via assertTaskAccess above
    if (!project) {
      return { hasPullRequest: true, available: false, number: pr.number, url: pr.url, provider: pr.provider, state: null, error: "This project could no longer be found." };
    }
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
    try {
      const status = await scProvider.getPullRequestStatus(project, pr, new AbortController().signal);
      const state: TaskPullRequestState = status.merged ? "MERGED" : status.state === "closed" ? "CLOSED_NOT_MERGED" : "OPEN";
      return { hasPullRequest: true, available: true, number: pr.number, url: pr.url, provider: pr.provider, state, error: null };
    } catch (err) {
      return {
        hasPullRequest: true,
        available: false,
        number: pr.number,
        url: pr.url,
        provider: pr.provider,
        state: null,
        error: err instanceof Error ? err.message : "Could not reach the source control provider.",
      };
    }
  }

  get(taskId: string, actorId: string): Task {
    return assertTaskAccess(this.tasks, this.projects, taskId, actorId);
  }

  listForProject(projectId: string, actorId: string): Task[] {
    assertProjectAccess(this.projects, projectId, actorId);
    return this.tasks.listByProject(projectId);
  }

  listEvents(taskId: string, actorId: string): TaskEvent[] {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.taskEvents.listForTask(taskId);
  }

  getReport(taskId: string, actorId: string): TaskReport {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    const project = this.projects.findById(task.projectId); // already known-accessible via assertTaskAccess above
    const runs = this.agentRuns.listForTask(taskId);
    const events = this.taskEvents.listForTask(taskId);
    // Mirrors Orchestrator.runWorkingEpisode's own `pullRequestBaseBranch` derivation: "existing"
    // mode always merges to the project's default branch; "new" mode merges to whatever base it
    // was branched from (which may be a task-level override, not the project default).
    const baseBranch = task.branchMode === "new" ? (task.baseBranch ?? project?.defaultBranch ?? "main") : (project?.defaultBranch ?? "main");
    return buildTaskReport(task, runs, events, baseBranch);
  }

  /**
   * Releases a BACKLOG task into TODO — the explicit "Start Task" action a
   * human takes before the worker will ever touch it (see
   * /docs/TASK_LIFECYCLE.md "Task lifecycle"). Delegates entirely to
   * Orchestrator.startTask(), which owns the atomic BACKLOG -> TODO
   * transition and its concurrency-safety guard — this method's only job is
   * the access check every other method here performs first.
   */
  startTask(taskId: string, actorId: string): Task {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.orchestrator.startTask(taskId);
  }

  /**
   * Requests cancellation of a task. Delegates entirely to
   * Orchestrator.requestCancellation() — this is a domain command, not a
   * status write, and the state-machine legality rules (which states are
   * cancellable, idempotency) live exactly once, in the Orchestrator/state
   * machine, not duplicated here. See /docs/TASK_LIFECYCLE.md "Cancellation".
   */
  async cancelTask(taskId: string, actorId: string): Promise<Task> {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.orchestrator.requestCancellation(taskId, actorId);
  }

  /**
   * Phase 4D.4 — a human explicitly marks a REVIEW task Done (e.g. via Chat, after an explicit
   * confirmation — see ActionLayerService.completeTaskAsHuman). Delegates entirely to
   * Orchestrator.acceptReview(), the SAME "accepted" transition the automatic PR-merge path
   * (`finalizeReviewAsDoneOnMerge`) drives — this is not a second completion mechanism, just a second
   * caller of the one that already existed. `completedVia` records the surface that asked, purely for
   * audit/history — never trusted as an authorization signal (the real check is `assertTaskAccess`
   * just below, exactly like every other mutation here).
   */
  completeTaskByHuman(taskId: string, actorId: string, completedVia: string): Task {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.orchestrator.acceptReview(taskId, { completedBy: actorId, completedVia });
  }

  /**
   * On-demand check for new human GitHub PR review feedback on a REVIEW
   * task — the same operation the worker's own poll loop runs
   * automatically (see Worker.tick), exposed here so a developer doesn't
   * have to wait for the next poll interval. A no-op for anything other
   * than a REVIEW task with a PR and new feedback — see
   * Orchestrator.checkHumanReviewFeedback.
   */
  async checkReviewFeedback(taskId: string, actorId: string): Promise<Task> {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.orchestrator.checkHumanReviewFeedback(taskId);
  }

  // -------------------------------------------------------------------
  // Explicit task dependencies (see /docs/TASK_LIFECYCLE.md "Task dependencies").
  // Directed, AND-semantics, user-defined only — no inference. Editable only while BACKLOG; enforced
  // server-side here, never just by the frontend disabling the control. See GET/POST/DELETE
  // /tasks/:taskId/dependencies in src/api/routes/tasks.ts.
  // -------------------------------------------------------------------

  /** This task's current dependencies, each with the dependency's own live status — GET /tasks/:taskId/dependencies. */
  listDependencies(taskId: string, actorId: string): DependencyStatus[] {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.dependencies.listDependencies(taskId);
  }

  /**
   * Adds one dependency edge (`taskId` depends on `dependsOnTaskId`) — only while `taskId` is
   * BACKLOG. Validates, in order: self-dependency (5), cross-project (6), then real graph
   * reachability for circular dependencies (8, including indirect cycles) — all using the fresh
   * project-wide edge set read just before the write. The actual BACKLOG-only guard is enforced
   * atomically by `TaskDependencyRepository.addIfBacklogAndAcyclic`'s own single INSERT...WHERE
   * EXISTS/NOT EXISTS statement, the same technique `updateBacklogConfig`/`releaseFromBacklog`
   * already use for the BACKLOG guard, extended with a `WITH RECURSIVE` cycle check evaluated in
   * that SAME statement — so a "Start Task" racing this call can never result in an edge silently
   * attached to a task that has already left BACKLOG, AND two concurrent `addDependency` calls
   * (from different platform processes) can never jointly create a cycle that neither call would
   * have created alone. The `wouldCreateCycle` check just below remains as a fast, friendly
   * pre-validation for the ordinary (non-racing) request — see `addIfBacklogAndAcyclic`'s own doc
   * comment for exactly why the real, race-safe guarantee lives in that repository method, not
   * here. Duplicate edges (7) are rejected via the table's own PRIMARY KEY — see
   * `isDuplicateDependencyViolation`.
   */
  async addDependency(taskId: string, dependsOnTaskId: string, actorId: string): Promise<DependencyStatus[]> {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    if (task.status !== "BACKLOG") {
      throw new TaskNotEditableError(task.status);
    }
    if (taskId === dependsOnTaskId) {
      throw new SelfDependencyError();
    }
    const depTask = this.tasks.findById(dependsOnTaskId);
    if (!depTask) {
      throw new NotFoundError("Task", dependsOnTaskId);
    }
    if (depTask.projectId !== task.projectId) {
      throw new CrossProjectDependencyError();
    }
    const projectEdges = this.dependencies.listEdgesForProject(task.projectId);
    if (wouldCreateCycle(taskId, dependsOnTaskId, projectEdges)) {
      throw new CircularDependencyError();
    }

    try {
      // Authoritative, race-safe check-and-insert — see this method's own doc comment above and
      // `addIfBacklogAndAcyclic`'s for why the pre-check above is not, by itself, enough under
      // concurrent writers.
      const outcome = this.dependencies.addIfBacklogAndAcyclic(taskId, dependsOnTaskId, new Date().toISOString());
      if (outcome === "not-backlog") {
        // Lost a race with something else moving the task out of BACKLOG between the check above
        // and this write (e.g. a concurrent "Start Task") — re-read and report what's true now.
        const fresh = this.tasks.findById(taskId);
        throw new TaskNotEditableError(fresh?.status ?? "unknown");
      }
      if (outcome === "cycle") {
        // Lost a race with a different concurrent addDependency call that inserted an edge, between
        // this method's own pre-check above and this write, which together with this edge would
        // create a cycle — the pre-check alone couldn't see it. Same user-facing error as the
        // ordinary (non-racing) case above; the caller has no need to distinguish the two.
        throw new CircularDependencyError();
      }
    } catch (err) {
      if (isDuplicateDependencyViolation(err)) {
        throw new DuplicateDependencyError(depTask.title);
      }
      throw err;
    }
    return this.dependencies.listDependencies(taskId);
  }

  /** Removes one dependency edge — only while `taskId` is BACKLOG, same atomic guard as `addDependency`. Idempotent: removing an edge that doesn't exist (while still BACKLOG) is a silent no-op, not an error. */
  removeDependency(taskId: string, dependsOnTaskId: string, actorId: string): DependencyStatus[] {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    if (task.status !== "BACKLOG") {
      throw new TaskNotEditableError(task.status);
    }
    const removed = this.dependencies.removeIfBacklog(taskId, dependsOnTaskId);
    if (!removed) {
      // Either the edge never existed (fine — idempotent no-op) or the task left BACKLOG in the
      // instant between the check above and this write. Only the latter is actually an error.
      const fresh = this.tasks.findById(taskId);
      if (fresh?.status !== "BACKLOG") {
        throw new TaskNotEditableError(fresh?.status ?? "unknown");
      }
    }
    return this.dependencies.listDependencies(taskId);
  }
}
