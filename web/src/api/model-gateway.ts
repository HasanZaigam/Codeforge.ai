import { apiClient } from "./client.js";
import type { AccountTokenUsageDTO, GlobalAiConfigDTO, ProviderConnectionDTO, ProviderUsageTotalsDTO, AiProviderId } from "./types.js";

/** Settings -> AI / Models (see /docs/MODEL_GATEWAY.md). The provider API key is write-only — never returned. */
export const modelGatewayApi = {
  listConnections: () => apiClient.get<{ connections: ProviderConnectionDTO[] }>("/settings/ai-gateway/connections"),
  /** A real, on-demand "list models" call for this key — never persisted. Lets the Connect dialog offer a dropdown instead of a free-typed model id. */
  listModels: (provider: AiProviderId, apiKey: string) => apiClient.post<{ models: string[]; error: string | null }>(`/settings/ai-gateway/providers/${provider}/models`, { apiKey }),
  connect: (provider: AiProviderId, apiKey: string, model: string) =>
    apiClient.post<ProviderConnectionDTO>(`/settings/ai-gateway/connections/${provider}`, { apiKey, model }),
  /** Same live model list, fetched server-side with the connection's STORED key — the key is never re-sent. */
  listConnectionModels: (provider: AiProviderId) =>
    apiClient.get<{ models: string[]; error: string | null }>(`/settings/ai-gateway/connections/${provider}/models`),
  /** Switch an existing connection to another model; the server validates it with the stored key first. */
  changeModel: (provider: AiProviderId, model: string) =>
    apiClient.patch<ProviderConnectionDTO>(`/settings/ai-gateway/connections/${provider}`, { model }),
  /** A real, on-demand provider API call — unlike the stored `status`, which can't notice a key revoked entirely on the provider's own side. */
  testConnection: (provider: AiProviderId) => apiClient.post<{ valid: boolean; error: string | null }>(`/settings/ai-gateway/connections/${provider}/test`, {}),
  disconnect: (provider: AiProviderId) => apiClient.del<void>(`/settings/ai-gateway/connections/${provider}`),
  getConfig: () => apiClient.get<GlobalAiConfigDTO>("/settings/ai-gateway/config"),
  setConfig: (input: { mode: "auto" | "fixed"; fixedProvider?: AiProviderId; fixedModel?: string; autoAllowedProviders?: AiProviderId[] }) =>
    apiClient.put<GlobalAiConfigDTO>("/settings/ai-gateway/config", input),
  /** This month's token usage across every project, against the optional account budget. */
  getTokenUsage: () => apiClient.get<{ usage: AccountTokenUsageDTO }>("/settings/token-usage").then((r) => r.usage),
  setTokenBudget: (monthlyTokens: number | null) =>
    apiClient.put<{ usage: AccountTokenUsageDTO }>("/settings/token-budget", { monthlyTokens }).then((r) => r.usage),
  getUsage: () => apiClient.get<{ usage: ProviderUsageTotalsDTO[] }>("/settings/ai-gateway/usage"),
};
