import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApprovedClaimCheck } from "../src/domain/types.js";
import type { AnalysisClaim } from "../src/backlog/backlog-types.js";
import { classifyClaim, evaluateCompatibility } from "../src/backlog/claim-semantics.js";
import { bindClaimsToChecks, verificationCandidates } from "../src/backlog/verification.js";
import { fakeStructure, json, setupBacklogHarness, validAnalysis } from "./helpers/backlog-harness.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 4A.7 — a passing check is not enough. CHECK_VERIFIED needs a check whose DECLARED scope covers what the claim asserts.
 * The check below is the real Jinvani `otp-send-throttle`: a unit test of `evaluateOtpThrottle` (mechanism level).
 */
const THROTTLE_UNIT: ApprovedClaimCheck = {
  id: "otp-send-throttle",
  description: "unit test of evaluateOtpThrottle",
  command: "node throttle-check.js",
  application: "backend",
  establishes: {
    behavior: "evaluateOtpThrottle enforces a 30 s cooldown and a per-window send cap",
    claimTerms: [["otp"], ["limit", "throttle", "cooldown", "cap"]],
    claimKinds: ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"],
    scope: { level: "mechanism", application: "backend", mechanism: "evaluateOtpThrottle", behaviors: [{ id: "cooldown", terms: ["cooldown", "wait"] }, { id: "window-cap", terms: ["cap", "window", "limit", "limits", "limited", "throttle", "throttles", "throttled"] }] },
  },
  passMeans: "behavior_holds",
};
const FLOW_CHECK: ApprovedClaimCheck = { ...THROTTLE_UNIT, id: "otp-request-route", establishes: { ...THROTTLE_UNIT.establishes, scope: { ...THROTTLE_UNIT.establishes.scope!, level: "flow", entryPoint: "POST /request-otp" } } };
const c = (statement: string, over: Partial<AnalysisClaim> = {}): AnalysisClaim => ({ statement, kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "throttle"], confidence: "high", ...over });
const verdict = (claim: AnalysisClaim, check = THROTTLE_UNIT) => evaluateCompatibility(check, claim, true);

test("classification is conservative: wiring and existence beat behaviour; unknown wording is UNSUPPORTED", () => {
  assert.equal(classifyClaim(c("The auth service imports and is expected to use the throttling logic.")).claimClass, "WIRING");
  assert.equal(classifyClaim(c("AuthService invokes evaluateOtpThrottle.")).claimClass, "WIRING");
  assert.equal(classifyClaim(c("The OTP throttle function does not exist.")).claimClass, "EXISTENCE");
  assert.equal(classifyClaim(c("POST /request-otp rejects a second send within the cooldown.")).claimClass, "FLOW");
  assert.equal(classifyClaim(c("The login flow does not invoke OTP throttling.")).claimClass, "WIRING");
  assert.equal(classifyClaim(c("evaluateOtpThrottle rejects sends inside the cooldown.")).claimClass, "BEHAVIOR");
  assert.equal(classifyClaim(c("Things are nice.")).claimClass, "UNSUPPORTED");
  assert.deepEqual([classifyClaim(c("POST /request-otp/. is slow")).entryPoint, classifyClaim(c("no limit")).negative], ["POST /request-otp", true]);
});

test("GOLDEN NEGATIVE: the exact previous false positive — a passing throttle unit test is RELEVANT but NOT SUFFICIENT for an auth-service wiring claim", () => {
  const claim = c("The auth service imports and is expected to use the throttling logic.", { searchTerms: ["otp", "throttle", "service", "import"] });
  const v = verdict(claim);
  assert.equal(v.relevance, "relevant", "topic overlap makes it a candidate…");
  assert.equal(v.sufficiency, "insufficient", "…but its declared scope does not cover wiring");
  assert.match(v.reason, /wired/);
  assert.deepEqual(bindClaimsToChecks([claim], [THROTTLE_UNIT]), [], "so it can never be bound, run or verified");
  assert.equal(verificationCandidates([claim], [THROTTLE_UNIT])[0]!.sufficiency, "insufficient");
});

test("SUFFICIENT: a behaviour claim that names the mechanism and a declared behaviour", () => {
  const v = verdict(c("evaluateOtpThrottle enforces a cooldown between OTP sends."));
  assert.deepEqual([v.relevance, v.sufficiency, v.claimClass], ["relevant", "sufficient", "BEHAVIOR"]);
  assert.equal(bindClaimsToChecks([c("evaluateOtpThrottle enforces a cooldown between OTP sends.")], [THROTTLE_UNIT]).length, 1);
});

test("mechanism-level check + FLOW claim (positive or negative) stays insufficient — a unit pass says nothing about the route", () => {
  for (const s of ["POST /request-otp enforces the OTP throttle.", "POST /request-otp does not enforce OTP throttling.", "The login flow does not enforce OTP throttling."]) {
    assert.equal(verdict(c(s, { kind: s.includes("not") ? "BEHAVIOR_INCORRECT" : "BEHAVIOR_CORRECT" })).sufficiency, "insufficient", s);
  }
});

test("flow-level check: only the claim's EXPLICIT matching entry point is sufficient (wrong or missing entry point rejected)", () => {
  assert.equal(verdict(c("POST /request-otp is throttled with a cooldown."), FLOW_CHECK).sufficiency, "sufficient");
  assert.equal(verdict(c("POST /verify-otp is throttled with a cooldown."), FLOW_CHECK).sufficiency, "insufficient", "wrong entry point");
  assert.equal(verdict(c("PATCH /request-otp is throttled with a cooldown."), FLOW_CHECK).sufficiency, "insufficient", "wrong method");
  assert.equal(verdict(c("The OTP request endpoint is throttled with a cooldown."), FLOW_CHECK).sufficiency, "insufficient", "entry point not named");
});

test("wrong application, wrong claim kind, unrelated claim, no declared scope, mechanism not named, no declared behaviour — all insufficient", () => {
  assert.equal(verdict(c("The mobile client's evaluateOtpThrottle enforces a cooldown.")).sufficiency, "insufficient", "wrong application");
  assert.equal(evaluateCompatibility(THROTTLE_UNIT, c("evaluateOtpThrottle enforces a cooldown.", { kind: "FEATURE_PRESENT" }), true).sufficiency, "insufficient", "wrong claim kind");
  const unrelated = verdict(c("Video playback resumes after a pause.", { searchTerms: ["video"] }));
  assert.deepEqual([unrelated.relevance, unrelated.sufficiency], ["not_relevant", "insufficient"]);
  const noScope = { ...THROTTLE_UNIT, establishes: { ...THROTTLE_UNIT.establishes, scope: undefined } };
  assert.match(verdict(c("evaluateOtpThrottle enforces a cooldown."), noScope).reason, /no semantic scope/);
  assert.match(verdict(c("The OTP throttle enforces a cooldown.")).reason, /does not name the mechanism/);
  assert.match(verdict(c("evaluateOtpThrottle formats phone numbers nicely.", { searchTerms: ["otp", "throttle"] })).reason, /asserts nothing this check declares|does not name/);
  assert.equal(evaluateCompatibility(THROTTLE_UNIT, c("evaluateOtpThrottle enforces a cooldown."), false).sufficiency, "insufficient", "application incompatible");
  const claimKindsOnly = { ...THROTTLE_UNIT, establishes: { ...THROTTLE_UNIT.establishes, claimKinds: ["BEHAVIOR_INCORRECT" as const] } };
  assert.equal(verdict(c("evaluateOtpThrottle enforces a cooldown."), claimKindsOnly).sufficiency, "insufficient");
});

test("topic overlap alone never authorizes: identical topic words, different assertion", () => {
  const same = { searchTerms: ["otp", "throttle", "cooldown"] };
  assert.deepEqual(bindClaimsToChecks([c("OTP throttle cooldown constants are declared in otpThrottle.ts.", same)], [THROTTLE_UNIT]), []);
  assert.deepEqual(bindClaimsToChecks([c("OTP throttling is expected to apply to the cooldown.", same)], [THROTTLE_UNIT]), []);
});

// ---------------------------------------------------------------------------
// Worker level: an insufficient (claim, check) pair is never queued, never run, and a forged pass never verifies
// ---------------------------------------------------------------------------

const run = promisify(execFile);
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "csem-"));
  const git = (...a: string[]) => run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  await writeFile(join(dir, "throttle-check.js"), `require("fs").appendFileSync("ran.txt","x\\n");console.log("ok");\n`);
  await git("init", "-b", "main");
  await git("add", "-A");
  await git("commit", "-m", "one");
  return { dir, sha: (await git("rev-parse", "HEAD")).stdout.trim(), git };
}

test("WORKER: the insufficient auth-service claim queues NOTHING; a forged job for the pair is refused before running; a forged passed record does not verify", async () => {
  const r = await repo();
  const h = await setupBacklogHarness("csem-neg", {
    structure: fakeStructure({ "throttle-check.js": "x" }, { revision: r.sha }),
    respond: () => json(validAnalysis({ claims: [{ statement: "The auth service imports and is expected to use the throttling logic.", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" }], candidateFiles: [] })),
    platform: { verification: { workspaceFactory: async () => ({ dir: r.dir, head: r.sha, dispose: async () => {} }) } },
  });
  try {
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [THROTTLE_UNIT] }, new Date().toISOString());
    const item = h.item("Auth throttling", "B-1", "Check the auth service throttles OTP.");
    await h.analyze(item.id);
    const detail = h.services.backlog.getItem(item.id, h.owner.id);
    const asm = detail.latestAnalysis!.platformChecks!.assessment!;
    assert.deepEqual(asm.verification, [], "no requirement: nothing is bound");
    assert.equal(asm.verificationCandidates![0]!.sufficiency, "insufficient");
    assert.equal(asm.verificationCandidates![0]!.checkId, "otp-send-throttle");
    const q = h.services.claimVerifier.request(item.id, h.owner.id);
    assert.deepEqual(q.jobs, []);

    // Forge a job for the pair directly in the database: the executor refuses before any workspace/process.
    const analysis = h.platform.backlogAnalyses.findLatestSucceededForItem(item.id)!;
    const cand = asm.verificationCandidates![0]!;
    h.platform.claimVerificationJobs.enqueue({ id: "forged", backlogItemId: item.id, projectId: h.project.id, analysisId: analysis.id, claimId: cand.claimId, claimIndex: 0, checkId: cand.checkId, checkFingerprint: "x", revision: r.sha, requestedBy: h.owner.id, maxAttempts: 1, now: new Date().toISOString() });
    await h.platform.claimVerificationRunner.drain();
    assert.equal(h.platform.claimVerificationJobs.findById("forged")!.status, "FAILED");
    assert.equal(h.platform.db.prepare("SELECT COUNT(*) AS n FROM claim_verifications").get()!["n"], 0);

    // Forge a PASSED record for the pair: reconciliation ignores it.
    const { checkFingerprint } = await import("../src/backlog/verification.js");
    h.platform.claimVerifications.insert(h.project.id, { id: "rec", analysisId: analysis.id, claimId: cand.claimId, claimIndex: 0, checkId: cand.checkId, checkFingerprint: checkFingerprint(THROTTLE_UNIT), revision: r.sha, headBefore: r.sha, headAfter: r.sha, state: "passed", exitCode: 0, durationMs: 1, command: THROTTLE_UNIT.command, logExcerpt: null, requestedBy: h.owner.id, createdAt: new Date().toISOString() });
    const after = h.services.backlog.getItem(item.id, h.owner.id);
    assert.equal(after.review.behavior, "BEHAVIOR_UNVERIFIED");
    assert.notEqual(after.latestAnalysis!.platformChecks!.assessment!.reconciliation!.behavior, "CHECK_VERIFIED");
  } finally {
    await h.platform.backgroundRunner.stop();
    h.close();
  }
});

test("GOLDEN POSITIVE (exact real model claim): a mechanism-level check that exercises cooldown and window cap is SUFFICIENT and, through the worker, reaches CHECK_VERIFIED; the same check stays insufficient for the wiring claim beside it", async () => {
  const r = await repo();
  const h = await setupBacklogHarness("csem-pos", {
    structure: fakeStructure({ "throttle-check.js": "x" }, { revision: r.sha }),
    respond: () => json(validAnalysis({ claims: [
      { statement: "The requestOTP function in auth.service.ts invokes evaluateOtpThrottle to enforce throttling.", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" },
      { statement: "The evaluateOtpThrottle function logic evaluates 'cooldown' and 'window_cap' scenarios.", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" },
    ], candidateFiles: [] })),
    platform: { verification: { workspaceFactory: async () => ({ dir: r.dir, head: r.sha, dispose: async () => {} }) } },
  });
  try {
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [THROTTLE_UNIT] }, new Date().toISOString());
    const item = h.item("OTP cooldown", "QA-1", "QA wants to know whether the server enforces a cooldown between OTP sends and a per-window cap.");
    await h.analyze(item.id);
    const q = h.services.claimVerifier.request(item.id, h.owner.id);
    assert.equal(q.jobs.length, 1, "only the behaviour claim is queued; the wiring claim is not");
    assert.equal(q.jobs[0]!.claimIndex, 1);
    await h.platform.claimVerificationRunner.drain();
    const d = h.services.backlog.getItem(item.id, h.owner.id);
    const f = d.latestAnalysis!.platformChecks!.assessment!.reconciliation!.findings;
    assert.equal(f[1]!.outcome, "CHECK_VERIFIED");
    assert.notEqual(f[0]!.outcome, "CHECK_VERIFIED", "the wiring claim is not verified by the same passing check");
    assert.equal(d.review.behavior, "CHECK_VERIFIED");
    assert.equal(d.claimVerifications.length, 1);
    assert.equal(d.claimVerifications[0]!.revision, r.sha);
    // A different revision's result can never verify: move the analysis' recorded revision and the same record stops counting.
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [{ ...THROTTLE_UNIT, description: "edited", establishes: { ...THROTTLE_UNIT.establishes, scope: { ...THROTTLE_UNIT.establishes.scope!, mechanism: "otherFunction" } } }] }, new Date().toISOString());
    assert.equal(h.services.backlog.getItem(item.id, h.owner.id).review.behavior, "BEHAVIOR_UNVERIFIED", "a changed scope invalidates the old result");
  } finally {
    await h.platform.backgroundRunner.stop();
    h.close();
  }
});

test("MUTATION-FOUND GAPS: existence claims, misdeclared mechanism-level entry points, empty flow assertions, candidate listing and check identity", async () => {
  assert.equal(verdict(c("evaluateOtpThrottle exists and defines a cooldown.")).sufficiency, "insufficient", "an existence claim is not a behaviour claim");
  const misdeclared = { ...THROTTLE_UNIT, establishes: { ...THROTTLE_UNIT.establishes, scope: { ...THROTTLE_UNIT.establishes.scope!, entryPoint: "POST /request-otp" } } };
  assert.equal(verdict(c("POST /request-otp is throttled with a cooldown."), misdeclared).sufficiency, "insufficient", "level 'mechanism' wins over a stray entryPoint");
  assert.equal(verdict(c("POST /request-otp is pretty."), FLOW_CHECK).sufficiency, "insufficient", "a flow claim asserting nothing the check declares");
  assert.deepEqual(verificationCandidates([c("Video playback resumes after a pause.", { searchTerms: ["video"] })], [THROTTLE_UNIT]), [], "unrelated checks are not even listed");
  const { checkFingerprint } = await import("../src/backlog/verification.js");
  assert.notEqual(checkFingerprint(THROTTLE_UNIT), checkFingerprint({ ...THROTTLE_UNIT, establishes: { ...THROTTLE_UNIT.establishes, scope: { ...THROTTLE_UNIT.establishes.scope!, mechanism: "other" } } }), "the declared scope is part of the check's identity");
});
