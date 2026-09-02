import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Task } from "../domain/types.js";

export interface WorkerConfig {
  pollIntervalMs: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = { pollIntervalMs: 2000 };

/**
 * Minimal polling worker (per /docs/MVP_SCOPE.md and TD-12: lease-based
 * claiming was a deliberate choice over a message broker — this is the
 * process that actually drives it). Each tick lists TODO and WORKING tasks
 * and hands every candidate to Orchestrator.executeTask(), which reuses the
 * existing atomic claim (TaskRepository.claimTodo/claimWorking) as the sole
 * source of truth for "who gets to run this" — the worker never decides
 * that itself. Safe to run as multiple processes against the same database:
 * only the DB-level claim, not this loop, determines the winner.
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Tasks this worker instance currently has an executeTask() call in flight for — prevents this
   *  process's own overlapping ticks from calling executeTask() twice for the same task while the
   *  first call is still running (claimWorking's same-owner lease-renewal rule would otherwise let
   *  a second in-process call race the first; see TECHNICAL_DECISIONS.md). */
  private readonly inFlight = new Set<string>();
  private currentTick: Promise<void> = Promise.resolve();

  constructor(
    private readonly tasks: TaskRepository,
    private readonly orchestrator: Orchestrator,
    private readonly config: WorkerConfig = DEFAULT_WORKER_CONFIG,
    private readonly onTaskError: (taskId: string, error: unknown) => void = () => {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.currentTick = this.tick().finally(() => this.scheduleNext());
  }

  /** Stops scheduling new ticks and waits for any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.currentTick;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentTick = this.tick().finally(() => this.scheduleNext());
    }, this.config.pollIntervalMs);
  }

  /** Runs one poll cycle immediately; exposed directly for deterministic tests instead of waiting on the interval. */
  async tick(): Promise<void> {
    this.orchestrator.recoverOrphanedTasks();

    const workCandidates = [...this.tasks.listByStatus("TODO"), ...this.tasks.listByStatus("WORKING")].filter(
      (task) => !this.inFlight.has(task.id),
    );
    // REVIEW tasks are polled too, but quietly (see runOne's `verbose` flag below) — a task can sit
    // in REVIEW for a long time with nothing to report on most ticks; only checkHumanReviewFeedback
    // (a no-op unless the task's PR has new, unprocessed human feedback) runs against them. See
    // /docs/TASK_LIFECYCLE.md "Human review feedback loop".
    const reviewCandidates = this.tasks.listByStatus("REVIEW").filter((task) => !this.inFlight.has(task.id));

    await Promise.allSettled([
      ...workCandidates.map((task) => this.runOne(task, () => this.orchestrator.executeTask(task.id), true)),
      ...reviewCandidates.map((task) => this.runOne(task, () => this.orchestrator.checkHumanReviewFeedback(task.id), false)),
    ]);
  }

  private async runOne(task: Task, run: () => Promise<Task>, verbose: boolean): Promise<void> {
    this.inFlight.add(task.id);
    // Terminal-visible per Step 9's observability requirement (/docs/CODING_ENGINE.md
    // "Observability"): without this, a failing task was silent in the worker's own
    // terminal — only the database's TaskEvent log showed anything happened at all.
    if (verbose) console.log(`[worker] picked up task ${task.id} ("${task.title}") [status=${task.status}]`);
    try {
      const result = await run();
      if (verbose || result.updatedAt !== task.updatedAt) {
        console.log(`[worker] task ${task.id} finished with status ${result.status}`);
      }
    } catch (err) {
      this.onTaskError(task.id, err);
    } finally {
      this.inFlight.delete(task.id);
    }
  }
}
