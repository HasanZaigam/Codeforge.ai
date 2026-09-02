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
