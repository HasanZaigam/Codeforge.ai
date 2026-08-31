import { randomUUID } from "node:crypto";
import type { GitHubCredentialRepository } from "../persistence/repositories/github-credential-repository.js";
import { encryptSecret } from "../auth/credential-encryption.js";
import { resolveGitHubToken } from "../integrations/github/credential-resolver.js";
import { GitHubAuthError, GitHubClient, type GitHubRepository } from "../integrations/github/github-client.js";
import { InvalidGitHubTokenError } from "./errors.js";

export interface GitHubConnectionStatus {
  connected: boolean;
  githubLogin: string | null;
  connectedAt: string | null;
}

export type GitHubClientFactory = (token: string) => GitHubClient;

/**
 * Connecting a GitHub *account* (this service) is a separate concern from
 * connecting a *repository* to a Project (ProjectService) — see
 * /docs/GITHUB_INTEGRATION.md "Platform auth vs. GitHub authorization".
 * "Who is the user" (Step 6) never implies "what may the platform do on
 * their behalf on GitHub" — that's exactly what this service, and the
 * credential it stores, answers.
 */
export class GitHubIntegrationService {
  constructor(
    private readonly credentials: GitHubCredentialRepository,
    private readonly encryptionKey: () => Buffer,
    private readonly clientFactory: GitHubClientFactory = (token) => new GitHubClient(token),
  ) {}

  /**
   * Verifies the token actually works (a real GitHub API call — never
   * trusts a client-supplied token blindly) before storing anything.
   */
  async connect(userId: string, token: string): Promise<GitHubConnectionStatus> {
    const client = this.clientFactory(token);
    let login: string;
    try {
      login = (await client.getAuthenticatedUser()).login;
    } catch (err) {
      if (err instanceof GitHubAuthError) throw new InvalidGitHubTokenError();
      throw err;
    }

    const now = new Date().toISOString();
    const existing = this.credentials.findByUserId(userId);
    const secret = encryptSecret(token, this.encryptionKey());
    this.credentials.upsert({
      id: existing?.id ?? randomUUID(),
      userId,
      githubLogin: login,
      secret,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
    });

    return { connected: true, githubLogin: login, connectedAt: existing?.createdAt ?? now };
  }

  getStatus(userId: string): GitHubConnectionStatus {
    const record = this.credentials.findByUserId(userId);
    return record
      ? { connected: true, githubLogin: record.githubLogin, connectedAt: record.createdAt }
      : { connected: false, githubLogin: null, connectedAt: null };
  }

  /** Real revocation — the stored credential is deleted, not just marked inactive. */
  disconnect(userId: string): void {
    this.credentials.deleteByUserId(userId);
  }

  /**
   * Resolves a ready-to-use GitHubClient for `userId` — used by
   * ProjectService to validate a repository at connection time. Throws
   * GitHubNotConnectedError if the user hasn't connected an account.
   */
  clientForUser(userId: string): GitHubClient {
    const token = resolveGitHubToken(this.credentials, this.encryptionKey(), userId);
    return this.clientFactory(token);
  }
}

export type { GitHubRepository };
export { GitHubNotConnectedError } from "../integrations/github/credential-resolver.js";
