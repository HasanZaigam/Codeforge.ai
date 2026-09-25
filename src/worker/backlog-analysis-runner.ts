import type { BacklogAnalysisJob } from "../backlog/backlog-types.js";
import type { BacklogAnalysisJobRepository } from "../persistence/repositories/backlog-analysis-job-repository.js";
import type { AbortReason, BacklogAnalysisExecutor } from "../application/backlog-analysis-executor.js";

export interface BacklogAnalysisRunnerConfig {
  /** This worker's identity on the job's `claim_owner` (the platform's `ownerId`). */
  ownerId: string;
  /**
   * The GLOBAL concurrency cap (`MAX_BACKLOG_ANALYSIS_CONCURRENCY`) — enforced by the DATABASE claim
   * across every worker process sharing it, not by counting locally. It is also this worker's own upper
   * bound (a worker never holds more than the global cap), but it is the claim, not this number, that
   * makes "three workers, cap 2" mean two live model calls in total.
   */
  maxConcurrency: number;
  leaseMs: number;
  heartbeatMs: number;
}

export const DEFAULT_ANALYSIS_LEASE_MS = 120_000;
export const DEFAULT_ANALYSIS_HEARTBEAT_MS = 30_000;
export const DEFAULT_MAX_ANALYSIS_CONCURRENCY = 2;

interface Running {
  job: BacklogAnalysisJob;
  controller: AbortController;
  reason: AbortReason | null;
  promise: Promise<void>;
}

const now = () => new Date().toISOString();
const addMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * Worker-side owner of backlog-analysis execution. It is driven by the EXISTING worker loop
 * (`Worker.tick()` calls `tick()` here) — there is no second worker system, poller or process. One
 * `tick()`: settle crash-looping orphans, then claim and START as many due jobs as the caps allow.
 * It never awaits a model call — analyses run concurrently in the background so a slow model neither
 * delays task dispatch nor is delayed by it — and `stop()` (called from `Worker.stop()`) aborts them
 * gracefully, returning each unfinished job to the queue with its attempt given back.
 *
 * Reliability mirrors task execution: atomic claim, lease + heartbeat, generation fencing, bounded
 * attempts, crash recovery (an expired lease is simply claimable again). See
 * BacklogAnalysisJobRepository and /docs/BACKLOG_INTELLIGENCE.md "Analysis worker".
 */
export class BacklogAnalysisRunner {
  private readonly running = new Map<string, Running>();
  private stopping = false;
  private started = 0;

  constructor(
    private readonly jobs: BacklogAnalysisJobRepository,
    private readonly executor: BacklogAnalysisExecutor,
    private readonly config: BacklogAnalysisRunnerConfig,
  ) {}

  /** One poll cycle. Returns as soon as jobs are started; never waits for a model. */
  async tick(): Promise<void> {
    if (this.stopping) return;

    // A job whose lease lapsed with no attempts left will not run again: settle it FAILED.
    for (const orphan of this.jobs.listOrphans(now())) {
      const taken = this.jobs.takeOverOrphan(orphan.id, this.config.ownerId, now(), addMs(this.config.leaseMs));
      if (taken) this.executor.settleExhausted(taken);
    }

    while (!this.stopping && this.running.size < this.config.maxConcurrency) {
      const job = this.jobs.claimNext(this.config.ownerId, now(), addMs(this.config.leaseMs), this.config.maxConcurrency);
      if (!job) break; // nothing due, or the GLOBAL cap is full
      this.start(job);
    }
  }

  /** Jobs this runner currently has in flight. */
  get inFlightCount(): number {
    return this.running.size;
  }

  /** Resolves once every analysis this runner started has settled. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }

  /** Graceful stop: no new claims; abort in-flight analyses (an analysis is cheap to redo) and wait for them to hand their jobs back. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const r of this.running.values()) {
      r.reason ??= "shutdown";
      r.controller.abort();
    }
    await this.idle();
  }

  /**
   * Test/ops helper: tick and wait until nothing is running AND a tick starts nothing more (a job
   * scheduled for a LATER retry is not waited for). Runs at least one more tick after anything that
   * was already in flight finishes, since finishing frees a slot for queued jobs.
   */
  async drain(): Promise<void> {
    for (;;) {
      const before = this.started;
      const hadRunning = this.running.size > 0;
      await this.tick();
      await this.idle();
      if (this.started === before && !hadRunning) return;
    }
  }

  private start(job: BacklogAnalysisJob): void {
    this.started++;
    const controller = new AbortController();
    const entry: Running = { job, controller, reason: null, promise: Promise.resolve() };
    const claim = { id: job.id, owner: this.config.ownerId, generation: job.lockGeneration };

    // Heartbeat: keep the lease alive while genuinely running, and notice both a lost claim (another
    // worker took over) and a user cancel request — the same duty task execution's heartbeat has.
    const heartbeat = setInterval(() => {
      try {
        const renewed = this.jobs.renewLease(claim, addMs(this.config.leaseMs), now());
        if (!renewed.ok) {
          entry.reason ??= "lease_lost";
          controller.abort();
        } else if (renewed.cancelRequested) {
          entry.reason ??= "cancel";
          controller.abort();
        }
      } catch (err) {
        console.error(`[backlog] heartbeat for job ${job.id} failed:`, err);
      }
    }, this.config.heartbeatMs);
    heartbeat.unref();

    entry.promise = this.executor
      .execute(job, controller.signal, () => entry.reason)
      .catch((err) => {
        // The executor handles expected failures itself. Anything landing here is a bug; the job stays
        // RUNNING until its lease lapses and is then retried — bounded by max_attempts — never lost.
        console.error(`[backlog] unexpected error executing analysis job ${job.id}:`, err);
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.running.delete(job.id);
      });
    this.running.set(job.id, entry);
  }
}
