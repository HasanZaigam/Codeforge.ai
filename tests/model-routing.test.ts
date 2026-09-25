import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, inferProviderId, UNKNOWN_CAPABILITY_PROFILE } from "../src/routing/model-registry.js";
import { selectModel } from "../src/routing/model-router.js";
import { computeCooldownMs, deriveHealthOnFailure, deriveHealthOnSuccess, isProviderAvailable, type ProviderHealthLookup } from "../src/routing/provider-health-policy.js";
import type { ModelProfile, ProviderHealth } from "../src/domain/types.js";

/**
 * V1.1 Slice 5 — pure-function unit tests for the model registry, the
 * deterministic routing policy, and the provider-health state machine.
 * Orchestrator-level integration is covered separately in
 * tests/model-routing-integration.test.ts.
 */

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    modelId: "model-a",
    providerId: "provider-a",
    displayName: "Model A",
    engineKey: "fixture",
    capability: UNKNOWN_CAPABILITY_PROFILE,
    contextWindow: null,
    credentialMode: "managed",
    enabled: true,
    ...overrides,
  };
}

class InMemoryHealth implements ProviderHealthLookup {
  private readonly byProvider = new Map<string, ProviderHealth>();
  set(health: ProviderHealth): void {
    this.byProvider.set(health.providerId, health);
  }
  get(providerId: string): ProviderHealth | null {
    return this.byProvider.get(providerId) ?? null;
  }
}

const COOLDOWN_CONFIG = { defaultCooldownMs: 60_000, maxCooldownMs: 300_000 };

// ---------------------------------------------------------------------------
// Registry / provider inference
// ---------------------------------------------------------------------------

test("inferProviderId: recognizes well-known model-name prefixes, never fabricates one it doesn't recognize", () => {
  assert.equal(inferProviderId("gemini-3-flash-preview"), "google");
  assert.equal(inferProviderId("gpt-4o"), "openai");
  assert.equal(inferProviderId("o3-mini"), "openai");
  assert.equal(inferProviderId("claude-sonnet-5"), "anthropic");
  assert.equal(inferProviderId("grok-4"), "xai");
  assert.equal(inferProviderId("some-totally-unrecognized-model-xyz"), "unknown");
});

test("inferProviderId: an operator-stated `<provider>/<model>` id (OpenCode's --model form) yields that provider, so distinct providers never share one health record", () => {
  assert.equal(inferProviderId("google/gemini-3.1-flash-lite"), "google");
  assert.equal(inferProviderId("anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(inferProviderId("OpenRouter/some-model"), "openrouter");
  assert.equal(inferProviderId("google/gemini-3.1-flash-lite"), inferProviderId("google/gemini-3-pro"), "same provider, same health record");
  assert.notEqual(inferProviderId("google/gemini-3.1-flash-lite"), inferProviderId("anthropic/claude-sonnet-5"));
  // Malformed / hostile provider segments are never trusted as a provider id.
  assert.equal(inferProviderId("/model-only"), "unknown");
  assert.equal(inferProviderId("bad provider!/x"), "unknown");
});

test("ModelRegistry: listEnabledForEngine only returns enabled profiles for the requested engine, in registration order", () => {
  const registry = new ModelRegistry();
  registry.register(profile({ modelId: "a", engineKey: "fixture" }));
  registry.register(profile({ modelId: "b", engineKey: "fixture" }));
  registry.register(profile({ modelId: "c", engineKey: "other-engine" }));
  registry.register(profile({ modelId: "d", engineKey: "fixture", enabled: false }));

  const result = registry.listEnabledForEngine("fixture").map((p) => p.modelId);
  assert.deepEqual(result, ["a", "b"]);
});

// ---------------------------------------------------------------------------
// A/O — selection: single candidate, deterministic
// ---------------------------------------------------------------------------

test("A/O: a single configured, healthy provider is selected deterministically, every time, with a 'configured default' reason", () => {
  const registry = new ModelRegistry();
  registry.register(profile({ modelId: "only-model", providerId: "only-provider" }));
  const health = new InMemoryHealth();

  for (let i = 0; i < 5; i++) {
    const selection = selectModel(registry, health, { operation: "implementation", engineKey: "fixture", fallbackIndex: 0, now: "2026-01-01T00:00:00.000Z" });
    assert.ok(selection);
    assert.equal(selection!.modelId, "only-model");
    assert.equal(selection!.providerId, "only-provider");
    assert.ok(selection!.reason.includes("configured default"));
  }
});

// ---------------------------------------------------------------------------
// H — no candidate available
// ---------------------------------------------------------------------------

test("H: no enabled candidates at all -> null, truthfully, never a fabricated selection", () => {
  const registry = new ModelRegistry();
  const health = new InMemoryHealth();
  const selection = selectModel(registry, health, { operation: "implementation", engineKey: "fixture", fallbackIndex: 0, now: "2026-01-01T00:00:00.000Z" });
  assert.equal(selection, null);
});

test("H: the only candidate is in cooldown -> null", () => {
  const registry = new ModelRegistry();
  registry.register(profile({ modelId: "m", providerId: "p" }));
  const health = new InMemoryHealth();
  health.set({ providerId: "p", state: "cooldown", consecutiveFailures: 1, lastFailureAt: "2026-01-01T00:00:00.000Z", lastFailureCategory: "network_failure", cooldownUntil: "2026-01-01T01:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const selection = selectModel(registry, health, { operation: "implementation", engineKey: "fixture", fallbackIndex: 0, now: "2026-01-01T00:30:00.000Z" });
  assert.equal(selection, null);
});

// ---------------------------------------------------------------------------
// C/D/K — fallback to the next eligible candidate; loop prevention
// ---------------------------------------------------------------------------

test("C/D: provider A in cooldown -> provider B (healthy) is selected instead", () => {
  const registry = new ModelRegistry();
  registry.register(profile({ modelId: "model-a", providerId: "provider-a" }));
  registry.register(profile({ modelId: "model-b", providerId: "provider-b" }));
  const health = new InMemoryHealth();
  health.set({ providerId: "provider-a", state: "cooldown", consecutiveFailures: 1, lastFailureAt: "t", lastFailureCategory: "provider_quota_exhausted", cooldownUntil: "2026-01-01T01:00:00.000Z", updatedAt: "t" });

  const selection = selectModel(registry, health, { operation: "implementation", engineKey: "fixture", fallbackIndex: 1, now: "2026-01-01T00:30:00.000Z" });
  assert.ok(selection);
  assert.equal(selection!.modelId, "model-b");
  assert.ok(selection!.reason.includes("fallback"));
});

test("K: both candidates unavailable -> null, never A->B->A", () => {
  const registry = new ModelRegistry();
  registry.register(profile({ modelId: "model-a", providerId: "provider-a" }));
  registry.register(profile({ modelId: "model-b", providerId: "provider-b" }));
  const health = new InMemoryHealth();
  const now = "2026-01-01T00:30:00.000Z";
  health.set({ providerId: "provider-a", state: "cooldown", consecutiveFailures: 1, lastFailureAt: now, lastFailureCategory: "network_failure", cooldownUntil: "2026-01-01T01:00:00.000Z", updatedAt: now });
  health.set({ providerId: "provider-b", state: "cooldown", consecutiveFailures: 1, lastFailureAt: now, lastFailureCategory: "network_failure", cooldownUntil: "2026-01-01T01:00:00.000Z", updatedAt: now });

  const selection = selectModel(registry, health, { operation: "implementation", engineKey: "fixture", fallbackIndex: 2, now });
  assert.equal(selection, null, "with every candidate cooling down, there is nothing left to select — not a repeated A/B loop");
});

// ---------------------------------------------------------------------------
// Provider health policy
// ---------------------------------------------------------------------------

test("a retryable infra failure with a provider-suggested retryAfterMs uses exactly that delay (capped)", () => {
  const health = deriveHealthOnFailure("p", null, "provider_quota_exhausted", 120_000, "2026-01-01T00:00:00.000Z", COOLDOWN_CONFIG);
  assert.equal(health.state, "cooldown");
  assert.equal(health.cooldownUntil, "2026-01-01T00:02:00.000Z");
});

test("a retryable infra failure with NO suggested delay uses the configured default", () => {
  const health = deriveHealthOnFailure("p", null, "network_failure", null, "2026-01-01T00:00:00.000Z", COOLDOWN_CONFIG);
  assert.equal(health.state, "cooldown");
  assert.equal(health.cooldownUntil, "2026-01-01T00:01:00.000Z"); // defaultCooldownMs = 60_000
});

test("a provider-suggested delay longer than maxCooldownMs is capped, never allowed to force an unbounded wait", () => {
  const health = deriveHealthOnFailure("p", null, "rate_limited", 10 * 60 * 60 * 1000, "2026-01-01T00:00:00.000Z", COOLDOWN_CONFIG);
  assert.equal(health.cooldownUntil, "2026-01-01T00:05:00.000Z"); // maxCooldownMs = 300_000 = 5 min
});

test("E/F: task_failure/authentication_failure/permanent_configuration_failure/unknown_failure are recorded but never cool the provider down", () => {
  for (const category of ["task_failure", "authentication_failure", "permanent_configuration_failure", "unknown_failure"] as const) {
    const health = deriveHealthOnFailure("p", null, category, null, "2026-01-01T00:00:00.000Z", COOLDOWN_CONFIG);
    assert.equal(health.state, "healthy", `${category} must not cool the provider down — it isn't evidence the PROVIDER is struggling`);
    assert.equal(health.consecutiveFailures, 1, "still honestly recorded, just not acted on");
  }
});

test("a success always clears cooldown and resets the failure streak", () => {
  const cooling = deriveHealthOnFailure("p", null, "network_failure", null, "2026-01-01T00:00:00.000Z", COOLDOWN_CONFIG);
  const recovered = deriveHealthOnSuccess("p", cooling, "2026-01-01T00:00:30.000Z");
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.cooldownUntil, null);
});

test("isProviderAvailable: true with no history, false during an active cooldown, true once cooldown has elapsed, false when disabled regardless of timing", () => {
  assert.equal(isProviderAvailable(null, "2026-01-01T00:00:00.000Z"), true);
  const cooling: ProviderHealth = { providerId: "p", state: "cooldown", consecutiveFailures: 1, lastFailureAt: "t", lastFailureCategory: "network_failure", cooldownUntil: "2026-01-01T01:00:00.000Z", updatedAt: "t" };
  assert.equal(isProviderAvailable(cooling, "2026-01-01T00:30:00.000Z"), false);
  assert.equal(isProviderAvailable(cooling, "2026-01-01T02:00:00.000Z"), true);
  const disabled: ProviderHealth = { providerId: "p", state: "disabled", consecutiveFailures: 5, lastFailureAt: "t", lastFailureCategory: "authentication_failure", cooldownUntil: null, updatedAt: "t" };
  assert.equal(isProviderAvailable(disabled, "2099-01-01T00:00:00.000Z"), false);
});

test("computeCooldownMs is deterministic and pure", () => {
  assert.equal(computeCooldownMs(30_000, COOLDOWN_CONFIG), 30_000);
  assert.equal(computeCooldownMs(null, COOLDOWN_CONFIG), COOLDOWN_CONFIG.defaultCooldownMs);
  assert.equal(computeCooldownMs(-100, COOLDOWN_CONFIG), 0);
});
