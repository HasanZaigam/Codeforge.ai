import type { ModelCapabilityProfile, ModelProfile } from "../domain/types.js";

/**
 * V1.1 Slice 5 — a configurable catalog of model profiles, never a hardcoded
 * business-logic switch statement in the orchestrator (see this slice's
 * brief, item 4). Registering a new model/provider is a data change here,
 * never a change to routing/orchestrator logic.
 *
 * Deliberately does NOT ship with a pre-populated catalog of well-known
 * models (Gemini Pro, GPT-*, Claude, Grok, …) — see this slice's brief,
 * item 25: "Do not add fake providers merely for demonstration" /
 * "the production code must never claim a provider is available when it is
 * not configured/executable." The only profile this codebase actually
 * constructs in production (see env-platform.ts's `buildModelRegistryFromEnv`)
 * is derived from `OPENCODE_MODEL` — the one model this environment can
 * really execute today. Registering additional real models later (a second
 * provider, BYOK, …) is exactly what this class exists to make a
 * configuration change rather than an orchestrator rewrite.
 */
export class ModelRegistry {
  private readonly profiles = new Map<string, ModelProfile>();

  register(profile: ModelProfile): void {
    this.profiles.set(profile.modelId, profile);
  }

  findById(modelId: string): ModelProfile | null {
    return this.profiles.get(modelId) ?? null;
  }

  list(): ModelProfile[] {
    return [...this.profiles.values()];
  }

  /** Enabled profiles for a given engine key, in registration order (the order routing considers them). */
  listEnabledForEngine(engineKey: string): ModelProfile[] {
    return this.list().filter((p) => p.enabled && p.engineKey === engineKey);
  }
}

/**
 * Well-known model-name PREFIXES only — never a network call, never a guess
 * beyond a pattern this codebase has actually observed in a real
 * `OPENCODE_MODEL` value (see docs/CODING_ENGINE.md's own example,
 * `gemini-3-flash-preview`, and engine-failure-classifier.ts's analogous
 * `inferProviderName`, which infers from a response URL rather than a model
 * id string — a different input, so a distinct, small function here rather
 * than reused). A model id that matches nothing returns `"unknown"` — never
 * fabricated.
 */
const PROVIDER_PREFIXES: Array<{ pattern: RegExp; providerId: string }> = [
  { pattern: /^gemini/i, providerId: "google" },
  { pattern: /^(gpt|o[0-9])/i, providerId: "openai" },
  { pattern: /^claude/i, providerId: "anthropic" },
  { pattern: /^grok/i, providerId: "xai" },
  { pattern: /^deepseek/i, providerId: "deepseek" },
  { pattern: /^llama/i, providerId: "meta" },
  { pattern: /^mistral/i, providerId: "mistral" },
];

export function inferProviderId(modelId: string): string {
  // OpenCode's own `--model` convention is `<provider>/<model>` (e.g. `google/gemini-3.1-flash-lite`,
  // the exact value docs/CODING_ENGINE.md configures). The leading segment IS the provider, stated
  // by the operator — reading it is not a guess. Without this the prefix patterns below never see
  // the model name (it comes second), every such model resolved to "unknown", and all of them would
  // have shared ONE provider-health/cooldown record. Found by the Phase 4A.1 real-provider run.
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const provider = modelId.slice(0, slash).toLowerCase();
    if (/^[a-z0-9][a-z0-9_-]*$/.test(provider)) return provider;
  }
  const match = PROVIDER_PREFIXES.find((p) => p.pattern.test(modelId));
  return match?.providerId ?? "unknown";
}

/**
 * No real, sourced capability assessment exists for an env-configured model
 * — see `CapabilityLevel`'s own doc comment: `"unknown"` is the honest
 * default across every axis, never a guessed "basic"/"strong". A future
 * slice that wants real profiles (from a maintained catalog, or the
 * provider's own published specs) can override this per model without
 * changing how routing consumes it.
 */
export const UNKNOWN_CAPABILITY_PROFILE: ModelCapabilityProfile = {
  coding: "unknown",
  reasoning: "unknown",
  latency: "unknown",
  cost: "unknown",
};
