import { randomUUID } from "node:crypto";
import { CancellationError } from "../../src/domain/errors.js";
import type { BranchComparisonStatus, GitCredential, HumanReviewFeedbackItem, Project, PullRequestRef, PullRequestStatus } from "../../src/domain/types.js";
import type { OpenPullRequestRequest, SourceControlProvider } from "../../src/source-control/source-control-provider.js";

export type FakeFailurePoint = "resolveCloneCredential" | "commitAll" | "push" | "openPullRequest";

/**
 * Deterministic SourceControlProvider test double — exercises the same
 * commit/push/PR-idempotency contract a real GitHubSourceControlProvider
 * must satisfy, without any live GitHub credential or network access. See
 * /docs/GITHUB_INTEGRATION.md "Testing strategy".
 *
 * Registered under whatever key the test wants (usually "github", to stand
 * in for the real provider) via `additionalSourceControlProviders` in
 * buildPlatform().
 */
export class FakeSourceControlProvider implements SourceControlProvider {
  readonly key: string;

  /** Every call this instance has observed, in order — for asserting idempotency (no duplicate push/PR calls). */
  readonly calls: Array<{ op: FakeFailurePoint; branch?: string }> = [];

  /** PRs "created" so far, keyed by branch — simulates GitHub's own state so search-before-create can be tested. */
  private readonly openPullRequestsByBranch = new Map<string, PullRequestRef>();

  private failAt: FakeFailurePoint | null = null;
  private cancelAt: FakeFailurePoint | null = null;

  /** Scripted human PR feedback, keyed by branch — see setPullRequestFeedback / listPullRequestFeedback. */
  private readonly feedbackByBranch = new Map<string, HumanReviewFeedbackItem[]>();
  /** Every listPullRequestFeedback() call this instance has observed — for asserting polling behavior. */
  readonly feedbackCalls: number[] = [];
  /** Scripted PR state, keyed by branch — mirrors GitHubSourceControlProvider's real PR-state check (merged/closed PRs are never actionable). Defaults to "open". */
  private readonly prStateByBranch = new Map<string, "open" | "closed" | "merged">();
  /** The next listPullRequestFeedback() call throws this exact error instead — see failNextCallToFeedback. */
  private feedbackFailure: Error | null = null;
  /** The next getPullRequestStatus() call throws this exact error instead — see failNextCallToStatus. */
  private statusFailure: Error | null = null;
  /** Every getPullRequestStatus() call this instance has observed — for asserting polling behavior/cadence. */
  readonly statusCalls: number[] = [];

  constructor(key = "github") {
    this.key = key;
  }

  /** Scripts the full current feedback set a real GitHub PR would return for `branch` — see listPullRequestFeedback. */
  setPullRequestFeedback(branch: string, items: HumanReviewFeedbackItem[]): void {
    this.feedbackByBranch.set(branch, items);
  }

  /** Scripts the PR's current state for `branch` — see listPullRequestFeedback's PR-state check, mirroring GitHubSourceControlProvider's real one. */
  setPullRequestState(branch: string, state: "open" | "closed" | "merged"): void {
    this.prStateByBranch.set(branch, state);
  }

  /** The next listPullRequestFeedback() call throws this exact error (e.g. a GitHubAuthError, or a
   *  plain Error to simulate a transient/unclassified failure) instead of returning normally. */
  failNextCallToFeedback(error: Error): void {
    this.feedbackFailure = error;
  }

  /** The next getPullRequestStatus() call throws this exact error (e.g. a GitHubAuthError, or a
   *  plain Error to simulate a transient/unclassified failure) instead of returning normally. */
  failNextCallToStatus(error: Error): void {
    this.statusFailure = error;
  }

  /** The next call to this operation throws instead of succeeding — simulates a real GitHub/network failure. */
  failNextCallTo(op: FakeFailurePoint): void {
    this.failAt = op;
  }

  /** The next call to this operation throws CancellationError instead — simulates cancellation racing a source-control step. */
  cancelNextCallTo(op: FakeFailurePoint): void {
    this.cancelAt = op;
  }

  async resolveCloneCredential(_project: Project, _signal: AbortSignal): Promise<GitCredential | null> {
    this.record("resolveCloneCredential");
    return { header: "Authorization: Bearer fake-test-token" };
  }

  async commitAll(_project: Project, _workspacePath: string, _message: string, _signal: AbortSignal): Promise<string> {
    this.record("commitAll");
    return `fake-sha-${randomUUID().slice(0, 8)}`;
  }

  async push(_project: Project, _workspacePath: string, branch: string, _signal: AbortSignal): Promise<void> {
    this.record("push", branch);
  }

  /** Mirrors GitHubSourceControlProvider.openPullRequest: searches this fake's own "existing PRs" before creating. */
  async openPullRequest(_project: Project, request: OpenPullRequestRequest, _signal: AbortSignal): Promise<PullRequestRef> {
    this.record("openPullRequest", request.branch);
    const existing = this.openPullRequestsByBranch.get(request.branch);
    if (existing) return existing;

    const ref: PullRequestRef = {
      provider: this.key,
      id: randomUUID(),
      number: this.openPullRequestsByBranch.size + 1,
      url: `https://example.invalid/fake-pr/${request.branch}`,
    };
    this.openPullRequestsByBranch.set(request.branch, ref);
    return ref;
  }

  /** Count of distinct PRs actually created (not returned via idempotent search) — for asserting no duplicates. */
  get pullRequestsCreated(): number {
    return this.openPullRequestsByBranch.size;
  }

  /** Mirrors GitHubSourceControlProvider: returns [] for a merged/closed PR (see setPullRequestState), otherwise whatever was scripted via setPullRequestFeedback for this PR's branch. */
  async listPullRequestFeedback(_project: Project, pr: PullRequestRef, _signal: AbortSignal): Promise<HumanReviewFeedbackItem[]> {
    this.feedbackCalls.push(Date.now());
    if (this.feedbackFailure) {
      const err = this.feedbackFailure;
      this.feedbackFailure = null;
      throw err;
    }
    for (const [branch, ref] of this.openPullRequestsByBranch) {
      if (ref.id === pr.id) {
        const state = this.prStateByBranch.get(branch) ?? "open";
        if (state !== "open") return [];
        return this.feedbackByBranch.get(branch) ?? [];
      }
    }
    return [];
  }

  /** Mirrors GitHubSourceControlProvider.getPullRequestStatus: reports the scripted state (see setPullRequestState) for this PR's branch, defaulting to open/unmerged. */
  async getPullRequestStatus(_project: Project, pr: PullRequestRef, _signal: AbortSignal): Promise<PullRequestStatus> {
    this.statusCalls.push(Date.now());
    if (this.statusFailure) {
      const err = this.statusFailure;
      this.statusFailure = null;
      throw err;
    }
    for (const [branch, ref] of this.openPullRequestsByBranch) {
      if (ref.id === pr.id) {
        const state = this.prStateByBranch.get(branch) ?? "open";
        return { state: state === "open" ? "open" : "closed", merged: state === "merged", mergeable: this.mergeableByBranch.get(branch) ?? null };
      }
    }
    return { state: "open", merged: false, mergeable: null };
  }

  /** Scripted branch list for listBranches() — defaults to []. */
  private branches: string[] = [];

  setBranches(branches: string[]): void {
    this.branches = branches;
  }

  async listBranches(_project: Project, _signal: AbortSignal): Promise<string[]> {
    return this.branches;
  }

  /** Scripted `branchExists()` result, keyed by branch — defaults to `true` (matches most tests' happy path; opt into `false`/`null` explicitly via setBranchExists). */
  private branchExistsByName = new Map<string, boolean | null>();

  setBranchExists(branch: string, exists: boolean | null): void {
    this.branchExistsByName.set(branch, exists);
  }

  async branchExists(_project: Project, branch: string, _signal: AbortSignal): Promise<boolean | null> {
    return this.branchExistsByName.has(branch) ? this.branchExistsByName.get(branch)! : true;
  }

  /** Scripted `getBranchStatus()` result, keyed by branch — defaults to "up to date, comparable". */
  private branchStatusByName = new Map<string, BranchComparisonStatus>();
  /** Scripted `mergeable` verdict for a PR, keyed by branch — see getPullRequestStatus above. Defaults to null ("unknown"). */
  private mergeableByBranch = new Map<string, boolean | null>();

  setBranchStatus(branch: string, status: BranchComparisonStatus): void {
    this.branchStatusByName.set(branch, status);
  }

  setMergeable(branch: string, mergeable: boolean | null): void {
    this.mergeableByBranch.set(branch, mergeable);
  }

  async getBranchStatus(_project: Project, branch: string, _baseBranch: string, _signal: AbortSignal): Promise<BranchComparisonStatus> {
    return this.branchStatusByName.get(branch) ?? { comparable: true, aheadBy: 0, behindBy: 0 };
  }

  private record(op: FakeFailurePoint, branch?: string): void {
    this.calls.push({ op, branch });
    if (this.cancelAt === op) {
      this.cancelAt = null;
      throw new CancellationError();
    }
    if (this.failAt === op) {
      this.failAt = null;
      throw new Error(`FakeSourceControlProvider: simulated failure at ${op}`);
    }
  }
}
