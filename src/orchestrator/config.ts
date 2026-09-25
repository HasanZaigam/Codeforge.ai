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
  /**
   * V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028) — how many EXTRA
   * attempts at a whole WORKING episode (or human-review fix cycle) are
   * allowed after an infrastructure-classified failure (provider
   * timeout/5xx/quota, transient GitHub failure, transient workspace
   * provisioning failure — see orchestrator/failure-classifier.ts), before
   * the task is finally marked FAILED. `0` disables episode-level
   * infrastructure retry entirely (fails exactly as before this slice). A
   * retried episode always re-enters at the top of `runWorkingEpisode`,
   * which resumes from the last safe, already-idempotent boundary (a ready
   * workspace is reused, an already-pushed commit is not redone, an
   * already-opened PR is found rather than duplicated) — never a second,
   * separate resume mechanism.
   */
  maxInfrastructureRetries: number;
  /**
   * V1.1 Slice 4 — how many EXTRA attempts a single infrastructure-classified
   * check is retried IN PLACE (the declared validation runner when every
   * failing check is `outcome: "infrastructure_error"`; a Slice 3
   * bug-fix-verification contract check when its outcome is `"timed_out"` or
   * `"infrastructure_error"`) before the real (still-infrastructure) result
   * is accepted as final. Deliberately smaller/tighter than
   * `maxInfrastructureRetries`: this retries just the one check, not a whole
   * implementer pass, so it's cheap to retry a little harder before falling
   * back to existing self-fix-loop/episode-retry semantics.
   */
  maxInfraCheckRetries: number;
  /** Base delay for the bounded exponential backoff shared by both retry layers above. See coding-engine/retry-backoff.ts. */
  infrastructureRetryBaseDelayMs: number;
  /** Upper bound on any single backoff delay for both retry layers above — also caps how long a provider/GitHub-suggested Retry-After is honored inline. */
  infrastructureRetryMaxDelayMs: number;
  /**
   * V1.1 Slice 5 (see PLATFORM_GAPS.md GAP-027/028's "Still open" cross-task
   * outage note) — how long a provider stays in `cooldown` after a
   * retryable infrastructure failure with no provider-suggested
   * `retryAfterMs` of its own (see routing/provider-health-policy.ts's
   * `computeCooldownMs`). A provider's own suggested wait (e.g. a real
   * `Retry-After` header) is used instead, when it has one — this is only
   * the fallback for when it doesn't.
   */
  providerCooldownDefaultMs: number;
  /** Upper bound on any cooldown window, even one a provider's own suggested delay would otherwise set longer — a provider can never force an effectively-permanent cooldown. */
  providerCooldownMaxMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxSelfFixAttempts: 3,
  maxReviewerRejections: 2,
  agentInvocationTimeoutMs: 10 * 60 * 1000,
  taskLeaseMs: 5 * 60 * 1000,
  cancellationPollIntervalMs: 300,
  leaseHeartbeatIntervalMs: 60 * 1000,
  reviewPollIntervalMs: 30 * 1000,
  maxInfrastructureRetries: 2,
  maxInfraCheckRetries: 2,
  infrastructureRetryBaseDelayMs: 2000,
  infrastructureRetryMaxDelayMs: 30_000,
  providerCooldownDefaultMs: 5 * 60 * 1000,
  providerCooldownMaxMs: 30 * 60 * 1000,
};
