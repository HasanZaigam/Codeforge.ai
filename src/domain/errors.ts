/**
 * Thrown internally, by any layer, when an in-progress operation was
 * deliberately interrupted by a cancellation request rather than failing on
 * its own. The Orchestrator is the only place that catches this and decides
 * what it means for task state — everything below it (CodingEngine
 * adapters, the validation runner, the workspace provider) only needs to
 * throw it and stop what it was doing. See /docs/TASK_LIFECYCLE.md
 * "Cancellation".
 */
export class CancellationError extends Error {
  constructor(message = "Operation was cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

/**
 * Thrown only by `Orchestrator.withCancellation`'s own lease heartbeat, when
 * it discovers this process no longer holds the execution lease it started
 * with (another process's claim won — see TaskRepository.claimWorking).
 * Deliberately distinct from `CancellationError`: a human never asked for
 * this to stop, and — critically — the task must NOT be finalized as
 * CANCELLED or have its workspace torn down, because whoever now holds the
 * lease may be actively, legitimately using both. The only safe reaction is
 * to stop doing anything further and let the current lease holder's own
 * execution be authoritative. See /docs/TASK_LIFECYCLE.md "Worker
 * concurrency and lease loss".
 */
export class LeaseLostError extends Error {
  constructor(message = "Execution lease was lost to another process") {
    super(message);
    this.name = "LeaseLostError";
  }
}

/**
 * Thrown by Orchestrator.provisionWorkspace when the branch a task needs to
 * clone from/check out no longer exists on the remote at *execution* time —
 * distinct from the equivalent check TaskService.create already does at
 * *task-creation* time (see /docs/TASK_LIFECYCLE.md "Branch existence
 * validation"). Covers the gap where a branch is deleted (or renamed) after
 * a task was created but before the worker actually got to it. Deliberately
 * a plain, clean, user-facing message — this is caught by the same
 * WORKSPACE_FAILED/TASK_FAILED path every other provisioning failure already
 * uses (see orchestrator.ts), so it must never carry a stack trace or
 * internal detail the UI would otherwise surface verbatim.
 */
export class BranchNotFoundAtExecutionError extends Error {
  constructor(branch: string) {
    super(
      `Branch "${branch}" no longer exists in the repository. It may have been deleted or renamed after this task was created — ` +
        "create a new task once the branch is available again, or choose a different branch.",
    );
    this.name = "BranchNotFoundAtExecutionError";
  }
}

/**
 * Thrown by Orchestrator.startTask when one or more of the task's explicit dependencies (see
 * /docs/TASK_LIFECYCLE.md "Task dependencies") are not yet DONE — the enforcement point is the same
 * atomic UPDATE...WHERE that flips BACKLOG -> TODO (see TaskRepository.releaseFromBacklog's own doc
 * comment), so there is no gap between checking dependencies and releasing the task. Names every
 * incomplete dependency by title, never just a count, so the developer knows exactly what to wait
 * on. The task is left untouched (still BACKLOG) and never reaches FAILED or the worker.
 */
export class IncompleteDependenciesError extends Error {
  constructor(public readonly incomplete: { id: string; title: string; status: string }[]) {
    super(
      incomplete.length === 1
        ? `Task cannot be started because dependency "${incomplete[0]!.title}" is not completed.`
        : `Task cannot be started because these dependencies are not completed: ${incomplete
            .map((d) => `"${d.title}"`)
            .join(", ")}.`,
    );
    this.name = "IncompleteDependenciesError";
  }
}
