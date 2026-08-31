import { decryptSecret } from "../../auth/credential-encryption.js";
import type { GitHubCredentialRepository } from "../../persistence/repositories/github-credential-repository.js";

/** The user has no connected GitHub account yet — distinct from an invalid/revoked one (see GitHubAuthError). */
export class GitHubNotConnectedError extends Error {
  constructor() {
    super("No GitHub account is connected for this user");
    this.name = "GitHubNotConnectedError";
  }
}

/**
 * Shared by `GitHubIntegrationService` (application layer, for the
 * connect/status API) and `GitHubSourceControlProvider` (infrastructure,
 * for task execution) so neither has to depend on the other — see
 * /docs/GITHUB_INTEGRATION.md "Credential storage". Touches `last_used_at`
 * as a side effect (best-effort visibility into whether a stored credential
 * is actually being used).
 */
export function resolveGitHubToken(credentials: GitHubCredentialRepository, encryptionKey: Buffer, userId: string): string {
  const record = credentials.findByUserId(userId);
  if (!record) throw new GitHubNotConnectedError();
  const token = decryptSecret(record.secret, encryptionKey);
  credentials.touch(userId, new Date().toISOString());
  return token;
}
