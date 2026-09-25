import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOnExpectedBranch, commitAllLocal, getCurrentBranch, hasNoRepositoryChanges } from "../src/source-control/git-commit.js";
import { BranchMismatchError } from "../src/domain/errors.js";

const execFileAsync = promisify(execFile);

/**
 * Real git, no mocking — this is the single choke point both
 * GitHubSourceControlProvider and LocalGitSourceControlProvider delegate to
 * for every platform-owned commit (see PLATFORM_GAPS.md GAP-015), so it is
 * tested directly against an actual repository rather than through either
 * provider's own test double.
 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-commit-test-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "file.txt"), "original\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", "initial"], { cwd: dir });
  return dir;
}

// ---------------------------------------------------------------------------
// Branch integrity (item 9.A — see PLATFORM_GAPS.md GAP-015)
// ---------------------------------------------------------------------------

test("assertOnExpectedBranch: passes silently when the workspace really is on the expected branch", async () => {
  const dir = await makeRepo();
  await assertOnExpectedBranch(dir, "main", "commit", new AbortController().signal);
});

test("assertOnExpectedBranch: throws BranchMismatchError, naming both branches, when the workspace is on a different branch", async () => {
  const dir = await makeRepo();
  await execFileAsync("git", ["checkout", "-b", "agent-own-branch"], { cwd: dir });

  await assert.rejects(
    () => assertOnExpectedBranch(dir, "main", "commit", new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof BranchMismatchError);
      assert.equal(err.expectedBranch, "main");
      assert.equal(err.actualBranch, "agent-own-branch");
      assert.ok(err.message.includes("main"));
      assert.ok(err.message.includes("agent-own-branch"));
      return true;
    },
  );
});

test("commitAllLocal: refuses to commit when the workspace is on the wrong branch — nothing is staged, nothing is committed, HEAD does not move", async () => {
  const dir = await makeRepo();
  const { stdout: before } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });

  await execFileAsync("git", ["checkout", "-b", "agent-own-branch"], { cwd: dir });
  await writeFile(join(dir, "file.txt"), "changed by the agent on the wrong branch\n"); // a real, uncommitted diff

  await assert.rejects(
    () => commitAllLocal(dir, "should never land", "main", new AbortController().signal),
    BranchMismatchError,
  );

  // Nothing was staged or committed — the working-tree change is still there, uncommitted, and HEAD
  // on the (wrong) branch is exactly where it was before this call.
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir });
  assert.ok(status.includes("file.txt"), "the uncommitted change must still be sitting in the working tree, not swept into a commit");
  const { stdout: after } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  assert.equal(after.trim(), before.trim(), "HEAD on the wrong branch must not have moved");
});

test("commitAllLocal: commits normally, and reports real git evidence, when the workspace is on the expected branch", async () => {
  const dir = await makeRepo();
  await writeFile(join(dir, "file.txt"), "a real change\n");
  await writeFile(join(dir, "new-file.txt"), "brand new\n");

  const result = await commitAllLocal(dir, "a real commit", "main", new AbortController().signal);

  assert.deepEqual(result.changedFiles.sort(), ["file.txt", "new-file.txt"]);
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  assert.equal(result.commitSha, head.trim());
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir });
  assert.equal(status.trim(), "", "the working tree must be clean after a real commit");
});

// ---------------------------------------------------------------------------
// Evidence integrity — item 9.E: the staged-file list is real git evidence,
// never an invented "only files mentioned in the prompt" heuristic, and an
// unrelated file left behind by the toolchain is at least made visible
// rather than silently disappearing into the commit — see GAP-019.
// ---------------------------------------------------------------------------

test("commitAllLocal: an unrelated generated file the task never mentioned is still committed (git add -A, unchanged), but is now visible in changedFiles rather than silent", async () => {
  const dir = await makeRepo();
  await writeFile(join(dir, "file.txt"), "the real intended change\n");
  await writeFile(join(dir, "package-lock.json"), '{"generated": "by npm install, not asked for"}\n');

  const result = await commitAllLocal(dir, "task commit", "main", new AbortController().signal);

  assert.ok(result.changedFiles.includes("package-lock.json"), "not filtered out — a stack-agnostic exclusion heuristic was deliberately not built");
  assert.ok(result.changedFiles.includes("file.txt"));
  assert.equal(result.changedFiles.length, 2, "both files are visible in the evidence a report/PR description can now show");
});

test("commitAllLocal: a rename is reported by its new path, not the old one — matching what a diff/PR would actually show as changed", async () => {
  const dir = await makeRepo();
  await execFileAsync("git", ["mv", "file.txt", "renamed.txt"], { cwd: dir });

  const result = await commitAllLocal(dir, "rename", "main", new AbortController().signal);
  assert.deepEqual(result.changedFiles, ["renamed.txt"]);
});

test("commitAllLocal: nothing to commit is still a branch-safe no-op — idempotent, returns current HEAD, empty changedFiles", async () => {
  const dir = await makeRepo();
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });

  const result = await commitAllLocal(dir, "no-op", "main", new AbortController().signal);
  assert.equal(result.commitSha, head.trim());
  assert.deepEqual(result.changedFiles, []);
});

// ---------------------------------------------------------------------------
// getCurrentBranch / hasNoRepositoryChanges — sanity, unchanged behavior
// ---------------------------------------------------------------------------

test("getCurrentBranch: reflects a real checkout, not a cached/assumed value", async () => {
  const dir = await makeRepo();
  assert.equal(await getCurrentBranch(dir, new AbortController().signal), "main");
  await execFileAsync("git", ["checkout", "-b", "other"], { cwd: dir });
  assert.equal(await getCurrentBranch(dir, new AbortController().signal), "other");
});

test("hasNoRepositoryChanges: true only when the working tree is clean AND HEAD still equals baseCommit", async () => {
  const dir = await makeRepo();
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  const baseCommit = head.trim();

  assert.equal(await hasNoRepositoryChanges(dir, baseCommit, new AbortController().signal), true);

  await writeFile(join(dir, "file.txt"), "dirty\n");
  assert.equal(await hasNoRepositoryChanges(dir, baseCommit, new AbortController().signal), false);
});
