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
