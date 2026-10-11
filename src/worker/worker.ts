import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Task } from "../domain/types.js";

export interface WorkerConfig {
  pollIntervalMs: number;
  /**
   * Upper bound on how many TODO/WORKING task executions this worker process will have in flight
   * at once (see WORKER_MAX_CONCURRENT_TASKS in .env.example and /docs/DEPLOYMENT.md). Deliberately
   * NOT a queue and does not introduce a BLOCKED task status — a TODO task beyond capacity simply
   * stays TODO and is reconsidered on the next tick, exactly like it always was when no worker had
   * capacity yet. Does not bound the separate REVIEW/human-review-feedback polling path (see
   * `tick()` below) — that path is cheap (a no-op unless a task's PR actually has new feedback) and
   * was never part of the concurrency risk this limit exists to bound.
   */
  maxConcurrentTasks: number;
  /**
   * Normal cadence (ms) between real GitHub refreshes of a single REVIEW task's PR — see
   * REVIEW_POLL_INTERVAL_MS in .env.example, /docs/TASK_LIFECYCLE.md "REVIEW polling", and
   * migrations/010_review_poll_scheduling.sql. Deliberately separate from `pollIntervalMs`: that
   * still governs how often `tick()` itself runs at all (checking for due TODO/WORKING/REVIEW
   * work); this governs how often, once a REVIEW task is looked at, a real GitHub call is allowed
   * to happen for it. Every tick still lists every REVIEW task cheaply (one indexed SQL query) —
   * only the atomic per-task claim in `tick()` below decides whether this cycle's task is actually
   * due, and only a due task ever reaches Orchestrator.checkHumanReviewFeedback (and therefore
   * GitHub) at all.
   */
  reviewPollIntervalMs: number;
}

/**
 * Background work the worker drives alongside task execution, sharing its poll loop and its graceful
 * stop — see BacklogAnalysisRunner. `tick()` must return promptly (it starts work, it does not wait
 * for it); `stop()` must abort in-flight work and hand it back cleanly.
 */
export interface BackgroundRunner {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = { pollIntervalMs: 2000, maxConcurrentTasks: 2, reviewPollIntervalMs: 30_000 };

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
  /**
   * Subset of `inFlight` specifically tracking TODO/WORKING executions (Orchestrator.executeTask)
   * — what WORKER_MAX_CONCURRENT_TASKS actually bounds. Kept separate from `inFlight` itself (which
   * also covers the REVIEW/human-review-feedback polling path, purely for same-tick de-dup) so the
   * capacity calculation in `tick()` below only ever counts real task executions, never the cheap
   * REVIEW poll — see WorkerConfig.maxConcurrentTasks's own doc comment.
   */
  private readonly executingTaskIds = new Set<string>();
  private currentTick: Promise<void> = Promise.resolve();

  private readonly config: WorkerConfig;

  constructor(
    private readonly tasks: TaskRepository,
    private readonly orchestrator: Orchestrator,
    // Partial, merged with DEFAULT_WORKER_CONFIG below: existing call sites (tests, mainly) that
    // only cared about pollIntervalMs before maxConcurrentTasks existed keep compiling and get the
    // safe default (2) rather than being forced to spell it out everywhere.
    config: Partial<WorkerConfig> = {},
    private readonly onTaskError: (taskId: string, error: unknown) => void = () => {},
    /**
     * Phase 4A.1 — backlog analysis. Optional so every existing call site is unchanged. It rides THIS
     * worker's loop and shutdown (no second worker system) but is independent of task execution: a
     * failure in it never prevents task dispatch, and it is bounded by its own global cap
     * (MAX_BACKLOG_ANALYSIS_CONCURRENCY), not by WORKER_MAX_CONCURRENT_TASKS.
     */
    private readonly backlogRunner: BackgroundRunner | null = null,
  ) {
    this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
  }

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
    // After the task tick has drained: abort in-flight analyses and return their jobs to the queue.
    await this.backlogRunner?.stop();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentTick = this.tick().finally(() => this.scheduleNext());
    }, this.config.pollIntervalMs);
  }

  /** Runs one poll cycle immediately; exposed directly for deterministic tests instead of waiting on the interval. */
  async tick(): Promise<void> {
    // Backlog analysis: claim due jobs and START them (returns immediately). Isolated in its own
    // try/catch — an analysis-side problem must never stop task dispatch below.
    try {
      await this.backlogRunner?.tick();
    } catch (err) {
      console.error("[worker] backlog analysis tick failed:", err instanceof Error ? err.message : String(err));
    }

    this.orchestrator.recoverOrphanedTasks();

    const workCandidates = [...this.tasks.listByStatus("TODO"), ...this.tasks.listByStatus("WORKING")].filter(
      (task) => !this.inFlight.has(task.id),
    );
    // REVIEW tasks are polled too, but quietly (see runOne's `verbose` flag below) — a task can sit
    // in REVIEW for a long time with nothing to report on most ticks; only checkHumanReviewFeedback
    // (a no-op unless the task's PR has new, unprocessed human feedback) runs against them. See
    // /docs/TASK_LIFECYCLE.md "Human review feedback loop". Deliberately NOT subject to
    // WORKER_MAX_CONCURRENT_TASKS — see WorkerConfig.maxConcurrentTasks's own doc comment.
    const reviewCandidates = this.tasks.listByStatus("REVIEW").filter((task) => !this.inFlight.has(task.id));

    // REVIEW polling hardening (see /docs/TASK_LIFECYCLE.md "REVIEW polling" and
    // migrations/010_review_poll_scheduling.sql): every REVIEW task is listed above on EVERY tick
    // (one cheap, indexed SQL query — that part is unchanged and stays inexpensive at any worker
    // count), but only a task whose `next_review_check_at` is actually due gets a real GitHub call.
    // `claimReviewCheck` is a single atomic UPDATE...WHERE guard (mirroring claimTodo/claimWorking's
    // own idiom): it both checks "is this due?" and claims the cycle by advancing the schedule, in
    // one statement, so two overlapping ticks (this process or another worker process entirely,
    // sharing the same DB) can never both win the same due task. A task that loses the claim (not
    // due yet, or another process/tick already claimed it) is filtered out here and never reaches
    // Orchestrator.checkHumanReviewFeedback at all this cycle — so it makes zero GitHub calls, not
    // just "cheap" ones. This is what actually bounds GitHub call volume to roughly
    // `reviewPollIntervalMs` per REVIEW task, regardless of how many worker processes are running or
    // how short `pollIntervalMs` is.
    const reviewCheckNow = new Date().toISOString();
    const reviewCheckNextDue = new Date(Date.now() + this.config.reviewPollIntervalMs).toISOString();
    const dueReviewCandidates = reviewCandidates.filter((task) =>
      this.tasks.claimReviewCheck(task.id, reviewCheckNow, reviewCheckNextDue),
    );

    // Bounded concurrency (see WorkerConfig.maxConcurrentTasks): only dispatch as many NEW
    // executions as remaining capacity allows. No queue, no BLOCKED status — a TODO/WORKING task
    // beyond capacity is simply left untouched and reconsidered on the next tick, exactly as it
    // would be if this worker just hadn't gotten to it yet.
    const capacity = Math.max(0, this.config.maxConcurrentTasks - this.executingTaskIds.size);
    const dispatchable = workCandidates.slice(0, capacity);

    await Promise.allSettled([
      ...dispatchable.map((task) => this.runOne(task, () => this.orchestrator.executeTask(task.id), true, this.executingTaskIds)),
      ...dueReviewCandidates.map((task) => this.runOne(task, () => this.orchestrator.checkHumanReviewFeedback(task.id), false)),
    ]);
  }

  private async runOne(task: Task, run: () => Promise<Task>, verbose: boolean, capacitySet?: Set<string>): Promise<void> {
    this.inFlight.add(task.id);
    capacitySet?.add(task.id);
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
      capacitySet?.delete(task.id);
    }
  }
}

/** Composes several background runners behind the Worker's single `BackgroundRunner` slot — one worker loop, one shutdown. A failing runner never blocks the others. */
export class CompositeRunner implements BackgroundRunner {
  constructor(private readonly runners: BackgroundRunner[]) {}

  async tick(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.tick().catch((err) => console.error("[worker] background runner tick failed:", err instanceof Error ? err.message : String(err)))));
  }

  async stop(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.stop()));
  }
}
