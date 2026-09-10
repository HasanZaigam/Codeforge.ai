import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBranchState } from "../src/reporting/branch-state.js";
import type { BranchComparisonStatus, PullRequestRef, PullRequestStatus } from "../src/domain/types.js";

/**
 * Pure unit tests for the §10 merge/conflict state model (see
 * /docs/TASK_LIFECYCLE.md "Merge/conflict state") — deliberately provider-
 * agnostic inputs (no GitHubClient, no network) since deriveBranchState is a
 * pure function of already-fetched PullRequestStatus/BranchComparisonStatus
 * data. See src/reporting/branch-state.ts's own doc comment on why this
 * lives outside the Orchestrator and never drives task-execution control
 * flow (§13 — AI-implementation-state, git-branch-state, and PR-state stay
 * conceptually separate).
 */

const githubPr: PullRequestRef = { provider: "github", id: "1", number: 1, url: "https://github.com/acme/widgets/pull/1" };
const localGitPr: PullRequestRef = { provider: "local-git", id: "abc", number: null, url: null };

const upToDate: BranchComparisonStatus = { comparable: true, aheadBy: 1, behindBy: 0 };
const behind: BranchComparisonStatus = { comparable: true, aheadBy: 1, behindBy: 3 };
const notComparable: BranchComparisonStatus = { comparable: false, aheadBy: null, behindBy: null };

test("no PR opened yet: UNKNOWN, regardless of branch comparison data", () => {
  const result = deriveBranchState(null, null, behind);
  assert.equal(result.mergeState, "UNKNOWN");
  // Comparison data is still surfaced even before a PR exists — behind-detection doesn't depend on a PR.
  assert.equal(result.behindBy, 3);
});

test("merged PR: MERGED, regardless of ahead/behind or mergeable — a merge is a terminal fact", () => {
  const status: PullRequestStatus = { state: "closed", merged: true, mergeable: null };
  const result = deriveBranchState(githubPr, status, upToDate);
  assert.equal(result.mergeState, "MERGED");
});

test("closed without merging: CLOSED_NOT_MERGED, never DONE-implying", () => {
  const status: PullRequestStatus = { state: "closed", merged: false, mergeable: null };
  const result = deriveBranchState(githubPr, status, upToDate);
  assert.equal(result.mergeState, "CLOSED_NOT_MERGED");
});

test("open PR GitHub reports as not cleanly mergeable: CONFLICT, even if not behind", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: false };
  const result = deriveBranchState(githubPr, status, upToDate);
  assert.equal(result.mergeState, "CONFLICT");
});

test("open PR, mergeable, but behind its base: BEHIND, with the real commit count surfaced", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: true };
  const result = deriveBranchState(githubPr, status, behind);
  assert.equal(result.mergeState, "BEHIND");
  assert.equal(result.behindBy, 3);
  assert.equal(result.aheadBy, 1);
});

test("open PR, mergeable, not behind: READY", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: true };
  const result = deriveBranchState(githubPr, status, upToDate);
  assert.equal(result.mergeState, "READY");
});

test("open PR, mergeable unknown (GitHub hasn't computed it yet), not behind: READY, never fabricated CONFLICT", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: null };
  const result = deriveBranchState(githubPr, status, upToDate);
  assert.equal(result.mergeState, "READY");
});

test("local-git PR (pr.number === null): NOT_APPLICABLE — never fabricated as READY/CONFLICT", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: null };
  const result = deriveBranchState(localGitPr, status, behind);
  assert.equal(result.mergeState, "NOT_APPLICABLE");
  // Behind-detection is still honest and independent of the PR concept — local-git can still know this.
  assert.equal(result.behindBy, 3);
});

test("comparison not comparable: behindBy/aheadBy are null and comparable is false — never a guessed number", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: true };
  const result = deriveBranchState(githubPr, status, notComparable);
  assert.equal(result.comparable, false);
  assert.equal(result.behindBy, null);
  assert.equal(result.aheadBy, null);
  // Can't confirm "behind," so this must not fabricate BEHIND — falls through to READY.
  assert.equal(result.mergeState, "READY");
});

test("no comparison data at all (branch not yet provisioned): comparable false, mergeState still derived from PR alone", () => {
  const status: PullRequestStatus = { state: "open", merged: false, mergeable: false };
  const result = deriveBranchState(githubPr, status, null);
  assert.equal(result.comparable, false);
  assert.equal(result.mergeState, "CONFLICT");
});
