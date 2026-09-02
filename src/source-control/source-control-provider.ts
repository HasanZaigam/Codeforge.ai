import type { GitCredential, HumanReviewFeedbackItem, Project, PullRequestRef } from "../domain/types.js";

export type { GitCredential, PullRequestRef };

export interface OpenPullRequestRequest {
  workspacePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  description: string;
}

/**
 * Platform-level source-control operations (as opposed to the coding
 * engine's own local `git` usage inside the workspace during iteration).
 * Selected per-project via `Project.sourceControlProvider` through a
 * `SourceControlProviderRegistry` — the same pattern `CodingEngineRegistry`
 * already uses for `Project.codingEngine` (see coding-engine.ts). The
 * Orchestrator never imports a concrete provider directly. See
 * /docs/INTEGRATION_ARCHITECTURE.md and /docs/GITHUB_INTEGRATION.md.
 *
 * Every operation takes the owning `Project` (not just a workspace path) —
 * a provider needs it to resolve which credential to use and where the
 * remote repository actually is. `signal`, if aborted, must stop the
 * underlying process/request and reject with CancellationError (see
 * /domain/errors.ts) — same cancellation contract as CodingEngine.run().
 */
export interface SourceControlProvider {
  readonly key: string;

  /**
   * Resolves an ephemeral credential for cloning `project`'s repository, or
   * null if none is needed (a public repo, or a provider — like the local
   * dev fixture one — that doesn't require auth). Never throws for "no
   * credential configured" on a provider that doesn't need one; DOES throw
   * if the provider requires a credential and none is available (e.g. the
   * GitHub provider with no connected account for the project owner).
   */
  resolveCloneCredential(project: Project, signal: AbortSignal): Promise<GitCredential | null>;

  commitAll(project: Project, workspacePath: string, message: string, signal: AbortSignal): Promise<string>; // returns commit sha

  push(project: Project, workspacePath: string, branch: string, signal: AbortSignal): Promise<void>;

  /**
   * Idempotent: implementations must check for an existing PR (or equivalent)
   * for `request.branch`/`request.baseBranch` before creating a new one —
   * see /docs/GITHUB_INTEGRATION.md "PR idempotency". Combined with the
   * Orchestrator's own `TaskRecord.pullRequest` short-circuit, this is
   * double-guarded against duplicate PRs on crash/retry.
   */
  openPullRequest(project: Project, request: OpenPullRequestRequest, signal: AbortSignal): Promise<PullRequestRef>;

  /**
   * Reads current human feedback (reviews + conversation comments) on `pr` —
   * the source for the human review feedback loop (see
   * /docs/TASK_LIFECYCLE.md "Human review feedback loop"). Returns the full
   * current set every call; the Orchestrator is responsible for diffing
   * against already-processed ids (see TaskRecord.processedHumanFeedbackIds)
   * — this keeps the provider itself stateless and safe to call repeatedly.
   * A provider with no PR-review concept (e.g. local-git) returns `[]`.
   */
  listPullRequestFeedback(project: Project, pr: PullRequestRef, signal: AbortSignal): Promise<HumanReviewFeedbackItem[]>;
}

export class UnknownSourceControlProviderError extends Error {
  constructor(key: string) {
    super(`No SourceControlProvider registered for key "${key}"`);
    this.name = "UnknownSourceControlProviderError";
  }
}

/** Mirrors CodingEngineRegistry exactly — see TECHNICAL_DECISIONS.md for why this registry was introduced in Step 7. */
export class SourceControlProviderRegistry {
  private readonly providers = new Map<string, SourceControlProvider>();

  register(provider: SourceControlProvider): void {
    this.providers.set(provider.key, provider);
  }

  resolve(key: string): SourceControlProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new UnknownSourceControlProviderError(key);
    return provider;
  }
}
