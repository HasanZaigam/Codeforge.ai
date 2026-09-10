/**
 * Deterministic task state machine. The Orchestrator is the only caller of
 * `transition()`. No LLM output ever sets task status directly — an agent's
 * structured StepResult/ReviewResult is *evidence* the Orchestrator evaluates
 * against these explicit rules. See /docs/AGENT_ARCHITECTURE.md.
 */
import type { TaskStatus } from "./types.js";

/** Every trigger that can legally move a task between states. */
export type TaskTransitionTrigger =
  | "released" // a human explicitly releases a BACKLOG task into TODO (see TaskService.startTask)
  | "claim" // worker picks up a TODO (or answered NEEDS_INPUT) task
  | "blocked" // Orchestrator determines the task cannot safely proceed
  | "gates_passed" // all validation gates + Reviewer approved
  | "gates_failed_retry" // a gate/reviewer rejected but self-fix budget remains -> stays WORKING
  | "answered" // human submitted an answer to a HumanInputRequest
  | "accepted" // human accepted the REVIEW result
  | "changes_requested" // human sent it back for more work from REVIEW
  | "infra_failure" // unrecoverable platform-level failure, not a model judgment call
  | "cancel"; // developer requested cancellation and it has taken effect (see requestCancellation)

export interface TransitionRule {
  from: TaskStatus;
  trigger: TaskTransitionTrigger;
  to: TaskStatus;
}

/**
 * The full, exhaustive transition table. Deliberately small: internal
 * execution steps (implement/validate/review) are tracked via AgentRun +
 * TaskEvent records, not additional Task states.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: "BACKLOG", trigger: "released", to: "TODO" },
  { from: "TODO", trigger: "claim", to: "WORKING" },
  { from: "WORKING", trigger: "gates_passed", to: "REVIEW" },
  { from: "WORKING", trigger: "blocked", to: "NEEDS_INPUT" },
  { from: "WORKING", trigger: "infra_failure", to: "FAILED" },
  { from: "NEEDS_INPUT", trigger: "answered", to: "WORKING" },
  { from: "NEEDS_INPUT", trigger: "infra_failure", to: "FAILED" },
  { from: "REVIEW", trigger: "accepted", to: "DONE" },
  { from: "REVIEW", trigger: "changes_requested", to: "WORKING" },
  { from: "BACKLOG", trigger: "cancel", to: "CANCELLED" },
  { from: "TODO", trigger: "cancel", to: "CANCELLED" },
  { from: "WORKING", trigger: "cancel", to: "CANCELLED" },
  { from: "NEEDS_INPUT", trigger: "cancel", to: "CANCELLED" },
] as const;

// `gates_failed_retry` intentionally has no row: it is a self-loop handled
// inside the WORKING episode (self-fix loop) and never touches Task.status.

// `cancel` deliberately has NO row from REVIEW, DONE, or FAILED:
//  - REVIEW/DONE: execution already finished: there is nothing running left to stop, and
//    discarding a result that already passed validation + independent review is a different
//    capability ("discard"/"reject a finished result") than cancellation, and out of scope here.
//  - FAILED: already terminal for an unrelated (infrastructure) reason.
// BACKLOG *does* get a `cancel` row: a task sitting in BACKLOG has exactly the same "nothing is
// currently executing anywhere" property TODO has (see requestCancellation's TODO/NEEDS_INPUT
// branch) — it just hasn't even been released to the worker yet. Treating it as not-cancellable
// would leave a developer who created a task by mistake with no way to remove it except "Start"
// then "Cancel," which is more surprising than simply allowing the same immediate-finalize path
// TODO already uses. See TaskRepository.finalizeCancellationOnBacklog.
// CANCELLED itself has no outgoing rows at all — terminal by design, per
// /docs/TASK_LIFECYCLE.md "Cancellation": nothing resumes a cancelled task. Repeated cancel
// requests against an already-CANCELLED task are handled as an idempotent no-op by the
// Orchestrator (see requestCancellation), not by adding a CANCELLED -> CANCELLED row here.

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly trigger: TaskTransitionTrigger,
  ) {
    super(`Invalid task transition: cannot apply "${trigger}" from state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set(["DONE", "FAILED", "CANCELLED"]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/**
 * Pure function: given the current status and a trigger, returns the next
 * status or throws InvalidTransitionError. No side effects, no I/O — safe to
 * unit test exhaustively and safe to call speculatively before committing.
 */
export function transition(from: TaskStatus, trigger: TaskTransitionTrigger): TaskStatus {
  const rule = TRANSITIONS.find((r) => r.from === from && r.trigger === trigger);
  if (!rule) {
    throw new InvalidTransitionError(from, trigger);
  }
  return rule.to;
}

export function canTransition(from: TaskStatus, trigger: TaskTransitionTrigger): boolean {
  return TRANSITIONS.some((r) => r.from === from && r.trigger === trigger);
}
