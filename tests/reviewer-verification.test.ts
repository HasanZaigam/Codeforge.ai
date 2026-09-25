import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeApprovedVerification, resolveApprovedVerificationChecks } from "../src/review/reviewer-verification.js";
import type { Project } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * V1.1 Slice 2 — real git + real spawned processes, no mocking, for the one
 * path by which a Reviewer's "EXECUTED" claim can become platform truth. See
 * PLATFORM_GAPS.md GAP-016 and /docs/SECURITY_ARCHITECTURE.md "AI may
 * request verification. CodeForge owns verification evidence."
 */

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    tenantId: "default",
    ownerId: "user-1",
    name: "Fixture",
    repoUrl: "/tmp/does-not-matter",
    defaultBranch: "main",
    codingEngine: "fixture",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-verification-test-"));
  await execFileAsync("git", ["init", "-b", "task/abc123"], { cwd: dir });
  await writeFile(join(dir, "test.js"), "");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", "initial"], { cwd: dir });
  return dir;
}

// ---------------------------------------------------------------------------
// Policy — resolveApprovedVerificationChecks
// ---------------------------------------------------------------------------

test("resolveApprovedVerificationChecks: only lists check names the project actually configured a command for", () => {
  const project = makeProject({ commands: { test: "npm test", build: "npm run build" } });
  assert.deepEqual(resolveApprovedVerificationChecks(project).sort(), ["build", "test"]);
});

test("resolveApprovedVerificationChecks: empty for a project with no commands at all", () => {
  const project = makeProject({ commands: null });
  assert.deepEqual(resolveApprovedVerificationChecks(project), []);
});

// ---------------------------------------------------------------------------
// B/C/D — approved check execution (real process, real outcomes)
// ---------------------------------------------------------------------------

test("B: an approved check that passes produces outcome 'passed' with real exit code, command, and commit binding", async () => {
  const dir = await makeRepo();
  await writeFile(join(dir, "test.js"), "process.exit(0);");
  const project = makeProject({ commands: { test: "node test.js" } });
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });

  const evidence = await executeApprovedVerification({
    workspacePath: dir,
    expectedBranch: "task/abc123",
    project,
    request: { checkId: "test", purpose: "confirm the fix" },
    signal: new AbortController().signal,
  });

  assert.equal(evidence.outcome, "passed");
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.command, "node test.js");
  assert.equal(evidence.checkId, "test");
  assert.equal(evidence.actualBranch, "task/abc123");
  assert.equal(evidence.commitSha, head.trim());
  assert.equal(evidence.rejectionReason, null);
  assert.ok(evidence.durationMs !== null && evidence.durationMs >= 0);
});

test("C: an approved check that fails produces outcome 'failed' with the real exit code and real stdout/stderr captured", async () => {
  const dir = await makeRepo();
  await writeFile(join(dir, "test.js"), "console.error('assertion failed: expected 5 got 4'); process.exit(1);");
  const project = makeProject({ commands: { test: "node test.js" } });

  const evidence = await executeApprovedVerification({
    workspacePath: dir,
    expectedBranch: "task/abc123",
    project,
    request: { checkId: "test", purpose: null },
    signal: new AbortController().signal,
  });

  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.exitCode, 1);
  assert.ok(evidence.logExcerpt?.includes("assertion failed"), "real stderr must be captured, not fabricated");
});

test("D: an approved check that runs past its timeout produces outcome 'timed_out', distinct from a real failure", async () => {
  const dir = await makeRepo();
  await writeFile(join(dir, "test.js"), "setTimeout(() => {}, 60_000);");
  const project = makeProject({ commands: { test: "node test.js" } });

  const evidence = await executeApprovedVerification({
    workspacePath: dir,
    expectedBranch: "task/abc123",
    project,
    request: { checkId: "test", purpose: null },
    signal: new AbortController().signal,
    checkTimeoutMsOverride: 150,
  });

  assert.equal(evidence.outcome, "timed_out");
});

// ---------------------------------------------------------------------------
// F/G — bounded command policy: unknown/unconfigured checks are rejected,
// nothing is ever spawned for them
// ---------------------------------------------------------------------------

test("F: an unknown check id is rejected — no command executes, a clear structured reason is recorded, no exit code/output is fabricated", async () => {
  const dir = await makeRepo();
  const project = makeProject({ commands: { test: "node test.js" } });

  const evidence = await executeApprovedVerification({
    workspacePath: dir,
    expectedBranch: "task/abc123",
    project,
    request: { checkId: "some-arbitrary-check", purpose: null },
    signal: new AbortController().signal,
  });

  assert.equal(evidence.outcome, "rejected");
  assert.ok(evidence.rejectionReason?.includes("test"), "the reason should name what IS actually approved");
  assert.equal(evidence.command, null);
  assert.equal(evidence.exitCode, null);
  assert.equal(evidence.actualBranch, null, "nothing was executed, so nothing was read from the workspace");
  assert.equal(evidence.commitSha, null);
});

test("G: a known check name the project never configured a command for is rejected exactly the same way — never falls back to inventing a command", async () => {
  const dir = await makeRepo();
  const project = makeProject({ commands: { test: "node test.js" } }); // no `build` configured

  const evidence = await executeApprovedVerification({
    workspacePath: dir,
    expectedBranch: "task/abc123",
    project,
    request: { checkId: "build", purpose: null },
    signal: new AbortController().signal,
  });

  assert.equal(evidence.outcome, "rejected");
  assert.equal(evidence.command, null);
});

test("no commands configured at all: every request is rejected, with a reason that says so rather than naming an empty list unhelpfully", async () => {
  const dir = await makeRepo();
  const project = makeProject({ commands: null });

  const evidence = await executeApprovedVerification({
    workspacePath: dir,
    expectedBranch: "task/abc123",
    project,
    request: { checkId: "test", purpose: null },
    signal: new AbortController().signal,
  });

  assert.equal(evidence.outcome, "rejected");
  assert.ok(evidence.rejectionReason?.includes("no"));
});

// ---------------------------------------------------------------------------
// I — cancellation during verification
// ---------------------------------------------------------------------------

test("I: cancellation during verification terminates the real process rather than letting it run to completion", async () => {
  const dir = await makeRepo();
  await writeFile(join(dir, "test.js"), "setTimeout(() => {}, 60_000);");
  const project = makeProject({ commands: { test: "node test.js" } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(
    () =>
      executeApprovedVerification({
        workspacePath: dir,
        expectedBranch: "task/abc123",
        project,
        request: { checkId: "test", purpose: null },
        signal: controller.signal,
      }),
    (err: unknown) => err instanceof Error && err.name === "CancellationError",
  );
});
