import type { BranchComparisonStatus, CommitResult, GitCredential, HumanReviewFeedbackItem, Project, PullRequestRef, PullRequestStatus, PushResult } from "../domain/types.js";

export type { BranchComparisonStatus, CommitResult, GitCredential, PullRequestRef, PullRequestStatus, PushResult };

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

  /**
   * Platform-owned commit — see git-commit.ts's commitAllLocal, which every
   * implementation delegates to. `expectedBranch` is asserted against the
   * workspace's actual current branch BEFORE anything is staged or
   * committed: if the coding engine moved the workspace off its recorded
   * task branch (see PLATFORM_GAPS.md GAP-015), this throws
   * `BranchMismatchError` and commits nothing, rather than silently
   * committing onto whatever branch the engine left HEAD pointing at.
   * `CommitResult.changedFiles` is the platform's own git evidence, never
   * the coding engine's self-reported file list.
   */
  commitAll(project: Project, workspacePath: string, message: string, expectedBranch: string, signal: AbortSignal): Promise<CommitResult>;

  /**
   * Platform-owned push — asserts the same branch invariant `commitAll`
   * does immediately before pushing, pushes by explicit refspec
   * (`HEAD:refs/heads/<branch>`, never "whatever local branch happens to be
   * named `branch`"), and then reads the remote ref back to confirm it now
   * points at the commit that was just pushed — see PLATFORM_GAPS.md
   * GAP-015. A `git push` exiting 0 is not sufficient evidence on its own
   * that the intended branch was actually updated.
   */
  push(project: Project, workspacePath: string, branch: string, signal: AbortSignal): Promise<PushResult>;

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

  /**
   * The PR's current remote state — specifically whether it has been
   * merged, distinct from `listPullRequestFeedback`'s existing
   * merged/closed short-circuit (which only needed to know "actionable or
   * not," not *why*). This is what lets the Orchestrator tell a merge
   * (→ complete the task as DONE) apart from a plain close-without-merge
   * (→ stay REVIEW) — see /docs/TASK_LIFECYCLE.md "PR merge sync" and
   * /docs/GITHUB_INTEGRATION.md "PR state handling". A provider with no
   * real PR concept (e.g. local-git) always reports `{ state: "open",
   * merged: false }` — there is nothing external that could have merged it.
   */
  getPullRequestStatus(project: Project, pr: PullRequestRef, signal: AbortSignal): Promise<PullRequestStatus>;

  /**
   * Lists the repository's real remote branch names — used to populate the
   * "work directly on an existing branch" task-creation UI (see
   * /docs/API.md, CreateTaskDialog). GitHub: a real API call against
   * `project.owner`/`project.repo`. Local-git: a best-effort `git ls-remote
   * --heads` against `project.repoUrl` (no auth, no workspace required) —
   * returns `[]` if the remote can't be reached rather than throwing, since
   * this is advisory UI data, not a gate. Never throws for "no branches";
   * only for a genuine access/configuration failure on a provider that
   * requires a credential (GitHub with none connected).
   */
  listBranches(project: Project, signal: AbortSignal): Promise<string[]>;

  /**
   * Whether `branch` currently exists on the remote — used at *execution*
   * time (see Orchestrator.provisionWorkspace), not just task-creation time,
   * to catch a branch deleted after the task was created but before the
   * worker started it (see /docs/TASK_LIFECYCLE.md "Branch existence
   * validation"). Returns `true`/`false` when the provider can determine
   * this reliably (GitHub: a real API call), or `null` when it genuinely
   * cannot verify (local-git's best-effort remote reachability — same
   * "advisory, not a hard gate" policy `listBranches` already documents) —
   * a `null` result must never be treated as "doesn't exist."
   */
  branchExists(project: Project, branch: string, signal: AbortSignal): Promise<boolean | null>;

  /**
   * Ahead/behind commit counts between `branch` and `baseBranch` — detection
   * only (see BranchComparisonStatus's own doc comment and
   * /docs/TASK_LIFECYCLE.md "Stale/behind detection"); this never
   * rebases/merges anything, and the Orchestrator never calls this as part
   * of the task-execution control flow — it's read on demand for display
   * (see TaskService.getBranchState). GitHub: the real compare API.
   * local-git: real `git rev-list --left-right --count` plumbing against the
   * remote path — never fabricated for either provider.
   */
  getBranchStatus(project: Project, branch: string, baseBranch: string, signal: AbortSignal): Promise<BranchComparisonStatus>;
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
