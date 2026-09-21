import { apiClient } from "./client.js";
import type { GitHubConnectionDTO } from "./types.js";

/** GET/POST/DELETE /integrations/github — see /docs/API.md. The token itself is write-only; never returned. */
export const githubIntegrationApi = {
  getStatus: () => apiClient.get<GitHubConnectionDTO>("/integrations/github"),
  connect: (token: string) => apiClient.post<GitHubConnectionDTO>("/integrations/github", { token }),
  disconnect: () => apiClient.del<void>("/integrations/github"),
  /**
   * A real, on-demand GitHub API call — unlike `getStatus`, which is a cheap local read that can
   * never tell you a token was revoked/expired on GitHub's own side. See SettingsPage's "Verify
   * connection" action, the only caller.
   */
  verify: () => apiClient.post<{ valid: boolean }>("/integrations/github/verify", {}),
};
