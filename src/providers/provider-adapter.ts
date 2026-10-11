import type { AiProviderId } from "../persistence/repositories/provider-connection-repository.js";

export interface ProviderValidationResult {
  valid: boolean;
  /** Human-readable, never secret-bearing (no key fragment, no raw provider response body). `null` on success. */
  error: string | null;
}

export interface ProviderModelListResult {
  models: string[];
  /** Non-null only when the key itself was rejected or the call failed — a real failure, never fabricated. */
  error: string | null;
}

/**
 * Model Gateway — one per supported AI provider (Google/Anthropic/OpenAI). Deliberately narrow: the
 * actual coding-engine/chat EXECUTION already happens through the existing, unchanged
 * `CodingEngine`/OpenCode boundary (OpenCode is already provider-agnostic via its own `<provider>/
 * <model>` convention — see routing/model-registry.ts's `inferProviderId`), so this adapter's only
 * job is to make a REAL network call to confirm a user-supplied API key + model actually work before
 * CodeForge stores/trusts them — never a fabricated "connected" status.
 */
export interface ProviderAdapter {
  readonly id: AiProviderId;
  validateCredentials(apiKey: string, model: string): Promise<ProviderValidationResult>;
  /**
   * Real, on-demand list of the models this key's account can actually use — lets the Settings UI
   * offer a dropdown instead of asking someone to remember/type an exact model id. NEVER a hardcoded
   * catalog (this feature's own non-negotiable rule: "Do not hardcode a giant model catalogue") —
   * every id returned here came from the provider's own API, for THIS key, just now.
   */
  listModels(apiKey: string): Promise<ProviderModelListResult>;
  /** The environment variable OpenCode/LiteLLM expects for this provider — see docs/CODING_ENGINE.md's
   *  own list of passthrough-allowed provider API key env vars. Used by ModelGatewayService to build
   *  the per-invocation `credentialEnv` an engine adapter merges into its child process environment. */
  readonly envVar: string;
}

function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? `Could not reach the provider: ${err.message}` : "Could not reach the provider.";
}

/**
 * One retry for a genuine NETWORK-level failure only (DNS/connection reset/"fetch failed") — never
 * for an HTTP error response, which `fetch` resolves rather than throws. Real providers occasionally
 * drop a single connection attempt; a bare "fetch failed" on the very first real network call this
 * process makes to a given host is a known, transient Node/undici flake (see src/api/server.ts's
 * `setDefaultResultOrder("ipv4first")`, the primary fix) — this retry is a cheap second layer of
 * resilience on top of that, not a substitute for it.
 */
async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    try {
      return await fetch(url, init);
    } catch {
      throw err; // report the original failure, not the retry's
    }
  }
}

/** Real call to Google's "list models" endpoint — confirms the key is valid and, if possible, that the configured model exists. */
export class GoogleProviderAdapter implements ProviderAdapter {
  readonly id = "google" as const;
  readonly envVar = "GEMINI_API_KEY";

  private async fetchModelIds(apiKey: string): Promise<{ ids: string[]; error: string | null }> {
    let res: Response;
    try {
      // The `X-goog-api-key` header is Google's current, documented auth mechanism for this API —
      // the older `?key=` query-string form was found NOT to work for a real, currently-issued key
      // (confirmed live: the exact same key that authenticates via this header was rejected with
      // API_KEY_INVALID via `?key=`), so this is the only form used, for every key.
      res = await fetchWithRetry("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "X-goog-api-key": apiKey } });
    } catch (err) {
      return { ids: [], error: networkErrorMessage(err) };
    }
    if (res.status === 401 || res.status === 403) return { ids: [], error: "This API key was rejected by Google — check it's correct and has the Generative Language API enabled." };
    if (!res.ok) {
      // Google returns 400 (not 401/403) for an invalid/malformed key — HTTP 400 alone isn't "an
      // unexpected error," it's the most common real rejection shape, so it's worth reading the
      // body's own reason before falling back to a generic message.
      const errBody = (await res.json().catch(() => null)) as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } } | null;
      const reason = errBody?.error?.details?.find((d) => d.reason)?.reason;
      if (res.status === 400 && (reason === "API_KEY_INVALID" || errBody?.error?.status === "INVALID_ARGUMENT")) {
        return { ids: [], error: "This API key was rejected by Google — it's not a valid Generative Language API key. Create one at aistudio.google.com/apikey and make sure you copied it in full." };
      }
      return { ids: [], error: errBody?.error?.message ? `Google rejected this request: ${errBody.error.message}` : `Google returned an unexpected error (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => null)) as { models?: Array<{ name?: string }> } | null;
    const ids = (body?.models ?? []).map((m) => m.name?.replace(/^models\//, "") ?? "").filter(Boolean);
    return { ids, error: null };
  }

  async validateCredentials(apiKey: string, model: string): Promise<ProviderValidationResult> {
    const { ids, error } = await this.fetchModelIds(apiKey);
    if (error) return { valid: false, error };
    if (ids.length > 0 && !ids.some((n) => n === model || n.endsWith(`/${model}`))) {
      return { valid: false, error: `The key is valid, but "${model}" wasn't found in this account's available models.` };
    }
    return { valid: true, error: null };
  }

  async listModels(apiKey: string): Promise<ProviderModelListResult> {
    const { ids, error } = await this.fetchModelIds(apiKey);
    return { models: ids.sort(), error };
  }
}

/** Real call to Anthropic's models endpoint — confirms the key is valid and, if possible, that the configured model exists. Never spends a completion/generation token to validate. */
export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  readonly envVar = "ANTHROPIC_API_KEY";

  private async fetchModelIds(apiKey: string): Promise<{ ids: string[]; error: string | null }> {
    let res: Response;
    try {
      res = await fetchWithRetry("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
    } catch (err) {
      return { ids: [], error: networkErrorMessage(err) };
    }
    if (res.status === 401) return { ids: [], error: "This API key was rejected by Anthropic — check it's correct and active." };
    if (!res.ok) return { ids: [], error: `Anthropic returned an unexpected error (HTTP ${res.status}).` };
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
    const ids = (body?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return { ids, error: null };
  }

  async validateCredentials(apiKey: string, model: string): Promise<ProviderValidationResult> {
    const { ids, error } = await this.fetchModelIds(apiKey);
    if (error) return { valid: false, error };
    if (ids.length > 0 && !ids.includes(model)) {
      return { valid: false, error: `The key is valid, but "${model}" wasn't found in this account's available models.` };
    }
    return { valid: true, error: null };
  }

  async listModels(apiKey: string): Promise<ProviderModelListResult> {
    const { ids, error } = await this.fetchModelIds(apiKey);
    return { models: ids.sort(), error };
  }
}

/** Real call to OpenAI's models endpoint — confirms the key is valid and, if possible, that the configured model exists. */
export class OpenAiProviderAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  readonly envVar = "OPENAI_API_KEY";

  private async fetchModelIds(apiKey: string): Promise<{ ids: string[]; error: string | null }> {
    let res: Response;
    try {
      res = await fetchWithRetry("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      return { ids: [], error: networkErrorMessage(err) };
    }
    if (res.status === 401) return { ids: [], error: "This API key was rejected by OpenAI — check it's correct and active." };
    if (!res.ok) return { ids: [], error: `OpenAI returned an unexpected error (HTTP ${res.status}).` };
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
    const ids = (body?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return { ids, error: null };
  }

  async validateCredentials(apiKey: string, model: string): Promise<ProviderValidationResult> {
    const { ids, error } = await this.fetchModelIds(apiKey);
    if (error) return { valid: false, error };
    if (ids.length > 0 && !ids.includes(model)) {
      return { valid: false, error: `The key is valid, but "${model}" wasn't found in this account's available models.` };
    }
    return { valid: true, error: null };
  }

  async listModels(apiKey: string): Promise<ProviderModelListResult> {
    const { ids, error } = await this.fetchModelIds(apiKey);
    return { models: ids.sort(), error };
  }
}

export function buildDefaultProviderAdapters(): Record<AiProviderId, ProviderAdapter> {
  return { google: new GoogleProviderAdapter(), anthropic: new AnthropicProviderAdapter(), openai: new OpenAiProviderAdapter() };
}
