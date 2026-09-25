import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFixVerificationStatus, deriveReproductionStatus, runContractCheck } from "../src/review/bug-fix-verification.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import type { BugFixVerificationContract, Project, VerificationEvidence } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * V1.1 Slice 3 — the deterministic status-derivation layer (see
 * PLATFORM_GAPS.md GAP-016 item 4: "Do not let an LLM decide whether an
 * arbitrary failure means the bug was reproduced"), plus a real end-to-end
 * exercise of `runContractCheck` against the actual buggy-add fixture
 * (`src/cli/fixture-repo.ts`) proving a genuine FAIL -> PASS transition —
 * no mocking of the mechanism under test.
 */

function contract(overrides: Partial<BugFixVerificationContract> = {}): BugFixVerificationContract {
  return { checkId: "test", bugPresentWhenCheckOutcome: "failed", purpose: null, ...overrides };
}

function evidence(outcome: VerificationEvidence["outcome"]): VerificationEvidence {
  return {
    requested: { checkId: "test", purpose: null },
    outcome,
    rejectionReason: outcome === "rejected" ? "not approved" : null,
    checkId: "test",
    command: outcome === "rejected" ? null : "node test.js",
    expectedBranch: "task/abc123",
    actualBranch: outcome === "rejected" ? null : "task/abc123",
    commitSha: outcome === "rejected" ? null : "deadbeef",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null,
    logExcerpt: outcome === "rejected" ? null : "output",
  };
}

// ---------------------------------------------------------------------------
// A/B — reproduction status, the common "bug shows up as a failure" contract
// ---------------------------------------------------------------------------

test("A: expected-failing check that actually FAILS -> BUG_REPRODUCED", () => {
  assert.equal(deriveReproductionStatus(evidence("failed"), contract()), "bug_reproduced");
});

test("B: expected-failing check that actually PASSES -> BUG_NOT_REPRODUCED", () => {
  assert.equal(deriveReproductionStatus(evidence("passed"), contract()), "bug_not_reproduced");
});

// ---------------------------------------------------------------------------
// C/D — fix verification status (the mirror image of reproduction)
// ---------------------------------------------------------------------------

test("C: expected-failing check that now PASSES after implementation -> FIX_VERIFIED", () => {
  assert.equal(deriveFixVerificationStatus(evidence("passed"), contract()), "fix_verified");
});

test("D: expected-failing check that STILL FAILS after implementation -> FIX_NOT_VERIFIED", () => {
  assert.equal(deriveFixVerificationStatus(evidence("failed"), contract()), "fix_not_verified");
});

// ---------------------------------------------------------------------------
// E/F/G — non-pass/fail outcomes pass straight through for BOTH reproduction
// and fix verification — never silently converted into a bug/fix judgment
// ---------------------------------------------------------------------------

test("E: a timeout is never converted into a reproduction/fix judgment — it passes through as its own status", () => {
  assert.equal(deriveReproductionStatus(evidence("timed_out"), contract()), "timed_out");
  assert.equal(deriveFixVerificationStatus(evidence("timed_out"), contract()), "timed_out");
});

test("F: an infrastructure error is never converted into a reproduction/fix judgment", () => {
  assert.equal(deriveReproductionStatus(evidence("infrastructure_error"), contract()), "infrastructure_error");
  assert.equal(deriveFixVerificationStatus(evidence("infrastructure_error"), contract()), "infrastructure_error");
});

test("G: a rejected verification request is never converted into a reproduction/fix judgment", () => {
  assert.equal(deriveReproductionStatus(evidence("rejected"), contract()), "rejected");
  assert.equal(deriveFixVerificationStatus(evidence("rejected"), contract()), "rejected");
});

// ---------------------------------------------------------------------------
// The inverse contract: a check that should currently be PASSING when the
// bug is present (e.g. a regression guard silently green) — proves the
// mapping is genuinely driven by the contract's own field, not a hardcoded
// "failed always means buggy" assumption.
// ---------------------------------------------------------------------------

test("bugPresentWhenCheckOutcome: 'passed' — a check passing IS the bug, failing IS the fix", () => {
  const inverseContract = contract({ bugPresentWhenCheckOutcome: "passed" });
  assert.equal(deriveReproductionStatus(evidence("passed"), inverseContract), "bug_reproduced");
  assert.equal(deriveReproductionStatus(evidence("failed"), inverseContract), "bug_not_reproduced");
  assert.equal(deriveFixVerificationStatus(evidence("failed"), inverseContract), "fix_verified");
  assert.equal(deriveFixVerificationStatus(evidence("passed"), inverseContract), "fix_not_verified");
});

// ---------------------------------------------------------------------------
// Real end-to-end: the actual buggy-add fixture, a real FAIL -> PASS
// transition, real git commits, real spawned `node test.js`
// ---------------------------------------------------------------------------

function makeProject(repoPath: string): Project {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    tenantId: "default",
    ownerId: "user-1",
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: "fixture",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
}

test("real fixture: BUG_REPRODUCED against the buggy fixture, then FIX_VERIFIED once add.js is genuinely corrected, bound to two distinct commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "bug-fix-verification-real-"));
  const repoPath = await createFixtureRepo(root); // add.js subtracts instead of adds — node test.js fails
  const project = makeProject(repoPath);
  const c = contract();
  const signal = new AbortController().signal;

  const before = await runContractCheck({ workspacePath: repoPath, expectedBranch: "main", project, contract: c, signal });
  assert.equal(before.outcome, "failed");
  assert.equal(deriveReproductionStatus(before, c), "bug_reproduced");
  const commitA = before.commitSha;

  // A real fix, a real commit — a genuinely different repository state.
  await writeFile(join(repoPath, "add.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", "fix add()"], { cwd: repoPath });

  const after = await runContractCheck({ workspacePath: repoPath, expectedBranch: "main", project, contract: c, signal });
  assert.equal(after.outcome, "passed");
  assert.equal(deriveFixVerificationStatus(after, c), "fix_verified");
  const commitB = after.commitSha;

  assert.notEqual(commitA, commitB, "reproduction and fix verification must be bound to two distinct, real commits");
});
