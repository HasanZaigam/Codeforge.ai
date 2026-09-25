import type { ModelSelection, OperationClass } from "../domain/types.js";
import type { ModelRegistry } from "./model-registry.js";
import { isProviderAvailable, type ProviderHealthLookup } from "./provider-health-policy.js";

export interface SelectModelParams {
  operation: OperationClass;
  /** The CodingEngine key this project actually executes with (e.g. `Project.codingEngine`) — routing only ever considers profiles registered for this engine. */
  engineKey: string;
  /** How many DISTINCT models have already been attempted for this (task, role) — see AgentRun.fallbackIndex's own doc comment. */
  fallbackIndex: number;
  now: string;
}

/**
 * V1.1 Slice 5 — the platform's own, deterministic model-selection policy
 * (this slice's brief, item 8). NEVER the AI's choice; NEVER randomized;
 * NEVER a "score" comparison (see ModelCapabilityProfile's own doc comment
 * on why no numeric intelligence score exists to compare). Given the same
 * registry contents + the same provider health snapshot, this always
 * returns the same candidate — see this slice's brief, item O
 * ("routing determinism").
 *
 * Policy (deliberately simple — item 9 of this slice's brief explicitly
 * warns against an unreliable "complexity score"; `operation` is the only
 * routing SIGNAL this slice actually consumes, everything else falls back
 * to a configured default):
 *   1. Candidates = registry's enabled profiles for `engineKey`, in
 *      registration order.
 *   2. Filter out any whose provider is currently unavailable (cooldown/
 *      disabled — see provider-health-policy.ts).
 *   3. Return the first remaining candidate, or `null` if none remain (a
 *      truthful "no candidate available" — see this slice's brief, item H
 *      — never a fabricated selection).
 *
 * `operation` is threaded through so a FUTURE policy revision can route
 * different operations to different models without any caller needing to
 * change (this slice's brief, item 21) — today every operation shares the
 * same candidate list, since only one model is ever realistically
 * registered/enabled.
 */
export function selectModel(registry: ModelRegistry, health: ProviderHealthLookup, params: SelectModelParams): ModelSelection | null {
  const candidates = registry.listEnabledForEngine(params.engineKey);
  if (candidates.length === 0) return null;

  const unavailable: string[] = [];
  for (const candidate of candidates) {
    if (isProviderAvailable(health.get(candidate.providerId), params.now)) {
      const reason =
        params.fallbackIndex === 0 && unavailable.length === 0
          ? `configured default for ${params.operation}`
          : `fallback (attempted/unavailable: ${[...unavailable].join(", ") || "previous candidate"})`;
      return {
        modelId: candidate.modelId,
        providerId: candidate.providerId,
        engineKey: candidate.engineKey,
        operation: params.operation,
        reason,
        fallbackIndex: params.fallbackIndex,
      };
    }
    unavailable.push(`${candidate.modelId} (${candidate.providerId})`);
  }
  return null; // every enabled candidate is currently unavailable — truthful, never fabricated
}
