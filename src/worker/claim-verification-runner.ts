import type { ClaimVerificationJob } from "../backlog/backlog-types.js";
import type { ClaimVerificationJobRepository } from "../persistence/repositories/claim-verification-job-repository.js";
import type { AbortReason } from "../application/backlog-analysis-executor.js";
import type { ClaimVerificationExecutor } from "../application/claim-verification-executor.js";

export interface ClaimVerificationRunnerConfig {
  ownerId: string;
  /** GLOBAL cap enforced by the database claim — verification runs a project's own commands, so the default is 1. */
  maxConcurrency: number;
  leaseMs: number;
  heartbeatMs: number;
}

export const DEFAULT_VERIFICATION_LEASE_MS = 120_000;
export const DEFAULT_VERIFICATION_HEARTBEAT_MS = 20_000;
export const DEFAULT_MAX_VERIFICATION_CONCURRENCY = 1;

interface Running { controller: AbortController; reason: AbortReason | null; promise: Promise<void> }

const now = () => new Date().toISOString();
const addMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Same shape and guarantees as BacklogAnalysisRunner; driven by the EXISTING worker loop (see CompositeRunner). */
export class ClaimVerificationRunner {
  private readonly running = new Map<string, Running>();
  private stopping = false;
  private started = 0;

  constructor(
    private readonly jobs: ClaimVerificationJobRepository,
    private readonly executor: ClaimVerificationExecutor,
    private readonly config: ClaimVerificationRunnerConfig,
  ) {}

  async tick(): Promise<void> {
    if (this.stopping) return;
    for (const orphan of this.jobs.listOrphans(now())) {
      const taken = this.jobs.takeOverOrphan(orphan.id, this.config.ownerId, now(), addMs(this.config.leaseMs));
      if (taken) this.executor.settleExhausted(taken);
    }
    while (!this.stopping && this.running.size < this.config.maxConcurrency) {
      const job = this.jobs.claimNext(this.config.ownerId, now(), addMs(this.config.leaseMs), this.config.maxConcurrency);
      if (!job) break;
      this.start(job);
    }
  }

  get inFlightCount(): number {
    return this.running.size;
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const r of this.running.values()) {
      r.reason ??= "shutdown";
      r.controller.abort();
    }
    await this.idle();
  }

  /** Test/ops helper: tick until nothing is running and a tick starts nothing more. */
  async drain(): Promise<void> {
    for (;;) {
      const before = this.started;
      const hadRunning = this.running.size > 0;
      await this.tick();
      await this.idle();
      if (this.started === before && !hadRunning) return;
    }
  }

  private start(job: ClaimVerificationJob): void {
    this.started++;
    const controller = new AbortController();
    const entry: Running = { controller, reason: null, promise: Promise.resolve() };
    const claim = { id: job.id, owner: this.config.ownerId, generation: job.lockGeneration };
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
        console.error(`[verification] heartbeat for job ${job.id} failed:`, err);
      }
    }, this.config.heartbeatMs);
    heartbeat.unref();
    entry.promise = this.executor
      .execute(job, controller.signal, () => entry.reason)
      .catch((err) => console.error(`[verification] unexpected error executing job ${job.id}:`, err))
      .finally(() => {
        clearInterval(heartbeat);
        this.running.delete(job.id);
      });
    this.running.set(job.id, entry);
  }
}
