import { apiClient } from "./client.js";
import type { GitHubConnectionDTO } from "./types.js";

/** GET/POST/DELETE /integrations/github — see /docs/API.md. The token itself is write-only; never returned. */
export const githubIntegrationApi = {
  getStatus: () => apiClient.get<GitHubConnectionDTO>("/integrations/github"),
  connect: (token: string) => apiClient.post<GitHubConnectionDTO>("/integrations/github", { token }),
  disconnect: () => apiClient.del<void>("/integrations/github"),
};
