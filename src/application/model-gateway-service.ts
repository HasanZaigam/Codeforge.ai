import { randomUUID } from "node:crypto";
import type { OperationClass, ModelSelection, ModelCapabilityProfile } from "../domain/types.js";
import { ModelRegistry } from "../routing/model-registry.js";
import { selectModel } from "../routing/model-router.js";
import type { ProviderHealthRepository } from "../persistence/repositories/provider-health-repository.js";
import { AI_PROVIDER_IDS, type AiProviderId, type ProviderConnectionRecord, type ProviderConnectionRepository } from "../persistence/repositories/provider-connection-repository.js";
import { GlobalAiConfigRepository, type GlobalAiConfigRecord, type GlobalAiMode } from "../persistence/repositories/global-ai-config-repository.js";
import type { AgentRunRepository } from "../persistence/repositories/agent-run-repository.js";
import { buildProviderUsageRollup, type ProviderUsageTotals } from "../reporting/provider-usage-rollup.js";
import { encryptSecret, decryptSecret } from "../auth/credential-encryption.js";
import type { ProviderAdapter } from "../providers/provider-adapter.js";
import { buildDefaultProviderAdapters } from "../providers/provider-adapter.js";
import { InvalidRequestError, NotFoundError, ModelGatewayResolutionError } from "./errors.js";

const UNKNOWN_CAPABILITY: ModelCapabilityProfile = { coding: "unknown", reasoning: "unknown", latency: "unknown", cost: "unknown" };

export interface ProviderConnectionDTO {
  provider: AiProviderId;
  connected: boolean;
  model: string | null;
  status: "connected" | "disconnected" | "error";
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface GlobalAiConfigDTO {
  mode: GlobalAiMode;
  fixedProvider: AiProviderId | null;
  fixedModel: string | null;
  /** Every CONNECTED provider this account could use right now, each flagged with whether Auto is currently allowed to pick it. */
  autoAllowed: Array<{ provider: AiProviderId; allowed: boolean; connected: boolean }>;
}

function labelProvider(p: AiProviderId): string {
  return p === "google" ? "Google" : p === "anthropic" ? "Anthropic" : "OpenAI";
}

function toDTO(record: ProviderConnectionRecord | null, provider: AiProviderId): ProviderConnectionDTO {
  if (!record) return { provider, connected: false, model: null, status: "disconnected", lastVerifiedAt: null, lastError: null };
  return { provider, connected: record.status === "connected", model: record.model, status: record.status, lastVerifiedAt: record.lastVerifiedAt, lastError: record.lastError };
}

/**
 * Model Gateway (see docs/MODEL_GATEWAY.md) — the ONE place CodeForge resolves which AI
 * provider/model/credential an execution actually uses. Every AI entry point (Chat via
 * BacklogAnalyzer, task execution via the Orchestrator) must resolve through
 * `resolveModelSelection` rather than building its own `ModelSelection` — see this service's own
 * callers for the exact wiring.
 *
 * Deliberately reuses, never duplicates: `ModelRegistry`/`selectModel` (routing/model-router.ts,
 * unchanged — this service only builds a DIFFERENT registry per call, from the account's own
 * connections, instead of the one static env-derived registry), `ProviderHealthRepository`
 * (provider cooldown state stays global/per-providerId, same simplification the pre-existing
 * routing already made), and `auth/credential-encryption.ts` (the exact AES-256-GCM utility GitHub
 * tokens already use — no second crypto implementation).
 */
export class ModelGatewayService {
  private readonly adapters: Record<AiProviderId, ProviderAdapter>;

  constructor(
    private readonly connections: ProviderConnectionRepository,
    private readonly configs: GlobalAiConfigRepository,
    private readonly providerHealth: ProviderHealthRepository,
    private readonly agentRuns: AgentRunRepository,
    private readonly encryptionKey: () => Buffer,
    adapters?: Partial<Record<AiProviderId, ProviderAdapter>>,
  ) {
    this.adapters = { ...buildDefaultProviderAdapters(), ...adapters };
  }

  // ---------------------------------------------------------------------
  // Provider connections
  // ---------------------------------------------------------------------

  listConnections(userId: string): ProviderConnectionDTO[] {
    const byProvider = new Map(this.connections.listByUser(userId).map((c) => [c.provider, c]));
    return AI_PROVIDER_IDS.map((p) => toDTO(byProvider.get(p) ?? null, p));
  }

  /**
   * A REAL, on-demand list of the models this key's account can actually use — so the Settings UI can
   * offer a dropdown instead of asking someone to remember/type an exact model id. Never persists
   * anything (the user hasn't necessarily decided to connect yet); never a hardcoded catalog — every
   * id came from the provider's own API, for THIS key, just now.
   */
  async listAvailableModels(provider: AiProviderId, apiKey: string): Promise<{ models: string[]; error: string | null }> {
    return this.adapters[provider].listModels(apiKey);
  }

  /** Validates the key/model with a REAL call to the provider before storing anything — never trusts a client-supplied key blindly (same posture as GitHubIntegrationService.connect). Throws InvalidRequestError (never persists) if validation fails. */
  async connectProvider(userId: string, provider: AiProviderId, apiKey: string, model: string): Promise<ProviderConnectionDTO> {
    const adapter = this.adapters[provider];
    const result = await adapter.validateCredentials(apiKey, model);
    if (!result.valid) throw new InvalidRequestError(result.error ?? `${labelProvider(provider)} rejected this key/model.`);

    const now = new Date().toISOString();
    const existing = this.connections.findByUserAndProvider(userId, provider);
    const secret = encryptSecret(apiKey, this.encryptionKey());
    this.connections.upsert({
      id: existing?.id ?? randomUUID(),
      userId,
      provider,
      model,
      secret,
      status: "connected",
      lastVerifiedAt: now,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return toDTO(this.connections.findByUserAndProvider(userId, provider), provider);
  }

  /** Re-validates an EXISTING stored connection with a real, on-demand provider call (the stored "connected" status alone can't notice a key revoked entirely on the provider's own side) — same posture as GitHubIntegrationService.verifyConnection. Updates status/lastVerifiedAt/lastError either way. */
  async testConnection(userId: string, provider: AiProviderId): Promise<{ valid: boolean; error: string | null }> {
    const record = this.connections.findByUserAndProvider(userId, provider);
    if (!record) throw new NotFoundError("ProviderConnection", provider);
    const apiKey = decryptSecret(record.secret, this.encryptionKey());
    const result = await this.adapters[provider].validateCredentials(apiKey, record.model);
    const now = new Date().toISOString();
    this.connections.upsert({ ...record, status: result.valid ? "connected" : "error", lastVerifiedAt: now, lastError: result.error, updatedAt: now });
    return result;
  }

  disconnectProvider(userId: string, provider: AiProviderId): void {
    this.connections.deleteByUserAndProvider(userId, provider);
    // A Fixed selection pointing at a provider that was just disconnected must never keep silently
    // "working" off a stale in-memory assumption — resolveModelSelection always re-reads connections
    // fresh, so this alone is enough; no cascading config edit is needed here.
  }

  // ---------------------------------------------------------------------
  // Global AI Brain configuration
  // ---------------------------------------------------------------------

  getGlobalConfig(userId: string): GlobalAiConfigDTO {
    const config = this.configs.getByUser(userId);
    const connected = new Set(this.connections.listByUser(userId).filter((c) => c.status === "connected").map((c) => c.provider));
    const allowedSet = config?.autoAllowedProviders ? new Set(config.autoAllowedProviders) : connected;
    return {
      mode: config?.mode ?? "auto",
      fixedProvider: config?.fixedProvider ?? null,
      fixedModel: config?.fixedModel ?? null,
      autoAllowed: AI_PROVIDER_IDS.map((p) => ({ provider: p, connected: connected.has(p), allowed: allowedSet.has(p) })),
    };
  }

  setGlobalConfig(userId: string, input: { mode: GlobalAiMode; fixedProvider?: AiProviderId | null; fixedModel?: string | null; autoAllowedProviders?: AiProviderId[] }): GlobalAiConfigDTO {
    const connections = this.connections.listByUser(userId);
    const connectedByProvider = new Map(connections.filter((c) => c.status === "connected").map((c) => [c.provider, c]));

    if (input.mode === "fixed") {
      const provider = input.fixedProvider;
      if (!provider) throw new InvalidRequestError("A fixed global AI brain needs a provider.");
      const connection = connectedByProvider.get(provider);
      if (!connection) throw new InvalidRequestError(`${labelProvider(provider)} isn't connected yet — connect it before setting it as the global AI brain.`);
      const model = input.fixedModel ?? connection.model;
      this.configs.upsert({ userId, mode: "fixed", fixedProvider: provider, fixedModel: model, autoAllowedProviders: null, updatedAt: new Date().toISOString() });
    } else {
      const allowed = input.autoAllowedProviders ?? [...connectedByProvider.keys()];
      const unconnected = allowed.filter((p) => !connectedByProvider.has(p));
      if (unconnected.length > 0) throw new InvalidRequestError(`${unconnected.map(labelProvider).join(", ")} isn't connected — Auto can only use connected providers.`);
      this.configs.upsert({ userId, mode: "auto", fixedProvider: null, fixedModel: null, autoAllowedProviders: allowed, updatedAt: new Date().toISOString() });
    }
    return this.getGlobalConfig(userId);
  }

  // ---------------------------------------------------------------------
  // Usage
  // ---------------------------------------------------------------------

  getUsageSummary(userId: string): ProviderUsageTotals[] {
    return buildProviderUsageRollup(this.agentRuns.listUsageForOwner(userId));
  }

  // ---------------------------------------------------------------------
  // Resolution — the actual gateway every AI execution goes through
  // ---------------------------------------------------------------------

  /**
   * Resolves ONE invocation's model/provider + the decrypted credential environment an engine
   * adapter should see. `legacyRegistry` is the platform's existing, static env-derived
   * `ModelRegistry` (see env-platform.ts's `buildModelRegistryFromEnv`) — the backward-compatible
   * bridge: an account with ZERO provider connections behaves EXACTLY as before this feature
   * existed (Backward Compatibility, this feature's own non-negotiable rule).
   *
   * Throws `ModelGatewayResolutionError` ONLY for the one case that must never silently fall back:
   * Fixed mode naming a provider that isn't currently connected. Every other "nothing available"
   * case (Auto with no allowed/connected providers, or every candidate in cooldown) returns
   * `{selection: null}` — the SAME truthful "no candidate" the pre-existing `selectModel` already
   * returns, which every caller (Orchestrator, BacklogAnalyzer) already handles as "fall back to
   * the engine's own default," not a hard failure — introducing a NEW hard-failure case here would
   * be a behavior change this feature was never asked to make.
   */
  resolveModelSelection(
    ownerId: string,
    engineKey: string,
    operation: OperationClass,
    fallbackIndex: number,
    now: string,
    legacyRegistry: ModelRegistry | null,
  ): { selection: ModelSelection | null; credentialEnv: Record<string, string> | null; hadCandidates: boolean } {
    const connections = this.connections.listByUser(ownerId);
    const connected = connections.filter((c) => c.status === "connected");

    if (connected.length === 0) {
      // Backward-compat bridge — see this method's own doc comment.
      const hadLegacyCandidates = legacyRegistry ? legacyRegistry.listEnabledForEngine(engineKey).length > 0 : false;
      const selection = legacyRegistry ? selectModel(legacyRegistry, this.providerHealth, { operation, engineKey, fallbackIndex, now }) : null;
      return { selection, credentialEnv: null, hadCandidates: hadLegacyCandidates };
    }

    const config = this.configs.getByUser(ownerId);
    const mode: GlobalAiMode = config?.mode ?? "auto";

    const candidateConnections =
      mode === "fixed"
        ? (() => {
            const provider = config!.fixedProvider;
            const match = provider ? connected.find((c) => c.provider === provider) : undefined;
            if (!match) {
              throw new ModelGatewayResolutionError(
                `${provider ? labelProvider(provider) : "The configured provider"} is selected as the global AI brain, but its connection is unavailable. ` +
                  `Fix the connection or switch the global AI brain to Auto/another configured provider.`,
              );
            }
            return [match];
          })()
        : connected.filter((c) => (config?.autoAllowedProviders ?? connected.map((x) => x.provider)).includes(c.provider));

    if (candidateConnections.length === 0) return { selection: null, credentialEnv: null, hadCandidates: false };

    const registry = new ModelRegistry();
    for (const c of candidateConnections) {
      registry.register({ modelId: `${c.provider}/${c.model}`, providerId: c.provider, displayName: `${c.provider}/${c.model}`, engineKey, capability: UNKNOWN_CAPABILITY, contextWindow: null, credentialMode: "byok", enabled: true });
    }

    const selection = selectModel(registry, this.providerHealth, { operation, engineKey, fallbackIndex, now });
    if (!selection) return { selection: null, credentialEnv: null, hadCandidates: true };

    const matched = candidateConnections.find((c) => c.provider === selection.providerId);
    const credentialEnv = matched ? { [this.adapters[matched.provider].envVar]: decryptSecret(matched.secret, this.encryptionKey()) } : null;
    return { selection, credentialEnv, hadCandidates: true };
  }
}
