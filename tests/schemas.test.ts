import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskSchema, isSafeBranchName, parseGitHubRepoUrl } from "../src/api/schemas.js";

/**
 * Part A/I coverage: server-side GitHub URL parsing/normalization (never
 * trusts client-side parsing alone — see ProjectService.verifyGitHubRepositoryUrl)
 * and branch-name safety (see /docs/TASK_LIFECYCLE.md "Branch modes").
 */

test("parseGitHubRepoUrl: accepts https URL with and without .git, and a trailing slash", () => {
  assert.deepEqual(parseGitHubRepoUrl("https://github.com/octocat/Hello-World"), { owner: "octocat", repo: "Hello-World" });
  assert.deepEqual(parseGitHubRepoUrl("https://github.com/octocat/Hello-World.git"), { owner: "octocat", repo: "Hello-World" });
  assert.deepEqual(parseGitHubRepoUrl("https://github.com/octocat/Hello-World/"), { owner: "octocat", repo: "Hello-World" });
});

test("parseGitHubRepoUrl: accepts the SSH shorthand and an explicit ssh:// URL", () => {
  assert.deepEqual(parseGitHubRepoUrl("git@github.com:octocat/Hello-World.git"), { owner: "octocat", repo: "Hello-World" });
  assert.deepEqual(parseGitHubRepoUrl("ssh://git@github.com/octocat/Hello-World.git"), { owner: "octocat", repo: "Hello-World" });
});

test("parseGitHubRepoUrl: rejects a non-github.com host", () => {
  assert.equal(parseGitHubRepoUrl("https://gitlab.com/octocat/Hello-World"), null);
  assert.equal(parseGitHubRepoUrl("https://not-github.com.evil.example/octocat/Hello-World"), null);
});

test("parseGitHubRepoUrl: rejects malformed input — empty, missing repo segment, extra path segments", () => {
  assert.equal(parseGitHubRepoUrl(""), null);
  assert.equal(parseGitHubRepoUrl("https://github.com/octocat"), null);
  assert.equal(parseGitHubRepoUrl("https://github.com/octocat/Hello-World/extra/segment"), null);
  assert.equal(parseGitHubRepoUrl("not a url at all"), null);
});

test("parseGitHubRepoUrl: rejects an owner/repo that fails GitHub's own naming rules", () => {
  assert.equal(parseGitHubRepoUrl("https://github.com/-bad-owner/repo"), null);
  assert.equal(parseGitHubRepoUrl("https://github.com/owner/bad repo name"), null);
});

test("isSafeBranchName: accepts a normal, safe branch name", () => {
  assert.equal(isSafeBranchName("task/fix-login-bug"), true);
  assert.equal(isSafeBranchName("release-1.2.3"), true);
  assert.equal(isSafeBranchName("feature_x"), true);
});

test("isSafeBranchName: rejects a leading '-' (a git-flag look-alike)", () => {
  assert.equal(isSafeBranchName("-rf"), false);
  assert.equal(isSafeBranchName("--force"), false);
});

test("isSafeBranchName: rejects path traversal and ref-unsafe sequences", () => {
  assert.equal(isSafeBranchName("../../etc/passwd"), false);
  assert.equal(isSafeBranchName("a..b"), false);
  assert.equal(isSafeBranchName("a//b"), false);
  assert.equal(isSafeBranchName("trailing/"), false);
  assert.equal(isSafeBranchName("name.lock"), false);
});

test("isSafeBranchName: rejects shell metacharacters and whitespace", () => {
  for (const name of ["main; rm -rf /", "main && echo hi", "main`whoami`", "main$(whoami)", "main | cat", "has space", "a\nb"]) {
    assert.equal(isSafeBranchName(name), false, `expected "${name}" to be rejected`);
  }
});

test("CreateTaskSchema: branchMode defaults to undefined (service defaults to 'new') when omitted — existing clients unaffected", () => {
  const parsed = CreateTaskSchema.parse({ title: "T", description: "D" });
  assert.equal(parsed.branchMode, undefined);
  assert.equal(parsed.branchName, undefined);
  assert.equal(parsed.existingBranch, undefined);
});

test("CreateTaskSchema: requires existingBranch when branchMode is 'existing'", () => {
  assert.throws(() => CreateTaskSchema.parse({ title: "T", description: "D", branchMode: "existing" }));
  const ok = CreateTaskSchema.parse({ title: "T", description: "D", branchMode: "existing", existingBranch: "feature/x" });
  assert.equal(ok.existingBranch, "feature/x");
});

test("CreateTaskSchema: rejects an unsafe branchName/existingBranch value", () => {
  assert.throws(() => CreateTaskSchema.parse({ title: "T", description: "D", branchMode: "new", branchName: "-rf" }));
  assert.throws(() => CreateTaskSchema.parse({ title: "T", description: "D", branchMode: "existing", existingBranch: "main; rm -rf /" }));
});
