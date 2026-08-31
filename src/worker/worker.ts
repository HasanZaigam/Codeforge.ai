import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";

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

    const candidates = [...this.tasks.listByStatus("TODO"), ...this.tasks.listByStatus("WORKING")].filter(
      (task) => !this.inFlight.has(task.id),
    );

    await Promise.allSettled(
      candidates.map(async (task) => {
        this.inFlight.add(task.id);
        try {
          await this.orchestrator.executeTask(task.id);
        } catch (err) {
          this.onTaskError(task.id, err);
        } finally {
          this.inFlight.delete(task.id);
        }
      }),
    );
  }
}
