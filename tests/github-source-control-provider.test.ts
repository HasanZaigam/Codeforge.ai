import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSourceControlProvider, classifyGitPushError } from "../src/source-control/github-source-control-provider.js";
import { CancellationError } from "../src/domain/errors.js";
import { GitHubNotFoundError } from "../src/integrations/github/github-client.js";
import type { GitHubCredentialRepository } from "../src/persistence/repositories/github-credential-repository.js";
import type { GitHubClient, GitHubPullRequestReview, GitHubIssueComment } from "../src/integrations/github/github-client.js";
import type { Project, PullRequestRef } from "../src/domain/types.js";

import { encryptSecret } from "../src/auth/credential-encryption.js";

// Mock credential repository to return a known token
const testKey = Buffer.alloc(32);
const mockCredentials = {
  findByUserId: (userId: string) => {
    return { secret: encryptSecret("ghp_testtoken123", testKey) };
  },
  touch: () => {}
} as unknown as GitHubCredentialRepository;

// Mock encryption key resolver
const mockEncryptionKey = () => testKey;

const testProject: Project = {
  id: "project-1",
  tenantId: "default",
  ownerId: "user-1",
  name: "Fixture",
  repoUrl: "https://github.com/acme/widgets.git",
  defaultBranch: "main",
  codingEngine: "fixture",
  sourceControlProvider: "github",
  owner: "acme",
  repo: "widgets",
  commands: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A minimal, fully-scripted GitHubClient stand-in — no network, no real credential. */
function fakeGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listPullRequests: async () => [],
    createPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "open" }),
    getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "open", merged: false }),
    listPullRequestReviews: async () => [],
    listIssueComments: async () => [],
    ...overrides,
  } as unknown as GitHubClient;
}

test("resolveCloneCredential issues a Basic auth header, not a Bearer token (which Git over HTTPS rejects)", async () => {
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey);
  const project = { ownerId: "user-1" } as Project;
  const credential = await provider.resolveCloneCredential(project, new AbortController().signal);

  const expectedBasic = Buffer.from("x-access-token:ghp_testtoken123").toString("base64");
  assert.equal(credential.header, `Authorization: Basic ${expectedBasic}`);
  assert.ok(!credential.header.includes("Bearer"));
});

// ---------------------------------------------------------------------------
// PR idempotency — including "GitHub actually created it but the response was lost"
// ---------------------------------------------------------------------------

test("openPullRequest reuses an existing open PR for the branch instead of creating a new one", async () => {
  let createCalls = 0;
  const client = fakeGitHubClient({
    listPullRequests: async () => [{ number: 9, htmlUrl: "https://github.com/acme/widgets/pull/9", state: "open" }],
    createPullRequest: async () => {
      createCalls += 1;
      throw new Error("must not be called — a matching PR already exists");
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const ref = await provider.openPullRequest(
    testProject,
    { workspacePath: "/tmp/ws", branch: "task/abc", baseBranch: "main", title: "T", description: "D" },
    new AbortController().signal,
  );
  assert.equal(ref.number, 9);
  assert.equal(createCalls, 0);
});

test("PR creation 'succeeds on GitHub but the response is lost': the next openPullRequest call discovers it via search, never creates a duplicate", async () => {
  // Simulates the exact race the milestone describes: createPullRequest's HTTP call throws (e.g. a
  // timeout reading the response) even though GitHub's server actually created the PR. The
  // Orchestrator's own retry (crash-recovery, a later worker poll, ...) calls openPullRequest again
  // — this is a NEW call, not an automatic retry inside GitHubClient (see createPullRequest's own
  // doc comment on why that distinction matters for a non-idempotent POST).
  let searchCalls = 0;
  const client = fakeGitHubClient({
    listPullRequests: async () => {
      searchCalls += 1;
      // The first search (before the "lost response" attempt) finds nothing; by the second call,
      // GitHub's own state now has the PR that was actually created despite the client never seeing
      // a successful response.
      if (searchCalls === 1) return [];
      return [{ number: 5, htmlUrl: "https://github.com/acme/widgets/pull/5", state: "open" }];
    },
    createPullRequest: async () => {
      throw new Error("Could not reach GitHub: response lost");
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const request = { workspacePath: "/tmp/ws", branch: "task/abc", baseBranch: "main", title: "T", description: "D" };

  await assert.rejects(() => provider.openPullRequest(testProject, request, new AbortController().signal));

  const ref = await provider.openPullRequest(testProject, request, new AbortController().signal);
  assert.equal(ref.number, 5, "the retry discovers the PR GitHub actually created, instead of creating a second one");
});

// ---------------------------------------------------------------------------
// PR state handling
// ---------------------------------------------------------------------------

test("listPullRequestFeedback returns [] for a merged PR without fetching reviews/comments at all", async () => {
  let reviewsCalled = false;
  const client = fakeGitHubClient({
    getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "closed", merged: true }),
    listPullRequestReviews: async () => {
      reviewsCalled = true;
      return [];
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  const items = await provider.listPullRequestFeedback(testProject, pr, new AbortController().signal);
  assert.deepEqual(items, []);
  assert.equal(reviewsCalled, false, "a merged PR's reviews/comments are never even fetched");
});

test("listPullRequestFeedback returns [] for a closed (not merged) PR", async () => {
  const client = fakeGitHubClient({
    getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "closed", merged: false }),
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  const items = await provider.listPullRequestFeedback(testProject, pr, new AbortController().signal);
  assert.deepEqual(items, []);
});

test("listPullRequestFeedback fetches reviews/comments normally for an open PR", async () => {
  const review: GitHubPullRequestReview = { id: 1, authorLogin: "octocat", body: "Please fix X", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00.000Z" };
  const comment: GitHubIssueComment = { id: 2, authorLogin: "octocat", body: "also this", createdAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" };
  const client = fakeGitHubClient({
    listPullRequestReviews: async () => [review],
    listIssueComments: async () => [comment],
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  const items = await provider.listPullRequestFeedback(testProject, pr, new AbortController().signal);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "review:1");
  assert.equal(items[0]!.verdict, "changes_requested");
  assert.equal(items[1]!.id, "comment:2");
});

// ---------------------------------------------------------------------------
// getPullRequestStatus — PR merge sync (see /docs/TASK_LIFECYCLE.md "PR merge sync")
// ---------------------------------------------------------------------------

test("getPullRequestStatus reports merged:true for a merged PR", async () => {
  const client = fakeGitHubClient({
    getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "closed", merged: true }),
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  const status = await provider.getPullRequestStatus(testProject, pr, new AbortController().signal);
  assert.deepEqual(status, { state: "closed", merged: true, mergeable: null });
});

test("getPullRequestStatus reports merged:false for a closed-but-not-merged PR", async () => {
  const client = fakeGitHubClient({
    getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "closed", merged: false }),
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  const status = await provider.getPullRequestStatus(testProject, pr, new AbortController().signal);
  assert.deepEqual(status, { state: "closed", merged: false, mergeable: null });
});

test("getPullRequestStatus reports open/unmerged for an open PR", async () => {
  const client = fakeGitHubClient({
    getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "open", merged: false }),
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  const status = await provider.getPullRequestStatus(testProject, pr, new AbortController().signal);
  assert.deepEqual(status, { state: "open", merged: false, mergeable: null });
});

test("cancellation racing getPullRequestStatus surfaces as CancellationError", async () => {
  const controller = new AbortController();
  const client = fakeGitHubClient({
    getPullRequest: async () => {
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  await assert.rejects(() => provider.getPullRequestStatus(testProject, pr, controller.signal), CancellationError);
});

// ---------------------------------------------------------------------------
// Cancellation around network GitHub operations
// ---------------------------------------------------------------------------

test("cancellation racing openPullRequest's search step surfaces as CancellationError, not a raw abort or generic failure", async () => {
  const controller = new AbortController();
  const client = fakeGitHubClient({
    listPullRequests: async () => {
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  await assert.rejects(
    () => provider.openPullRequest(testProject, { workspacePath: "/tmp/ws", branch: "task/abc", baseBranch: "main", title: "T", description: "D" }, controller.signal),
    CancellationError,
  );
});

test("cancellation racing openPullRequest's create step surfaces as CancellationError", async () => {
  const controller = new AbortController();
  const client = fakeGitHubClient({
    createPullRequest: async () => {
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  await assert.rejects(
    () => provider.openPullRequest(testProject, { workspacePath: "/tmp/ws", branch: "task/abc", baseBranch: "main", title: "T", description: "D" }, controller.signal),
    CancellationError,
  );
});

test("cancellation racing listPullRequestFeedback surfaces as CancellationError", async () => {
  const controller = new AbortController();
  const client = fakeGitHubClient({
    getPullRequest: async () => {
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
  await assert.rejects(() => provider.listPullRequestFeedback(testProject, pr, controller.signal), CancellationError);
});

// ---------------------------------------------------------------------------
// Push failure classification (git-CLI text, not HTTP status)
// ---------------------------------------------------------------------------

test("classifyGitPushError: recognizes transient network failures as retryable", () => {
  assert.equal(classifyGitPushError("fatal: unable to access 'https://github.com/...': Could not resolve host: github.com"), "retryable_transient");
  assert.equal(classifyGitPushError("error: RPC failed; curl 56 GnuTLS recv error"), "retryable_transient");
  assert.equal(classifyGitPushError("fatal: the remote end hung up unexpectedly"), "retryable_transient");
  assert.equal(classifyGitPushError("fatal: unable to access: The requested URL returned error: 503"), "retryable_transient");
});

test("classifyGitPushError: never treats auth/permission/conflict failures as retryable", () => {
  assert.equal(classifyGitPushError("fatal: Authentication failed for 'https://github.com/acme/widgets.git/'"), "auth");
  assert.equal(classifyGitPushError("remote: Permission to acme/widgets.git denied to some-user."), "authorization");
  assert.equal(classifyGitPushError("! [rejected]        task/abc -> task/abc (non-fast-forward)\nerror: failed to push some refs"), "conflict");
});

test("classifyGitPushError: an unrecognized error text is conservatively non-retryable", () => {
  assert.equal(classifyGitPushError("fatal: something completely unexpected happened"), "unknown");
});

// ---------------------------------------------------------------------------
// Branch existence validation (§8) — see /docs/TASK_LIFECYCLE.md "Branch existence validation"
// ---------------------------------------------------------------------------

test("branchExists: true when GitHub's branch API finds the branch, false when it 404s — a real, checkable fact, never null", async () => {
  const client = fakeGitHubClient({ getBranch: async (_o, _r, branch) => (branch === "release" ? { sha: "abc123" } : null) });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);

  assert.equal(await provider.branchExists(testProject, "release", new AbortController().signal), true);
  assert.equal(await provider.branchExists(testProject, "deleted-branch", new AbortController().signal), false);
});

// ---------------------------------------------------------------------------
// Stale/behind detection (§9) — see /docs/TASK_LIFECYCLE.md "Stale/behind detection"
// ---------------------------------------------------------------------------

test("getBranchStatus: reports real ahead/behind counts from GitHub's compare API", async () => {
  const client = fakeGitHubClient({
    compareCommits: async (_o, _r, base, head) => {
      assert.equal(base, "main");
      assert.equal(head, "task/fix-login");
      return { aheadBy: 2, behindBy: 3, status: "diverged" };
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const status = await provider.getBranchStatus(testProject, "task/fix-login", "main", new AbortController().signal);
  assert.deepEqual(status, { comparable: true, aheadBy: 2, behindBy: 3 });
});

test("getBranchStatus: a ref that no longer exists reports comparable:false rather than throwing — advisory display data, never a gate", async () => {
  const client = fakeGitHubClient({
    compareCommits: async () => {
      throw new GitHubNotFoundError("Comparison");
    },
  });
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
  const status = await provider.getBranchStatus(testProject, "deleted-branch", "main", new AbortController().signal);
  assert.deepEqual(status, { comparable: false, aheadBy: null, behindBy: null });
});

// ---------------------------------------------------------------------------
// Merge/conflict state (§10) — see /docs/TASK_LIFECYCLE.md "Merge/conflict state"
// ---------------------------------------------------------------------------

test("getPullRequestStatus: surfaces GitHub's own mergeable verdict — true, false, and null (not yet computed) are all passed through, never coerced", async () => {
  for (const mergeable of [true, false, null]) {
    const client = fakeGitHubClient({
      getPullRequest: async () => ({ number: 1, htmlUrl: "https://github.com/acme/widgets/pull/1", state: "open", merged: false, mergeable }),
    });
    const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey, () => client);
    const pr: PullRequestRef = { provider: "github", id: "1", number: 1, url: null };
    const status = await provider.getPullRequestStatus(testProject, pr, new AbortController().signal);
    assert.equal(status.mergeable, mergeable);
  }
});
