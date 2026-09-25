import type { OrchestratorFailureCategory } from "../orchestrator/failure-classifier.js";
import type { ProviderHealth } from "../domain/types.js";

/**
 * The narrow read the model router actually needs — lets `selectModel`
 * (model-router.ts) stay independent of the concrete persistence mechanism
 * (`ProviderHealthRepository`, SQLite-backed) so a test can supply a plain
 * in-memory implementation without touching a database. Implemented by
 * `ProviderHealthRepository.get` directly (same method signature).
 */
export interface ProviderHealthLookup {
  get(providerId: string): ProviderHealth | null;
}

/**
 * V1.1 Slice 5 (see this slice's brief, items 13/14/18) — the pure decision
 * logic behind `ProviderHealthRepository`'s persisted state. Deliberately
 * simple, per the brief's own instruction ("do not build a distributed
 * production-grade circuit breaker yet"): every retryable infrastructure
 * failure puts the provider into a bounded `cooldown` immediately (no
 * failure-count threshold to tune or get wrong); any real success clears it.
 * `"degraded"`/`"disabled"` are valid states this schema supports but this
 * policy never produces — see ProviderHealthState's own doc comment.
 *
 * This is the SAME mechanism that (a) keeps one execution from immediately
 * re-selecting a model whose provider just failed (item 18, "candidate loop
 * prevention" — the model router simply never offers a cooling-down
 * provider) and (b) lets a LATER task, even from a different worker
 * process, see that the provider was recently unhealthy (item 14,
 * "cross-task outage protection") — one persisted fact, two consumers,
 * rather than two separate mechanisms.
 */

/** Categories worth cooling a provider down over — see orchestrator/failure-classifier.ts. Deliberately excludes categories that either mean "stop, don't retry at all" (auth/permanent/task/unknown — cooling down teaches nothing new there) or aren't provider-specific (cancellation). */
const COOLDOWN_CATEGORIES: ReadonlySet<OrchestratorFailureCategory> = new Set([
  "timeout",
  "network_failure",
  "rate_limited",
  "provider_quota_exhausted",
  "workspace_provision_failure",
  "source_control_failure",
]);

export function isCooldownWorthy(category: OrchestratorFailureCategory): boolean {
  return COOLDOWN_CATEGORIES.has(category);
}

export interface CooldownPolicyConfig {
  /** Used when the failure carried no provider-suggested `retryAfterMs`. */
  defaultCooldownMs: number;
  /** Upper bound even when a provider suggests a longer wait — a provider must never be able to force an effectively-permanent cooldown. */
  maxCooldownMs: number;
}

/** Deterministic: same category + same suggested delay always produces the same cooldown window. */
export function computeCooldownMs(retryAfterMs: number | null, config: CooldownPolicyConfig): number {
  const base = retryAfterMs ?? config.defaultCooldownMs;
  return Math.min(Math.max(base, 0), config.maxCooldownMs);
}

/** The next persisted ProviderHealth after a real, observed infrastructure failure. Pure — no I/O, no clock reads beyond the `now`/`retryAfterMs` values the caller supplies. */
export function deriveHealthOnFailure(
  providerId: string,
  current: ProviderHealth | null,
  category: OrchestratorFailureCategory,
  retryAfterMs: number | null,
  now: string,
  config: CooldownPolicyConfig,
): ProviderHealth {
  const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;
  if (!isCooldownWorthy(category)) {
    // A real failure, but not one cooling the provider down (e.g. an auth/permanent-config error is
    // about THIS credential/request, not evidence the provider itself is struggling) — still
    // recorded (never silently dropped), but state is left exactly as it was.
    return {
      providerId,
      state: current?.state ?? "healthy",
      consecutiveFailures,
      lastFailureAt: now,
      lastFailureCategory: category,
      cooldownUntil: current?.cooldownUntil ?? null,
      updatedAt: now,
    };
  }
  const cooldownMs = computeCooldownMs(retryAfterMs, config);
  const cooldownUntil = new Date(new Date(now).getTime() + cooldownMs).toISOString();
  return {
    providerId,
    state: "cooldown",
    consecutiveFailures,
    lastFailureAt: now,
    lastFailureCategory: category,
    cooldownUntil,
    updatedAt: now,
  };
}

/** A real, observed success always clears cooldown and resets the failure streak — never partial credit. */
export function deriveHealthOnSuccess(providerId: string, current: ProviderHealth | null, now: string): ProviderHealth {
  return {
    providerId,
    state: "healthy",
    consecutiveFailures: 0,
    lastFailureAt: current?.lastFailureAt ?? null,
    lastFailureCategory: current?.lastFailureCategory ?? null,
    cooldownUntil: null,
    updatedAt: now,
  };
}

/**
 * Whether a provider is selectable right now — `disabled` is never
 * selectable regardless of timing (see ProviderHealthState's own doc
 * comment: reserved for a future/manual action, but if something ever does
 * set it, routing must still respect it); `cooldown` is only unselectable
 * while `cooldownUntil` is still in the future — a cooldown that has
 * naturally elapsed is treated as available again without requiring a
 * success to be observed first (a task that never got to retry yet
 * shouldn't be blocked forever by another task's earlier failure).
 */
export function isProviderAvailable(health: ProviderHealth | null, now: string): boolean {
  if (!health) return true; // no observed history at all — nothing says it's unavailable
  if (health.state === "disabled") return false;
  if (health.state === "cooldown") {
    return health.cooldownUntil === null || health.cooldownUntil <= now;
  }
  return true;
}
