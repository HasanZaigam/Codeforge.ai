import { apiClient } from "./client.js";
import type { GlobalAiConfigDTO, ProviderConnectionDTO, ProviderUsageTotalsDTO, AiProviderId } from "./types.js";

/** Settings -> AI / Models (see /docs/MODEL_GATEWAY.md). The provider API key is write-only — never returned. */
export const modelGatewayApi = {
  listConnections: () => apiClient.get<{ connections: ProviderConnectionDTO[] }>("/settings/ai-gateway/connections"),
  /** A real, on-demand "list models" call for this key — never persisted. Lets the Connect dialog offer a dropdown instead of a free-typed model id. */
  listModels: (provider: AiProviderId, apiKey: string) => apiClient.post<{ models: string[]; error: string | null }>(`/settings/ai-gateway/providers/${provider}/models`, { apiKey }),
  connect: (provider: AiProviderId, apiKey: string, model: string) =>
    apiClient.post<ProviderConnectionDTO>(`/settings/ai-gateway/connections/${provider}`, { apiKey, model }),
  /** A real, on-demand provider API call — unlike the stored `status`, which can't notice a key revoked entirely on the provider's own side. */
  testConnection: (provider: AiProviderId) => apiClient.post<{ valid: boolean; error: string | null }>(`/settings/ai-gateway/connections/${provider}/test`, {}),
  disconnect: (provider: AiProviderId) => apiClient.del<void>(`/settings/ai-gateway/connections/${provider}`),
  getConfig: () => apiClient.get<GlobalAiConfigDTO>("/settings/ai-gateway/config"),
  setConfig: (input: { mode: "auto" | "fixed"; fixedProvider?: AiProviderId; fixedModel?: string; autoAllowedProviders?: AiProviderId[] }) =>
    apiClient.put<GlobalAiConfigDTO>("/settings/ai-gateway/config", input),
  getUsage: () => apiClient.get<{ usage: ProviderUsageTotalsDTO[] }>("/settings/ai-gateway/usage"),
};
