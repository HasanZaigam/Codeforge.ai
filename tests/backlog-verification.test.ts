import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAnalysisOutput } from "../src/backlog/analysis-schema.js";
import { assessClaims, buildAssessment } from "../src/backlog/evidence.js";
import { ANALYSIS_VERIFICATION_DISABLED, applyVerification, planVerification, runVerification, type VerificationPolicy } from "../src/backlog/verification.js";
import type { AnalysisClaim, EvidenceAssessment, VerificationRequirement } from "../src/backlog/backlog-types.js";
import type { Project } from "../src/domain/types.js";
import { json, setupBacklogHarness, validAnalysis } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.3 — the platform-owned verification SEAM (GAP-033). Claim → required verification → platform
 * verification executor → CHECK_RESULT evidence. The seam reuses the existing approved-check machinery; it is
 * DISABLED for production analysis; the model can never name a command; every result is bound to a revision.
 * GAP-033 stays open: nothing here makes production analysis execute anything.
 */

const run = promisify(execFile);
const behaviour = (statement = "OTP throttling works correctly."): AnalysisClaim => ({ statement, kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" });
const existence: AnalysisClaim = { statement: "otpThrottle.ts exists.", kind: "FILE_EXISTS", path: "a.ts", searchTerms: [], confidence: "high" };

function project(commands: Project["commands"]): Project {
  return { id: "p", name: "P", commands } as Project;
}

/** A real git workspace at a known commit whose `test` command records that it ran. */
async function workspace(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "verif-"));
  await writeFile(join(dir, "marker.js"), script);
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x"], { cwd: dir });
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  return { dir, sha, ran: () => (existsSync(join(dir, "ran.txt")) ? readFileSync(join(dir, "ran.txt"), "utf8").trim().split("\n").length : 0) };
}
const RECORD = 'require("fs").appendFileSync("ran.txt", "x\\n");';
const enabled = (allowedChecks: VerificationPolicy["allowedChecks"] = ["test"]): VerificationPolicy => ({ allowExecution: true, allowedChecks, maxCheckMs: 20_000 });
const signal = new AbortController().signal;

const baseAssessment = (claims: AnalysisClaim[]): EvidenceAssessment => ({
  ...buildAssessment([], assessClaims(claims, claims.map(() => ({ file: null, matches: [], searched: true })), "complete"), "high", { listing: "complete", filesRead: 0, bytesRead: 0, filesSkipped: [], limits: { maxFiles: 12, maxFileBytes: 65536, maxTotalBytes: 262144 } }),
  verification: planVerification(claims, project({ test: "node marker.js" })),
});

test("planVerification: only BEHAVIOR claims, only for an approved configured check, always `not_run` under the production policy", () => {
  const claims = [existence, behaviour(), { ...behaviour("Other"), kind: "BEHAVIOR_INCORRECT" as const }];
  const plan = planVerification(claims, project({ test: "npm test" }));
  assert.deepEqual(plan.map((p) => [p.claimIndex, p.checkId, p.state]), [[1, "test", "not_run"], [2, "test", "not_run"]]);
  assert.match(plan[0]!.reason, /read-only by policy.*nothing was run/s);
  assert.deepEqual(planVerification(claims, project({})), [], "no configured `test` check ⇒ nothing to plan (never an invented command)");
  assert.deepEqual(planVerification(claims, project({ build: "npm run build" })), [], "only the `test` check bears on behaviour");
  assert.deepEqual(planVerification([existence], project({ test: "npm test" })), []);
});

test("production policy: the runner executes NOTHING even when asked — no process is spawned", async () => {
  const ws = await workspace(RECORD);
  const plan = planVerification([behaviour()], project({ test: "node marker.js" }));
  const runs = await runVerification(plan, ANALYSIS_VERIFICATION_DISABLED, { project: project({ test: "node marker.js" }), workspacePath: ws.dir, revision: ws.sha, signal });
  assert.equal(runs[0]!.state, "not_run");
  assert.equal(runs[0]!.evidence, null);
  assert.equal(ws.ran(), 0, "the configured command never ran");
});

test("an enabled policy runs the project's OWN configured check once, bound to the exact revision, and returns CHECK_RESULT evidence", async () => {
  const ws = await workspace(RECORD);
  const proj = project({ test: "node marker.js" });
  const claims = [behaviour("A"), behaviour("B")];
  const plan = planVerification(claims, proj, enabled());
  const runs = await runVerification(plan, enabled(), { project: proj, workspacePath: ws.dir, revision: ws.sha, signal });
  assert.equal(ws.ran(), 1, "one execution serves both claims that need the same check");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]!.claimIndexes, [0, 1]);
  assert.equal(runs[0]!.state, "passed");
  assert.equal(runs[0]!.evidence!.command, "node marker.js", "the command is the project's configured one, looked up by check name");
  assert.equal(runs[0]!.evidence!.commitSha, ws.sha);
});

test("applyVerification adds CHECK_RESULT evidence but NEVER upgrades a behaviour claim: 'the code contains X' ≠ 'the configured test passed'", async () => {
  const ws = await workspace(RECORD);
  const proj = project({ test: "node marker.js" });
  const claims = [behaviour()];
  const before = baseAssessment(claims);
  assert.equal(before.claims[0]!.status, "UNRESOLVED");
  const runs = await runVerification(before.verification!, enabled(), { project: proj, workspacePath: ws.dir, revision: ws.sha, signal });
  const after = applyVerification(before, runs, ws.sha);

  const check = after.evidence.find((e) => e.type === "CHECK_RESULT")!;
  assert.equal(check.source, "platform_check");
  assert.equal(check.revision, ws.sha);
  assert.match(check.detail!, /test: passed \(exit 0\)/);
  assert.equal(after.verification![0]!.state, "passed");
  assert.equal(after.verification![0]!.evidenceId, check.id);
  assert.equal(after.claims[0]!.status, "UNRESOLVED", "a passing whole-project check does not settle a specific claim");
  assert.equal(after.claims[0]!.establishes, "nothing");
  assert.match(after.claims[0]!.reason, /not a test of this claim, so it does not settle it/);
  assert.ok(after.claims[0]!.evidenceIds.includes(check.id));
  // Inputs are not mutated.
  assert.equal(before.evidence.some((e) => e.type === "CHECK_RESULT"), false);
});

test("a failing check is recorded as failed (also without contradicting the claim); a timeout is recorded as timed_out", async () => {
  const failing = await workspace('process.exit(3);');
  const proj = project({ test: "node marker.js" });
  const before = baseAssessment([behaviour()]);
  const failedRuns = await runVerification(before.verification!, enabled(), { project: proj, workspacePath: failing.dir, revision: failing.sha, signal });
  const failed = applyVerification(before, failedRuns, failing.sha);
  assert.equal(failed.verification![0]!.state, "failed");
  assert.match(failed.evidence.find((e) => e.type === "CHECK_RESULT")!.detail!, /failed \(exit 3\)/);
  assert.equal(failed.claims[0]!.status, "UNRESOLVED");

  const slow = await workspace("setTimeout(() => {}, 30000);");
  const slowRuns = await runVerification(before.verification!, enabled(), { project: proj, workspacePath: slow.dir, revision: slow.sha, signal, checkTimeoutMsOverride: 300 });
  assert.equal(slowRuns[0]!.state, "timed_out", "the existing check timeout applies");
});

test("cancellation applies: an aborted signal stops the check and rejects (existing CancellationError machinery)", async () => {
  const ws = await workspace("setTimeout(() => {}, 30000);");
  const ac = new AbortController();
  const promise = runVerification(planVerification([behaviour()], project({ test: "node marker.js" }), enabled()), enabled(), { project: project({ test: "node marker.js" }), workspacePath: ws.dir, revision: ws.sha, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(promise, /cancel/i);
});

test("revision binding: a workspace that is not at the analysed revision is refused BEFORE anything runs", async () => {
  const ws = await workspace(RECORD);
  const runs = await runVerification(planVerification([behaviour()], project({ test: "node marker.js" }), enabled()), enabled(), {
    project: project({ test: "node marker.js" }),
    workspacePath: ws.dir,
    revision: "f".repeat(40),
    signal,
  });
  assert.equal(runs[0]!.state, "rejected");
  assert.match(runs[0]!.reason, /not the analysed revision/);
  assert.equal(ws.ran(), 0);
});

test("ARBITRARY COMMANDS CANNOT RUN: an injected check id / command is refused before any process starts", async () => {
  const ws = await workspace(RECORD);
  const proj = project({ test: "node marker.js" });
  const evilRequirement = (checkId: string): VerificationRequirement => ({ claimIndex: 0, checkId: checkId as never, state: "not_run", reason: "", evidenceId: null });
  for (const evil of ["rm -rf /", "node marker.js; touch pwned", "../../bin/sh", "TEST", "deploy"]) {
    const runs = await runVerification([evilRequirement(evil)], enabled(["test", "build", "lint", "typecheck"]), { project: proj, workspacePath: ws.dir, revision: ws.sha, signal });
    assert.equal(runs[0]!.state, "rejected", evil);
    assert.equal(runs[0]!.evidence, null);
  }
  assert.equal(ws.ran(), 0);
  assert.equal(existsSync(join(ws.dir, "pwned")), false);
  // A known check the project has not configured is also refused; so is one policy does not allow.
  assert.equal((await runVerification([evilRequirement("lint")], enabled(["lint"]), { project: proj, workspacePath: ws.dir, revision: ws.sha, signal }))[0]!.state, "rejected");
  assert.equal((await runVerification([evilRequirement("test")], enabled(["build"]), { project: proj, workspacePath: ws.dir, revision: ws.sha, signal }))[0]!.state, "rejected");
  assert.equal(ws.ran(), 0);
});

test("the MODEL cannot request verification: `verification`/`command`/`checkId` in its output make it malformed and nothing runs", async () => {
  for (const extra of [{ verification: { checkId: "test" } }, { command: "rm -rf /" }, { runTests: true }]) {
    const out = parseAnalysisOutput(json(validAnalysis(extra)));
    assert.equal(out.ok, false, JSON.stringify(extra));
  }
  const inClaim = parseAnalysisOutput(json(validAnalysis({ claims: [{ statement: "x", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp"], confidence: "high", verify: "npm test", command: "rm -rf /" }] })));
  assert.equal(inClaim.ok, false);
});

test("E2E through the real worker: a behaviour claim records a `not_run` verification requirement and executes nothing (project has a configured test command)", async () => {
  const h = await setupBacklogHarness("verif-e2e", {
    respond: () => json(validAnalysis({ claims: [{ statement: "OTP limiter works correctly.", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "limit"], confidence: "high" }] })),
  });
  try {
    const item = h.item("OTP", "B-1");
    await h.analyze(item.id);
    const a = h.platform.backlogAnalyses.findLatestForItem(item.id)!.platformChecks!.assessment!;
    assert.equal(a.verification!.length, 1);
    assert.equal(a.verification![0]!.state, "not_run");
    assert.equal(a.verification![0]!.checkId, "test");
    assert.equal(a.evidence.some((e) => e.type === "CHECK_RESULT"), false);
    assert.equal(a.claims[0]!.status, "UNRESOLVED");
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
});

test("revision binding holds AFTER the run too: a check that moves HEAD is discarded, not reported against the old revision", async () => {
  // The check itself makes a new commit, so by the time it exits the workspace is no longer at the analysed revision.
  const ws = await workspace(
    'const { execFileSync } = require("child_process");\nexecFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "moved"]);\n',
  );
  const proj = project({ test: "node marker.js" });
  const before = baseAssessment([behaviour()]);
  const runs = await runVerification(before.verification!, enabled(), { project: proj, workspacePath: ws.dir, revision: ws.sha, signal });
  assert.equal(runs[0]!.state, "rejected");
  assert.match(runs[0]!.reason, /moved during verification/);
  const after = applyVerification(before, runs, ws.sha);
  assert.equal(after.evidence.some((e) => e.type === "CHECK_RESULT"), false, "no evidence bound to a revision the check did not run against");
});
