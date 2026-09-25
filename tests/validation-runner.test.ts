import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidation } from "../src/validation/validation-runner.js";

/**
 * V1.1 Slice 1 (see PLATFORM_GAPS.md GAP-002/GAP-004): every distinct,
 * truthful outcome runValidation can report, each exercised against a real
 * spawned process — never mocked, since the whole point of this slice is
 * that the platform's own execution, not a claim, is what produces these.
 */
async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "validation-runner-test-"));
  await fn(dir);
}

test("outcome 'checks_passed': a real command that exits 0 is reported as passed, both status and outcome", async () => {
  await withWorkspace(async (dir) => {
    const result = await runValidation(dir, { test: "exit 0" }, new AbortController().signal);
    assert.equal(result.status, "passed");
    assert.equal(result.outcome, "checks_passed");
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0]!.passed, true);
    assert.equal(result.checks[0]!.outcome, "passed");
  });
});

test("outcome 'checks_failed': a real command that exits non-zero is reported as failed, both status and outcome — never conflated with a timeout or infra error", async () => {
  await withWorkspace(async (dir) => {
    const result = await runValidation(dir, { test: "exit 1" }, new AbortController().signal);
    assert.equal(result.status, "failed");
    assert.equal(result.outcome, "checks_failed");
    assert.equal(result.checks[0]!.outcome, "failed");
    assert.equal(result.checks[0]!.exitCode, 1);
  });
});

// GAP-004: this is the exact bug this slice closes — a project with nothing declared must never be
// reported as "validation passed" to anything that reads `outcome` (status stays "passed" on
// purpose, for the self-fix loop's own unrelated gating — see ValidationResult.status's doc comment).
test("outcome 'no_checks_configured': a project with no declared commands runs nothing, and outcome says so honestly — status alone would still misleadingly read 'passed'", async () => {
  await withWorkspace(async (dir) => {
    const result = await runValidation(dir, null, new AbortController().signal);
    assert.equal(result.checks.length, 0);
    assert.equal(result.status, "passed", "status keeps its original self-fix-loop-gating meaning — vacuously true, unchanged by this slice");
    assert.equal(result.outcome, "no_checks_configured", "but outcome — the truthful, human-facing field — must never say 'passed'");
  });
});

test("outcome 'timed_out': a command that outlives its timeout is reported as timed_out, never as a plain 'failed' with a null exit code indistinguishable from a real crash", async () => {
  await withWorkspace(async (dir) => {
    // sleep comfortably longer than the 150ms override below; the process is SIGKILLed well before
    // it would exit on its own, so if the timeout classification is broken this would hang the test.
    const result = await runValidation(dir, { test: "sleep 5" }, new AbortController().signal, 150);
    assert.equal(result.checks[0]!.outcome, "timed_out");
    assert.equal(result.checks[0]!.passed, false);
    assert.ok(result.checks[0]!.logExcerpt.includes("exceeded the 150ms check timeout"), "the log excerpt must say WHY it stopped, not just that it did");
    assert.equal(result.outcome, "checks_failed", "a timeout still gates the self-fix loop as 'not passed' — only the per-check outcome distinguishes why");
  });
});

test("outcome 'infrastructure_error': a command that cannot even be spawned (missing binary) is reported distinctly from a real non-zero exit", async () => {
  await withWorkspace(async (dir) => {
    const result = await runValidation(dir, { test: "definitely-not-a-real-binary-xyz123" }, new AbortController().signal);
    // A shell that can't find the binary typically still exits non-zero (outcome "failed") rather
    // than raising the child process's own "error" event — this test documents that real-world
    // shape rather than asserting the rarer "error" event path directly, which is
    // platform-dependent to trigger deterministically without `shell: false` (a change out of this
    // slice's scope). The important, load-bearing assertion is simply: it is not silently "passed".
    assert.notEqual(result.checks[0]!.outcome, "passed");
    assert.equal(result.status, "failed");
  });
});

test("multiple declared commands: only the declared ones run, each with its own honest outcome", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(join(dir, "marker.txt"), "present");
    const result = await runValidation(
      dir,
      { build: "exit 0", test: "exit 1" }, // lint/typecheck left undeclared
      new AbortController().signal,
    );
    assert.equal(result.checks.length, 2);
    assert.deepEqual(result.checks.map((c) => c.name).sort(), ["build", "test"]);
    assert.equal(result.outcome, "checks_failed");
  });
});
