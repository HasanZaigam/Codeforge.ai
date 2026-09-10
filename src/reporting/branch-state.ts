import type { BranchComparisonStatus, MergeState, PullRequestRef, PullRequestStatus } from "../domain/types.js";

/**
 * The read-only summary TaskService.getBranchState returns to the API layer
 * — see /docs/TASK_LIFECYCLE.md "Stale/behind detection" and "Merge/conflict
 * state". Deliberately a pure function of already-fetched provider data
 * (never itself calls a provider), and deliberately outside the Orchestrator
 * — this is a read path for display, never part of task-execution control
 * flow (see MergeState's own doc comment on why AI-implementation-state,
 * git-branch-state, and PR-state must stay conceptually separate).
 */
export interface BranchStateSummary {
  aheadBy: number | null;
  behindBy: number | null;
  comparable: boolean;
  mergeState: MergeState;
}

/**
 * Derives the richer branch/merge state from already-fetched provider data.
 * Provider-agnostic by construction (see /docs/TASK_LIFECYCLE.md "GitHub
 * provider abstraction discipline"): the only GitHub-vs-local-git signal
 * used is `pr.number === null`, an existing, already-documented fact of
 * `PullRequestRef` (GitHub always assigns a real number; local-git never
 * does — see domain/types.ts) — not a `provider === "github"` string check,
 * so a future third provider with a real PR concept needs no change here.
 */
export function deriveBranchState(
  pr: PullRequestRef | null,
  prStatus: PullRequestStatus | null,
  comparison: BranchComparisonStatus | null,
): BranchStateSummary {
  const aheadBy = comparison?.comparable ? comparison.aheadBy : null;
  const behindBy = comparison?.comparable ? comparison.behindBy : null;
  const comparable = comparison?.comparable ?? false;

  if (!pr || !prStatus) {
    return { aheadBy, behindBy, comparable, mergeState: "UNKNOWN" };
  }
  if (prStatus.merged) {
    return { aheadBy, behindBy, comparable, mergeState: "MERGED" };
  }
  if (prStatus.state === "closed") {
    return { aheadBy, behindBy, comparable, mergeState: "CLOSED_NOT_MERGED" };
  }
  // Open. `pr.number === null` means this provider has no real PR/merge concept at all (local-git —
  // see PullRequestRef's own doc comment) — never fabricate a GitHub-like READY/CONFLICT verdict for
  // that case, report it honestly instead.
  if (pr.number === null) {
    return { aheadBy, behindBy, comparable, mergeState: "NOT_APPLICABLE" };
  }
  if (prStatus.mergeable === false) {
    return { aheadBy, behindBy, comparable, mergeState: "CONFLICT" };
  }
  if (comparable && behindBy !== null && behindBy > 0) {
    return { aheadBy, behindBy, comparable, mergeState: "BEHIND" };
  }
  return { aheadBy, behindBy, comparable, mergeState: "READY" };
}
