import type { Task } from "../domain/types.js";
import type { TaskService } from "./task-service.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";
import { NotFoundError } from "./errors.js";

/**
 * Phase 4D.2 — the Action Layer: the ONLY way Chat may mutate CodeForge state. Every method here
 * delegates the actual mutation to the EXISTING `TaskService` (the same service the Tasks UI/API use —
 * never a direct repository write, never a second task system), then reads the task back from the
 * database and verifies the state actually changed as expected BEFORE reporting success. See
 * /docs/CHAT.md "Action Layer" — this file's entire reason to exist is Objective 6/23 of that phase:
 * "a model's statement that it performed a mutation is not evidence; the platform owns the truth."
 */

export type ChatActionType = "CREATE_TASK" | "EDIT_TASK_TITLE" | "START_TASK" | "CANCEL_TASK" | "MARK_DONE" | "RETRY_TASK";

export interface ActionResult {
  action: ChatActionType;
  targetTaskId: string | null;
  attempted: boolean;
  succeeded: boolean;
  previousState: string | null;
  newState: string | null;
  changedFields: string[];
  /** A short, human-readable description of what confirmed the result (or why it wasn't confirmed) — never raw internals. */
  evidence: string | null;
  error: string | null;
  verifiedAt: string | null;
}

const now = () => new Date().toISOString();

function ok(action: ChatActionType, taskId: string, previousState: string | null, newState: string, changedFields: string[], evidence: string): ActionResult {
  return { action, targetTaskId: taskId, attempted: true, succeeded: true, previousState, newState, changedFields, evidence, error: null, verifiedAt: now() };
}

function failed(action: ChatActionType, taskId: string | null, previousState: string | null, error: string): ActionResult {
  return { action, targetTaskId: taskId, attempted: true, succeeded: false, previousState, newState: previousState, changedFields: [], evidence: null, error, verifiedAt: now() };
}

function isActionResult(v: Task | ActionResult): v is ActionResult {
  return typeof v === "object" && v !== null && "succeeded" in v;
}

export class ActionLayerService {
  constructor(
    private readonly d: {
      tasks: TaskService;
      taskEvents: TaskEventRepository;
    },
  ) {}

  /** Records that a Chat-driven mutation happened, in the SAME event stream the Tasks UI/worker append to — never a parallel Chat-only history (Objective 9). Appended ONLY after the mutation succeeded AND was read back and verified — never speculatively. */
  private audit(taskId: string, action: ChatActionType, actorId: string, previousState: string | null, newState: string, changedFields: string[]) {
    this.d.taskEvents.append(taskId, "CHAT_ACTION_PERFORMED", { source: "chat", action, actorId, previousState, newState, changedFields }, now());
  }

  /** A) Create a task — the SAME `TaskService.create` the API/UI use. Always lands in BACKLOG; never started. */
  async createTask(projectId: string, actorId: string, input: { title: string; description: string }): Promise<ActionResult & { taskId?: string }> {
    let task: Task;
    try {
      task = await this.d.tasks.create({ projectId, title: input.title, description: input.description }, actorId);
    } catch (err) {
      return { ...failed("CREATE_TASK", null, null, err instanceof Error ? err.message : "Task creation failed."), taskId: undefined };
    }
    // Read back — the create() call already returned the persisted row, but re-reading confirms it is
    // actually retrievable via the same authorized path every other read uses (not just trusting the echo).
    const verified = this.d.tasks.get(task.id, actorId);
    if (verified.status !== "BACKLOG") {
      return { ...failed("CREATE_TASK", task.id, null, `Task was created but is unexpectedly in ${verified.status}, not BACKLOG.`), taskId: task.id };
    }
    this.audit(task.id, "CREATE_TASK", actorId, null, "BACKLOG", ["title", "description"]);
    return { ...ok("CREATE_TASK", task.id, null, "BACKLOG", ["title", "description"], `Read back: task ${task.id} exists with status BACKLOG.`), taskId: task.id };
  }

  /** B) Edit a task's title — reuses `TaskService.editBacklogTask` exactly as the Tasks UI does. Only legal while BACKLOG (the existing domain rule) — never bypassed. */
  async editTaskTitle(projectId: string, actorId: string, taskId: string, newTitle: string): Promise<ActionResult> {
    const before = this.requireTaskInProject(projectId, taskId, actorId, "EDIT_TASK_TITLE");
    if (isActionResult(before)) return before;
    const task = before;
    if (task.status !== "BACKLOG") {
      return failed("EDIT_TASK_TITLE", taskId, task.status, `"${task.title}" is ${task.status}, not BACKLOG — CodeForge only allows editing a task while it's still in Backlog.`);
    }
    try {
      await this.d.tasks.editBacklogTask(taskId, { title: newTitle, description: task.goal }, actorId);
    } catch (err) {
      return failed("EDIT_TASK_TITLE", taskId, task.status, err instanceof Error ? err.message : "Edit failed.");
    }
    const after = this.d.tasks.get(taskId, actorId);
    if (after.title !== newTitle) {
      return failed("EDIT_TASK_TITLE", taskId, task.status, `The edit call succeeded but the title reads back as "${after.title}", not "${newTitle}" — reporting the real state, not the requested one.`);
    }
    this.audit(taskId, "EDIT_TASK_TITLE", actorId, task.title, after.title, ["title"]);
    return ok("EDIT_TASK_TITLE", taskId, task.title, after.title, ["title"], `Read back: title is now "${after.title}".`);
  }

  /**
   * C) Start a task — reuses `TaskService.startTask` (Orchestrator.startTask), the SAME "Start Task"
   * button the Tasks UI calls. Expected transition: BACKLOG → TODO.
   *
   * Idempotency (Phase 4D.3, Objective 20): a task already in TODO gets a clean "already To Do" message
   * BEFORE the domain call is even attempted — not a raw state-machine error — so a repeated/accidental
   * "start it" never looks like something went wrong. This still reports `succeeded: false` (nothing
   * changed, matching the real outcome), distinct from a genuinely invalid transition (e.g. starting a
   * WORKING/REVIEW/CANCELLED task), which still goes through the domain call and surfaces its own error.
   */
  async startTask(projectId: string, actorId: string, taskId: string): Promise<ActionResult> {
    const before = this.requireTaskInProject(projectId, taskId, actorId, "START_TASK");
    if (isActionResult(before)) return before;
    const task = before;
    if (task.status === "TODO") {
      return failed("START_TASK", taskId, "TODO", `"${task.title}" is already To Do — nothing to change.`);
    }
    try {
      this.d.tasks.startTask(taskId, actorId);
    } catch (err) {
      return failed("START_TASK", taskId, task.status, err instanceof Error ? err.message : "Start failed.");
    }
    const after = this.d.tasks.get(taskId, actorId);
    if (after.status !== "TODO") {
      return failed("START_TASK", taskId, task.status, `The start call returned without error, but the task now reads ${after.status}, not TODO — reporting the real state.`);
    }
    this.audit(taskId, "START_TASK", actorId, task.status, after.status, ["status"]);
    return ok("START_TASK", taskId, task.status, after.status, ["status"], `Read back: status is now TODO.`);
  }

  /**
   * D) Cancel a task — reuses `TaskService.cancelTask` (Orchestrator.requestCancellation), the SAME
   * cancellation path the Tasks UI uses. A WORKING task's cancellation is a request the in-flight
   * execution honors, not an instant status flip — reported honestly either way.
   *
   * Idempotency (Phase 4D.3, Objective 20): a task already CANCELLED is reported as such — `succeeded:
   * true`, no domain call attempted, no new audit event (nothing actually changed) — rather than
   * attempting a duplicate cancellation the state machine would just reject.
   */
  async cancelTask(projectId: string, actorId: string, taskId: string): Promise<ActionResult> {
    const before = this.requireTaskInProject(projectId, taskId, actorId, "CANCEL_TASK");
    if (isActionResult(before)) return before;
    const task = before;
    if (task.status === "CANCELLED") {
      return { ...ok("CANCEL_TASK", taskId, "CANCELLED", "CANCELLED", [], "Already Cancelled — nothing to change."), succeeded: true };
    }
    let after: Task;
    try {
      after = await this.d.tasks.cancelTask(taskId, actorId);
    } catch (err) {
      return failed("CANCEL_TASK", taskId, task.status, err instanceof Error ? err.message : "Cancel failed.");
    }
    // Re-read (cancelTask's own return is already fresh, but this keeps every action's verification step identical/auditable).
    const verified = this.d.tasks.get(taskId, actorId);
    if (verified.status === "CANCELLED") {
      this.audit(taskId, "CANCEL_TASK", actorId, task.status, verified.status, ["status"]);
      return ok("CANCEL_TASK", taskId, task.status, verified.status, ["status"], "Read back: status is now CANCELLED.");
    }
    if (task.status === "WORKING" && verified.status === "WORKING") {
      // Cancellation intent recorded; the in-flight execution finalizes it — this is the EXISTING, correct
      // behavior (see Orchestrator.requestCancellation), not a failure.
      this.audit(taskId, "CANCEL_TASK", actorId, task.status, verified.status, []);
      return { ...ok("CANCEL_TASK", taskId, task.status, verified.status, [], "Cancellation requested; the task is still WORKING and will finish cancelling once the in-flight execution notices."), succeeded: true };
    }
    return failed("CANCEL_TASK", taskId, task.status, `The cancel call returned without error, but the task now reads ${verified.status} — reporting the real state.`);
  }

  /**
   * E) "Mark Done" (no confirmation) — the UNINFORMED/non-Review path. Phase 4D.4 added a REAL,
   * confirmation-gated human-completion path for a REVIEW task (see `completeTaskAsHuman` below) —
   * this method is no longer the only word on completion, but it's still exactly right for the two
   * cases it covers: a task that's already DONE (idempotent, nothing to do), and a task in any OTHER
   * non-REVIEW state, where manual completion genuinely isn't supported (there's still no legitimate
   * transition from BACKLOG/TODO/WORKING/NEEDS_INPUT/FAILED/CANCELLED straight to DONE, and this phase
   * doesn't invent one). `chat-intent.ts` only calls this method when the task is NOT currently in
   * REVIEW; a REVIEW task is routed to the confirmation flow instead, never straight here.
   */
  async markDone(projectId: string, actorId: string, taskId: string): Promise<ActionResult> {
    const before = this.requireTaskInProject(projectId, taskId, actorId, "MARK_DONE");
    if (isActionResult(before)) return before;
    const task = before;
    if (task.status === "DONE") {
      return { ...ok("MARK_DONE", taskId, "DONE", "DONE", [], "Already DONE — nothing to change."), succeeded: true };
    }
    const nextStep =
      task.status === "REVIEW"
        ? "CodeForge marks a task Done automatically once its Pull Request is merged on GitHub, or a human can confirm it manually from Chat — ask me again and I'll confirm before making any change."
        : `A task can only reach Done from Review. "${task.title}" is currently ${task.status}, so Done isn't reachable yet.`;
    return failed("MARK_DONE", taskId, task.status, nextStep);
  }

  /**
   * E2) Human-confirmed completion (Phase 4D.4) — the ONLY way Chat may ever move a task from REVIEW
   * to DONE, and ONLY ever called by chat-intent.ts AFTER an explicit confirmation reply to a proposal
   * it already showed the user (never on the first "mark it done" message). Reuses
   * `TaskService.completeTaskByHuman` -> `Orchestrator.acceptReview` — the SAME "accepted" transition
   * the (currently unused) in-app Accept path was always meant to drive, now actually wired up; never a
   * second completion mechanism, never a direct status write. Re-reads the task FRESH here (not the
   * status observed when the proposal was made) so a task that changed between propose and confirm
   * (e.g. the PR was merged automatically in the meantime) is handled honestly rather than blindly
   * re-applying a stale decision.
   */
  async completeTaskAsHuman(projectId: string, actorId: string, taskId: string): Promise<ActionResult> {
    const before = this.requireTaskInProject(projectId, taskId, actorId, "MARK_DONE");
    if (isActionResult(before)) return before;
    const task = before;
    if (task.status === "DONE") {
      return { ...ok("MARK_DONE", taskId, "DONE", "DONE", [], "Already Done — no additional change was made."), succeeded: true };
    }
    if (task.status !== "REVIEW") {
      return failed("MARK_DONE", taskId, task.status, `"${task.title}" is no longer in Review (it's now ${task.status}), so I didn't apply the requested human completion.`);
    }
    try {
      await this.d.tasks.completeTaskByHuman(taskId, actorId, "CHAT");
    } catch (err) {
      return failed("MARK_DONE", taskId, task.status, err instanceof Error ? err.message : "Completion failed.");
    }
    const after = this.d.tasks.get(taskId, actorId);
    if (after.status !== "DONE") {
      return failed("MARK_DONE", taskId, task.status, `The completion call returned without error, but the task now reads ${after.status}, not Done — reporting the real state.`);
    }
    this.audit(taskId, "MARK_DONE", actorId, task.status, after.status, ["status"]);
    return ok("MARK_DONE", taskId, task.status, after.status, ["status"], "Read back: status is now DONE.");
  }

  /**
   * F) Retry/re-run — CodeForge's state machine has NO transition out of FAILED at all (it is terminal
   * — see task-state-machine.ts). There is no existing retry/re-run domain operation to reuse, so per
   * this phase's own rule ("only implement if a real existing domain/service operation already supports
   * it"), this is never invented — it always reports the honest limitation.
   */
  async retryTask(projectId: string, actorId: string, taskId: string): Promise<ActionResult> {
    const before = this.requireTaskInProject(projectId, taskId, actorId, "RETRY_TASK");
    if (isActionResult(before)) return before;
    const task = before;
    return failed("RETRY_TASK", taskId, task.status, "CodeForge doesn't currently have a retry/re-run action — a FAILED task is terminal. Create a new task to try again.");
  }

  /**
   * G) Bulk cancel/start (Phase 4D.3) — NOT a new domain operation: each task id is run through the SAME
   * single-task `cancelTask`/`startTask` above, one at a time, each with its own full
   * resolve/authorize/mutate/read-back-verify cycle. A bulk request never becomes a single all-or-nothing
   * transaction and never bypasses per-task authorization/verification — one task's failure (e.g. it was
   * already terminal) never blocks or masks another's success (Objective 12/37, "partial bulk failure
   * handling"). The caller (chat-intent.ts) is responsible for proposing the exact target set to the user
   * and only invoking this after an explicit confirmation — this method itself has no confirmation
   * concept; it executes exactly the ids it's given.
   */
  async bulkCancel(projectId: string, actorId: string, taskIds: string[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const taskId of taskIds) results.push(await this.cancelTask(projectId, actorId, taskId));
    return results;
  }

  async bulkStart(projectId: string, actorId: string, taskIds: string[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const taskId of taskIds) results.push(await this.startTask(projectId, actorId, taskId));
    return results;
  }

  /** Shared resolve+authorize+project-scope step every action starts with — reuses the EXACT same authorization TaskService already enforces (Objective 10/11), never a separate/weaker path. Returns a Task on success, or an already-formed ActionResult on failure (never throws for an expected "not found"). */
  private requireTaskInProject(projectId: string, taskId: string, actorId: string, action: ChatActionType): Task | ActionResult {
    try {
      const task = this.d.tasks.get(taskId, actorId);
      if (task.projectId !== projectId) return failed(action, taskId, null, "That task doesn't belong to this project.");
      return task;
    } catch (err) {
      if (err instanceof NotFoundError) return failed(action, taskId, null, "I couldn't find that task.");
      throw err;
    }
  }
}
