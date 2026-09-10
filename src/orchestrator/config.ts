/**
 * Self-fix loop and execution-lease limits. Configurable per deployment
 * (and, in the future, per project) — never hardcoded inline in the
 * Orchestrator. See /docs/AGENT_ARCHITECTURE.md "Self-fix loop".
 */
export interface OrchestratorConfig {
  /** Max implement->validate iterations within one WORKING episode before escalating to NEEDS_INPUT. */
  maxSelfFixAttempts: number;
  /** Max times the Reviewer may reject before escalating to NEEDS_INPUT instead of looping back to the Implementer. */
  maxReviewerRejections: number;
  /** Wall-clock budget for a single Implementer or Reviewer invocation. */
  agentInvocationTimeoutMs: number;
  /** How long a worker's claim on a task is valid before another worker may reclaim it (crash recovery). */
  taskLeaseMs: number;
  /**
   * How often a live execution's cancellation watcher checks the persisted
   * cancellation intent (see Orchestrator.withCancellation). Bounds how
   * quickly a cancellation actually interrupts a running step — small
   * enough to feel immediate, cheap enough to poll constantly (one indexed
   * single-column SQLite read). See /docs/TASK_LIFECYCLE.md "Cancellation".
   */
  cancellationPollIntervalMs: number;
  /**
   * How often a live execution renews its own claim lease (see
   * TaskRepository.claimWorking) while it's genuinely still running — not
   * a recovery mechanism itself, but what keeps `recoverOrphanedTasks` from
   * mistaking a slow-but-alive episode for a crashed one. Must stay well
   * below `taskLeaseMs`: an episode with multiple self-fix/review cycles
   * can legitimately run for several multiples of `agentInvocationTimeoutMs`,
   * easily exceeding `taskLeaseMs` on its own. See
   * /docs/TASK_LIFECYCLE.md "Crash recovery".
   */
  leaseHeartbeatIntervalMs: number;
  /**
   * The normal cadence (ms) between real GitHub refreshes of a single REVIEW
   * task's PR — see /docs/TASK_LIFECYCLE.md "REVIEW polling",
   * migrations/010_review_poll_scheduling.sql, and Worker.tick (which is
   * what actually claims/schedules against this cadence via
   * TaskRepository.claimReviewCheck; this Orchestrator-side copy is used
   * only to decide, inside checkHumanReviewFeedback's rate-limit handling,
   * whether GitHub's own suggested wait is already longer than the normal
   * cadence and the schedule needs pushing out further). Distinct from
   * `POLL_INTERVAL_MS`/Worker's own `pollIntervalMs`, which governs how
   * often the worker tick runs at all, not how often a GitHub call within it
   * is allowed. Configurable via `REVIEW_POLL_INTERVAL_MS`.
   */
  reviewPollIntervalMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxSelfFixAttempts: 3,
  maxReviewerRejections: 2,
  agentInvocationTimeoutMs: 10 * 60 * 1000,
  taskLeaseMs: 5 * 60 * 1000,
  cancellationPollIntervalMs: 300,
  leaseHeartbeatIntervalMs: 60 * 1000,
  reviewPollIntervalMs: 30 * 1000,
};
