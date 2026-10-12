import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimVerifier } from "../src/application/claim-verifier.js";
import { parseAnalysisOutput } from "../src/backlog/analysis-schema.js";
import { assessClaims, buildAssessment } from "../src/backlog/evidence.js";
import { reconcile } from "../src/backlog/reconciliation.js";
import { deriveReview, withVerification } from "../src/backlog/review-state.js";
import { ANALYSIS_VERIFICATION_DISABLED, applyVerificationRecords, bindClaimsToChecks, checkFingerprint, claimIdOf, HUMAN_REQUESTED_VERIFICATION, planVerification, prepareRevisionWorkspace, runClaimVerification } from "../src/backlog/verification.js";
import type { AnalysisClaim, ClaimVerificationRecord, EvidenceAssessment } from "../src/backlog/backlog-types.js";
import type { ApprovedClaimCheck, Project } from "../src/domain/types.js";
import { SourceControlProviderRegistry } from "../src/source-control/source-control-provider.js";
import { LocalGitSourceControlProvider } from "../src/source-control/local-git-source-control-provider.js";
import { UpdateProjectCommandsSchema } from "../src/api/schemas.js";
import { json, setupBacklogHarness, validAnalysis, type BacklogHarness } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.5 — CLAIM-BOUND verification (GAP-033). claim → approved check (bound by the platform) → platform executor →
 * record bound to (claim id, check id + fingerprint, revision) → CHECK_VERIFIED / CHECK_CONTRADICTED only if every binding
 * still holds. Runs real `git` workspaces and real check processes. A generic passing suite never verifies a claim.
 */

const run = promisify(execFile);
const signal = new AbortController().signal;
const REV_B = "b".repeat(40);

const THROTTLE: ApprovedClaimCheck = {
  id: "otp-throttle",
  description: "OTP send throttling: cooldown and per-window cap",
  command: "node throttle-check.js",
  timeoutMs: 20_000,
  requiresFiles: ["throttle.js"],
  establishes: { scope: { level: "flow", application: "backend", mechanism: "evaluateOtpThrottle", entryPoint: "POST /login", behaviors: [{ id: "throttle", terms: ["limit", "limits", "limited", "limiting", "unlimited", "throttle", "throttles", "throttled", "rate", "cooldown", "cap"] }] }, behavior: "OTP sends are throttled (cooldown + window cap)", claimTerms: [["otp"], ["limit", "throttle", "rate", "cooldown"]], claimKinds: ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"] },
  passMeans: "behavior_holds",
};
const claim = (over: Partial<AnalysisClaim>): AnalysisClaim => ({ statement: "OTP sends are rate limited on POST /login.", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "limit"], confidence: "high", ...over });
const project = (commands: Project["commands"]): Project => ({ id: "p", name: "P", commands, sourceControlProvider: "local-git", repoUrl: "x" }) as unknown as Project;

/** A real git repo whose `throttle-check.js` really exercises `throttle.js` — a real check, not a stub that always passes. */
async function makeRepo(opts: { broken?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "claimcheck-"));
  const git = (...a: string[]) => run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  await writeFile(join(dir, "throttle.js"), `exports.allowed = (sends) => ${opts.broken ? "true" : "sends < 3"};\n`);
  await writeFile(join(dir, "throttle-check.js"), `const t = require("./throttle.js");\nrequire("fs").appendFileSync("ran.txt", "x\\n");\nif (!t.allowed(0) || !t.allowed(2) || t.allowed(3)) { console.error("throttle broken"); process.exit(1); }\nconsole.log("throttle ok");\n`);
  await git("init", "-b", "main");
  await git("add", "-A");
  await git("commit", "-m", "one");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  return { dir, sha, git, ran: () => (existsSync(join(dir, "ran.txt")) ? readFileSync(join(dir, "ran.txt"), "utf8").trim().split("\n").length : 0) };
}
const ws = (r: { dir: string; sha: string }) => ({ dir: r.dir, head: r.sha, dispose: async () => {} });

const asRecord = (over: Partial<ClaimVerificationRecord> & { c: AnalysisClaim; rev: string }): ClaimVerificationRecord => ({
  id: over.id ?? "rec-1", analysisId: "an-1", claimId: claimIdOf(over.c), claimIndex: 0, checkId: THROTTLE.id, checkFingerprint: checkFingerprint(THROTTLE), revision: over.rev, headBefore: over.rev, headAfter: over.rev,
  state: "passed", exitCode: 0, durationMs: 5, command: THROTTLE.command, logExcerpt: null, requestedBy: "u", createdAt: "2026-01-01T00:00:00.000Z", ...over,
});

const assessmentFor = (claims: AnalysisClaim[]): EvidenceAssessment => ({
  ...buildAssessment([], assessClaims(claims, claims.map(() => ({ file: null, matches: [], searched: true })), "complete"), "high", { listing: "complete", filesRead: 0, bytesRead: 0, filesSkipped: [], limits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 } }),
});

// ===========================================================================
// Identity and binding
// ===========================================================================

test("claim id is stable for the same claim and changes when the claim does; a check fingerprint changes when ANY part of its definition does", () => {
  const a = claim({});
  assert.equal(claimIdOf(a), claimIdOf({ ...a, searchTerms: ["limit", "otp"], statement: "  OTP sends are RATE limited on POST /login. " }), "case/whitespace/term-order do not change identity");
  assert.notEqual(claimIdOf(a), claimIdOf(claim({ statement: "OTP verification is correct." })));
  assert.notEqual(claimIdOf(a), claimIdOf(claim({ kind: "BEHAVIOR_INCORRECT" })));
  const base = checkFingerprint(THROTTLE);
  for (const change of [{ command: "node other.js" }, { timeoutMs: 1 }, { requiresFiles: [] }, { passMeans: "behavior_holds" as const, establishes: { ...THROTTLE.establishes, behavior: "something else" } }, { establishes: { ...THROTTLE.establishes, claimTerms: [["otp"]] } }, { id: "x-throttle" }]) {
    assert.notEqual(checkFingerprint({ ...THROTTLE, ...change }), base, JSON.stringify(change));
  }
  assert.equal(checkFingerprint({ ...THROTTLE, description: "reworded" }), base, "the human description is not part of what runs");
});

test("BINDING: only behaviour claims whose own words satisfy EVERY group of a check's terms are bound — nothing else, never by the model's say-so", () => {
  const checks = [THROTTLE];
  const bound = (c: AnalysisClaim) => bindClaimsToChecks([c], checks).map((b) => b.check.id);
  assert.deepEqual(bound(claim({})), ["otp-throttle"]);
  assert.deepEqual(bound(claim({ statement: "OTP attempts are not throttled on POST /login.", kind: "BEHAVIOR_INCORRECT", searchTerms: [] })), ["otp-throttle"], "an alternative in the group (throttle) satisfies it");
  assert.deepEqual(bound(claim({ statement: "OTP verification works.", searchTerms: ["otp", "verify"] })), [], "a different behaviour is not bound");
  assert.deepEqual(bound(claim({ statement: "Rate limiting works.", searchTerms: ["rate"] })), [], "every group is required (otp missing)");
  for (const kind of ["FILE_EXISTS", "FILE_ABSENT", "FEATURE_ABSENT", "FEATURE_PRESENT"] as const) assert.deepEqual(bound(claim({ kind, path: kind.startsWith("FILE") ? "a.ts" : null })), [], `${kind} claims are never bound`);
  assert.deepEqual(bindClaimsToChecks([claim({ kind: "BEHAVIOR_INCORRECT" })], [{ ...THROTTLE, establishes: { ...THROTTLE.establishes, claimKinds: ["BEHAVIOR_CORRECT"] } }]), [], "a check that only speaks to CORRECT claims is not bound to an INCORRECT one");
  assert.deepEqual(bindClaimsToChecks([claim({})], undefined), []);
  // The false verification found by the first worker-based real run: a STRUCTURAL claim that merely shares the topic terms.
  for (const statement of ["The auth service imports and is expected to use the throttling logic.", "The OTP throttle function is defined in otpThrottle.ts.", "requestOTP calls the OTP limit check.", "OTP throttle constants exist."]) {
    assert.deepEqual(bound(claim({ statement, searchTerms: ["otp", "throttle"] })), [], statement);
  }
  assert.deepEqual(bound(claim({ statement: "OTP sends are rate limited on POST /login with a cooldown and a per-window cap.", searchTerms: ["otp", "limit"] })), ["otp-throttle"], "a behavioural claim still binds");
  // planVerification derives from the PROJECT's checks only; no approved check ⇒ no requirement.
  assert.deepEqual(planVerification([claim({})], project({ test: "npm test" })), []);
  const plan = planVerification([claim({})], project({ claimChecks: [THROTTLE] }));
  assert.deepEqual(plan.map((r) => [r.claimIndex, r.claimId, r.checkId, r.state]), [[0, claimIdOf(claim({})), "otp-throttle", "not_run"]]);
});

test("the project's approved-check declaration is strictly validated at the API boundary (no free-form shell surprises, no unknown keys)", () => {
  const ok = { commands: { claimChecks: [THROTTLE] } };
  assert.equal(UpdateProjectCommandsSchema.safeParse(ok).success, true);
  const bad = (patch: Record<string, unknown>) => UpdateProjectCommandsSchema.safeParse({ commands: { claimChecks: [{ ...THROTTLE, ...patch }] } }).success;
  assert.equal(bad({ id: "Bad Id!" }), false);
  assert.equal(bad({ id: "x" }), false);
  assert.equal(bad({ command: "" }), false);
  assert.equal(bad({ timeoutMs: 5_000_000 }), false);
  assert.equal(bad({ passMeans: "exit_code_ignored" }), false);
  assert.equal(bad({ requiresFiles: ["../../etc/passwd"] }), false);
  assert.equal(bad({ requiresFiles: ["/etc/passwd"] }), false);
  assert.equal(bad({ establishes: { ...THROTTLE.establishes, claimTerms: [] } }), false);
  assert.equal(bad({ establishes: { ...THROTTLE.establishes, claimTerms: [["Two Words"]] } }), false);
  assert.equal(bad({ extraKey: 1 }), false, "unknown keys are refused");
  assert.equal(UpdateProjectCommandsSchema.safeParse({ commands: { claimChecks: [THROTTLE, THROTTLE] } }).success, false, "ids must be unique");
});

// ===========================================================================
// Execution: real workspace, real process
// ===========================================================================

test("production analysis executes NOTHING: the disabled policy refuses every requirement before any process is spawned", async () => {
  const repo = await makeRepo();
  const claims = [claim({})];
  const records = await runClaimVerification({ analysisId: "an-1", project: project({ claimChecks: [THROTTLE] }), requirements: planVerification(claims, project({ claimChecks: [THROTTLE] })), claims, revision: repo.sha, workspacePath: repo.dir, policy: ANALYSIS_VERIFICATION_DISABLED, signal, requestedBy: "u" });
  assert.equal(records[0]!.state, "rejected");
  assert.match(records[0]!.logExcerpt!, /read-only by policy/);
  assert.equal(repo.ran(), 0);
});

test("an explicit run executes the project's OWN approved command once, at the exact revision, and records the chain (claim id, check id, fingerprint, revision, both heads)", async () => {
  const repo = await makeRepo();
  const claims = [claim({}), claim({ statement: "OTP attempts are throttled on POST /login.", searchTerms: ["otp", "throttle"] })];
  const proj = project({ claimChecks: [THROTTLE] });
  const records = await runClaimVerification({ analysisId: "an-1", project: proj, requirements: planVerification(claims, proj), claims, revision: repo.sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal, requestedBy: "user-1" });
  assert.equal(repo.ran(), 1, "one execution serves both claims bound to the same check");
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.state, "passed");
    assert.equal(r.exitCode, 0);
    assert.equal(r.revision, repo.sha);
    assert.equal(r.headBefore, repo.sha);
    assert.equal(r.headAfter, repo.sha);
    assert.equal(r.checkId, "otp-throttle");
    assert.equal(r.checkFingerprint, checkFingerprint(THROTTLE));
    assert.equal(r.command, "node throttle-check.js", "the command that ran is the project's, looked up by id");
    assert.equal(r.requestedBy, "user-1");
  }
  assert.deepEqual(records.map((r) => r.claimId), claims.map(claimIdOf));
});

test("a check that FAILS is recorded as failed and establishes nothing — a broken implementation is never 'verified'", async () => {
  const repo = await makeRepo({ broken: true });
  const claims = [claim({})];
  const proj = project({ claimChecks: [THROTTLE] });
  const records = await runClaimVerification({ analysisId: "an-1", project: proj, requirements: planVerification(claims, proj), claims, revision: repo.sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal, requestedBy: "u" });
  assert.equal(records[0]!.state, "failed");
  assert.equal(records[0]!.exitCode, 1);
  const r = reconcile(claims, assessmentFor(claims), repo.sha, { checks: [THROTTLE], verifications: records, analysisId: "an-1" });
  assert.equal(r.findings[0]!.outcome, "UNRESOLVED");
  assert.equal(r.behaviorVerified, false);
  assert.match(r.findings[0]!.explanation, /ran but did not pass, which establishes nothing/);
});

test("timeout and cancellation use the existing check runner's machinery", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo.dir, "slow.js"), "setTimeout(() => {}, 30000);");
  await repo.git("add", "-A");
  await repo.git("commit", "-m", "slow");
  const sha = (await repo.git("rev-parse", "HEAD")).stdout.trim();
  const slow: ApprovedClaimCheck = { ...THROTTLE, command: "node slow.js", requiresFiles: [] };
  const claims = [claim({})];
  const proj = project({ claimChecks: [slow] });
  const timed = await runClaimVerification({ analysisId: "a", project: proj, requirements: planVerification(claims, proj), claims, revision: sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal, requestedBy: "u", checkTimeoutMsOverride: 400 });
  assert.equal(timed[0]!.state, "timed_out");
  const ac = new AbortController();
  const p = runClaimVerification({ analysisId: "a", project: proj, requirements: planVerification(claims, proj), claims, revision: sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal: ac.signal, requestedBy: "u" });
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(p, /cancel/i);
});

test("REFUSED BEFORE ANYTHING RUNS: unknown check id, unbound claim, missing prerequisite file, wrong revision, and injected commands", async () => {
  const repo = await makeRepo();
  const claims = [claim({}), claim({ statement: "Profiles can be deleted.", searchTerms: ["profile"] })];
  const proj = project({ claimChecks: [THROTTLE] });
  const go = (requirements: ReturnType<typeof planVerification>, over: Partial<Parameters<typeof runClaimVerification>[0]> = {}) =>
    runClaimVerification({ analysisId: "an-1", project: proj, requirements, claims, revision: repo.sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal, requestedBy: "u", ...over });
  const req = (over: Record<string, unknown>) => ({ claimIndex: 0, claimId: claimIdOf(claims[0]!), checkId: "otp-throttle", state: "not_run" as const, reason: "", evidenceId: null, ...over });

  // Injected ids / commands are not "approved checks": they cannot select anything to run.
  for (const evil of ["rm -rf /", "node throttle-check.js; touch pwned", "../../bin/sh", "OTP-THROTTLE", "deploy"]) {
    const [r] = await go([req({ checkId: evil })]);
    assert.equal(r!.state, "rejected", evil);
    assert.match(r!.logExcerpt!, /not an approved check/);
  }
  // A claim that is not bound to the check (different claim id / different claim).
  assert.equal((await go([req({ claimId: "deadbeefdeadbeef" })]))[0]!.state, "rejected", "claim id mismatch");
  assert.equal((await go([req({ claimIndex: 1, claimId: claimIdOf(claims[1]!) })]))[0]!.state, "rejected", "claim 1 is not bound to the throttle check");
  // Wrong revision: the workspace is not at the analysed revision.
  const wrong = await go([req({})], { revision: REV_B });
  assert.equal(wrong[0]!.state, "rejected");
  assert.match(wrong[0]!.logExcerpt!, /not the analysed revision/);
  // Prerequisite file absent.
  const missingFile = { ...proj, commands: { claimChecks: [{ ...THROTTLE, requiresFiles: ["nope.js"] }] } } as Project;
  const pre = await runClaimVerification({ analysisId: "an-1", project: missingFile, requirements: planVerification(claims, missingFile), claims, revision: repo.sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal, requestedBy: "u", fileExists: (f) => existsSync(join(repo.dir, f)) });
  assert.equal(pre[0]!.state, "rejected");
  assert.match(pre[0]!.logExcerpt!, /Prerequisite file nope\.js/);
  assert.equal(repo.ran(), 0, "nothing was ever executed");
  assert.equal(existsSync(join(repo.dir, "pwned")), false);
});

test("revision binding holds AFTER the run too: a check that moves HEAD is discarded", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo.dir, "mover.js"), 'require("child_process").execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "moved"]);\n');
  await repo.git("add", "-A");
  await repo.git("commit", "-m", "mover");
  const sha = (await repo.git("rev-parse", "HEAD")).stdout.trim();
  const mover: ApprovedClaimCheck = { ...THROTTLE, command: "node mover.js", requiresFiles: [] };
  const claims = [claim({})];
  const proj = project({ claimChecks: [mover] });
  const [r] = await runClaimVerification({ analysisId: "a", project: proj, requirements: planVerification(claims, proj), claims, revision: sha, workspacePath: repo.dir, policy: HUMAN_REQUESTED_VERIFICATION, signal, requestedBy: "u" });
  assert.equal(r!.state, "rejected");
  assert.match(r!.logExcerpt!, /moved during verification/);
  assert.notEqual(r!.headAfter, sha);
  const asm = applyVerificationRecords({ ...assessmentFor(claims), verification: planVerification(claims, proj) }, [r!], sha);
  assert.equal(asm.evidence.some((e) => e.type === "CHECK_RESULT"), false, "no CHECK_RESULT evidence for a discarded run");
});

// ===========================================================================
// Reconciliation semantics: when does a record make a claim CHECK_VERIFIED / CHECK_CONTRADICTED?
// ===========================================================================

function verdict(c: AnalysisClaim, rec: ClaimVerificationRecord | null, over: { checks?: ApprovedClaimCheck[]; rev?: string; analysisId?: string } = {}) {
  const rev = over.rev ?? REV_B;
  return reconcile([c], assessmentFor([c]), rev, { checks: over.checks ?? [THROTTLE], verifications: rec ? [rec] : [], analysisId: over.analysisId ?? "an-1" });
}

test("CHECK_VERIFIED: a BEHAVIOR_CORRECT claim bound to a check that PASSED at this revision; the chain is exposed; behaviour verified is stated", () => {
  const c = claim({});
  const r = verdict(c, asRecord({ c, rev: REV_B }));
  const f = r.findings[0]!;
  assert.equal(f.outcome, "CHECK_VERIFIED");
  assert.equal(f.behaviorVerified, true);
  assert.equal(f.claimId, claimIdOf(c));
  assert.deepEqual(f.availableChecks, ["otp-throttle"]);
  assert.equal(f.verificationId, "rec-1");
  assert.equal(r.behavior, "CHECK_VERIFIED");
  assert.equal(r.behaviorVerified, true);
  assert.match(f.explanation, /otp-throttle.*passed at revision bbbbbbbbbbbb/);
});

test("CHECK_CONTRADICTED: an ABSENCE-worded BEHAVIOR_INCORRECT claim contradicted by the verified pass; a claim about some OTHER defect is only UNRESOLVED", () => {
  const absence = claim({ statement: "OTP attempts are not limited on POST /login.", kind: "BEHAVIOR_INCORRECT", searchTerms: ["otp", "limit"] });
  const r = verdict(absence, asRecord({ c: absence, rev: REV_B }));
  assert.equal(r.findings[0]!.outcome, "CHECK_CONTRADICTED");
  assert.equal(r.behaviorVerified, true);
  assert.equal(r.implementation, "present");
  const defect = claim({ statement: "The OTP throttle window resets at the wrong time.", kind: "BEHAVIOR_INCORRECT", searchTerms: ["otp", "throttle", "window"] });
  const d = verdict(defect, asRecord({ c: defect, rev: REV_B }));
  assert.equal(d.findings[0]!.outcome, "UNRESOLVED");
  assert.equal(d.behaviorVerified, false);
  assert.match(d.findings[0]!.explanation, /No approved verification is available/);
});

test("STALE / FOREIGN records never count — each reason is separately rejected and reported", () => {
  const c = claim({});
  const good = asRecord({ c, rev: REV_B });
  const problem = (rec: ClaimVerificationRecord, over: Parameters<typeof verdict>[2] = {}) => {
    const r = verdict(c, rec, over);
    assert.equal(r.findings[0]!.outcome, "UNRESOLVED");
    assert.equal(r.behaviorVerified, false);
    return r.ignoredVerifications![0]?.reason ?? "";
  };
  assert.equal(verdict(c, good).findings[0]!.outcome, "CHECK_VERIFIED", "(control)");
  assert.match(problem({ ...good, revision: "a".repeat(40), headBefore: "a".repeat(40), headAfter: "a".repeat(40) }), /ran at revision aaaaaaaaaaaa, not the analysed bbbbbbbbbbbb/, "claim revision B, result revision A");
  assert.match(problem({ ...good, headAfter: "c".repeat(40) }), /not proven to be at the analysed revision/);
  assert.match(problem({ ...good, headBefore: null }), /not proven/);
  assert.match(problem({ ...good, claimId: claimIdOf(claim({ statement: "Something else entirely." })) }), /different claim/, "check bound to claim B, presented for claim A");
  assert.match(problem(good, { analysisId: "another-analysis" }), /different analysis/);
  assert.match(problem(good, { checks: [] }), /no longer an approved check/);
  assert.match(problem(good, { checks: [{ ...THROTTLE, command: "node different.js" }] }), /definition of "otp-throttle" changed/, "a check edited after it ran is a different check");
  assert.match(problem(good, { checks: [{ ...THROTTLE, establishes: { ...THROTTLE.establishes, claimTerms: [["billing"]] } }] }), /changed|not bound/);
  assert.match(problem({ ...good, checkId: "other-check" }), /no longer an approved check/);
  // Unknown analysed revision ⇒ nothing can bind.
  const noRev = reconcile([c], assessmentFor([c]), null, { checks: [THROTTLE], verifications: [good], analysisId: "an-1" });
  assert.equal(noRev.behaviorVerified, false);
});

test("a check that does not speak to the claim's kind cannot verify it; failed / timed-out / errored records never verify", () => {
  const c = claim({});
  const onlyIncorrect: ApprovedClaimCheck = { ...THROTTLE, establishes: { ...THROTTLE.establishes, claimKinds: ["BEHAVIOR_INCORRECT"] } };
  assert.equal(verdict(c, asRecord({ c, rev: REV_B, checkFingerprint: checkFingerprint(onlyIncorrect) }), { checks: [onlyIncorrect] }).behaviorVerified, false);
  for (const state of ["failed", "timed_out", "infrastructure_error", "rejected"] as const) {
    assert.equal(verdict(c, asRecord({ c, rev: REV_B, state })).behaviorVerified, false, state);
  }
});

test("no approved check ⇒ BEHAVIOR_UNVERIFIED, stated plainly, never CHECK_VERIFIED; a generic passing project 'test' command is irrelevant", () => {
  const c = claim({});
  const r = reconcile([c], assessmentFor([c]), REV_B, { checks: [] });
  assert.equal(r.behavior, "BEHAVIOR_UNVERIFIED");
  assert.deepEqual(r.findings[0]!.availableChecks, []);
  assert.match(r.findings[0]!.explanation, /No approved verification is available for this claim/);
  assert.equal(planVerification([c], project({ test: "npm test", build: "npm run build" })).length, 0);
});

// ===========================================================================
// Review semantics
// ===========================================================================

test("review states: implementation and behaviour are two separate facts; only a verified check yields VERIFIED_CONFLICT; nothing says fixed", () => {
  const c = claim({ statement: "OTP attempts are not limited on POST /login.", kind: "BEHAVIOR_INCORRECT", searchTerms: ["otp", "limit"] });
  const analysisWith = (reconciliation: unknown, investigation?: unknown) =>
    ({ id: "an-1", status: "succeeded", result: { claims: [c] }, platformChecks: { assessment: { ...assessmentFor([c]), reconciliation, investigation } } }) as never;
  const rec = (implementation: "present" | "possible" | "none", findings: unknown[] = [], behavior = "BEHAVIOR_UNVERIFIED") => ({ revision: REV_B, findings, alreadyImplemented: "none", behaviorVerified: false, ignoredEvidence: [], implementation, behavior });
  const review = (status: string, a: unknown) => deriveReview({ status } as never, a as never);

  assert.deepEqual(review("NEW", null), { state: "NEEDS_ANALYSIS", implementation: "unknown", behavior: "BEHAVIOR_UNVERIFIED" });
  assert.equal(review("ANALYZING", null).state, "NEEDS_ANALYSIS");
  assert.deepEqual(review("ANALYZED", analysisWith(rec("none"))), { state: "READY_FOR_PROPOSAL", implementation: "unknown", behavior: "BEHAVIOR_UNVERIFIED" });
  assert.equal(review("ANALYZED", analysisWith(rec("none"), { signal: "NO_CONFLICTING_IMPLEMENTATION_EVIDENCE" })).implementation, "none_found");
  const present = review("ANALYZED", analysisWith(rec("present")));
  assert.deepEqual(present, { state: "POSSIBLY_ALREADY_IMPLEMENTED", implementation: "present", behavior: "BEHAVIOR_UNVERIFIED" }, "implementation present, behaviour STILL unverified");
  assert.equal(review("ANALYZED", analysisWith(rec("possible"))).implementation, "possible");
  assert.equal(review("NEEDS_CLARIFICATION", analysisWith(rec("present"))).state, "POSSIBLY_ALREADY_IMPLEMENTED", "a present implementation outranks a generic clarification");
  assert.equal(review("NEEDS_CLARIFICATION", analysisWith(rec("none"))).state, "NEEDS_CLARIFICATION");
  const verified = review("ANALYZED", analysisWith(rec("present", [{ outcome: "CHECK_CONTRADICTED" }], "CHECK_VERIFIED")));
  assert.deepEqual(verified, { state: "VERIFIED_CONFLICT", implementation: "present", behavior: "CHECK_VERIFIED" });
  for (const status of ["CONVERTED", "REJECTED", "READY_FOR_TASK"]) assert.equal(review(status, analysisWith(rec("present"))).state, null, `${status} has left review`);
  // A failed latest analysis carries no assessment.
  assert.equal(review("ANALYZED", { status: "failed", platformChecks: null }).state, "NEEDS_ANALYSIS");
});

test("withVerification recomputes the reading with recorded results and the project's CURRENT checks; legacy analyses (no reconciliation) are returned untouched", () => {
  const c = claim({ statement: "OTP attempts are not limited on POST /login.", kind: "BEHAVIOR_INCORRECT", searchTerms: ["otp", "limit"] });
  const base = assessmentFor([c]);
  const analysis = { id: "an-1", status: "succeeded", result: { claims: [c] }, platformChecks: { assessment: { ...base, reconciliation: reconcile([c], base, REV_B, {}) } } } as never;
  const noCheck = withVerification(analysis, [], project({}));
  assert.equal((noCheck as never as { platformChecks: { assessment: { reconciliation: { behavior: string } } } }).platformChecks.assessment.reconciliation.behavior, "BEHAVIOR_UNVERIFIED");
  const rec = asRecord({ c, rev: REV_B });
  const verified = withVerification(analysis, [rec], project({ claimChecks: [THROTTLE] })) as never as { platformChecks: { assessment: { reconciliation: { behavior: string; findings: Array<{ outcome: string }> }; evidence: Array<{ type: string; detail: string }>; verification: Array<{ state: string }> } } };
  assert.equal(verified.platformChecks.assessment.reconciliation.findings[0]!.outcome, "CHECK_CONTRADICTED");
  assert.equal(verified.platformChecks.assessment.verification[0]!.state, "passed");
  const cr = verified.platformChecks.assessment.evidence.find((e) => e.type === "CHECK_RESULT")!;
  assert.match(cr.detail, /^otp-throttle: passed \(exit 0\).*@ bbbbbbbbbbbb — bound to claim /);
  // The same record read against a project whose check was edited is ignored.
  const edited = withVerification(analysis, [rec], project({ claimChecks: [{ ...THROTTLE, command: "node evil.js" }] })) as never as { platformChecks: { assessment: { reconciliation: { behavior: string; ignoredVerifications: unknown[] } } } };
  assert.equal(edited.platformChecks.assessment.reconciliation.behavior, "BEHAVIOR_UNVERIFIED");
  assert.equal(edited.platformChecks.assessment.reconciliation.ignoredVerifications.length, 1);
  const legacy = { id: "old", status: "succeeded", result: { claims: [] }, platformChecks: { assessment: base } } as never;
  assert.equal(withVerification(legacy, [rec], null), legacy);
});


/** Enqueue through the production service, then drive the existing worker's runner — the only execution path. */
async function verifyViaWorker(h: BacklogHarness, itemId: string, actor: string) {
  const queued = h.services.claimVerifier.request(itemId, actor);
  await h.platform.claimVerificationRunner.drain();
  const analysisId = h.platform.backlogAnalyses.findLatestSucceededForItem(itemId)!.id;
  return { queued, jobs: h.services.claimVerifier.list(itemId, actor), records: h.platform.claimVerifications.listForAnalysis(analysisId) };
}

// ===========================================================================
// End to end: real analysis path → explicit human-requested verification → readable chain
// ===========================================================================

test("E2E: model claim (real worker path, scripted engine) → bound approved check → ClaimVerifier at a REAL git revision → record → CHECK_CONTRADICTED and VERIFIED_CONFLICT; the evidence chain is complete; human approval is still required", async () => {
  const repo = await makeRepo();
  let wsAtRevision: { dir: string; head: string; dispose: () => Promise<void> } | null = null;
  const h = await setupBacklogHarness("claim-e2e", {
    platform: { verification: { workspaceFactory: async () => wsAtRevision! } },
    respond: () => json(validAnalysis({ claims: [{ statement: "OTP attempts are not limited on POST /login.", kind: "BEHAVIOR_INCORRECT", path: null, searchTerms: ["otp", "limit"], confidence: "high" }], candidateFiles: [] })),
  });
  try {
    // The project owner declares the approved check (the API path for this is the strict PATCH /commands schema tested above).
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [THROTTLE] }, new Date().toISOString());
    const item = h.item("No limit on OTP attempts", "BUG-073", "There is no limit on OTP attempts during login.");
    await h.analyze(item.id);
    const analysis = h.platform.backlogAnalyses.findLatestForItem(item.id)!;
    const stored = analysis.platformChecks!.assessment!;
    assert.equal(stored.verification!.length, 1, "the platform bound the claim to the approved check at analysis time");
    assert.equal(stored.verification![0]!.state, "not_run", "…and ran nothing");
    assert.equal(stored.verification![0]!.checkId, "otp-throttle");
    assert.equal(h.services.backlog.getItem(item.id, h.owner.id).review.behavior, "BEHAVIOR_UNVERIFIED");

    // The analysed revision in this harness is the fake repository's; bind the record to it by running against a workspace AT that revision.
    const revision = stored.reconciliation!.revision!;
    wsAtRevision = { dir: repo.dir, head: revision, dispose: async () => {} };
    // (The fixture repository's own commit is not `revision`, so the run must be REFUSED: the workspace is not at the analysed revision.)
    const refused = await verifyViaWorker(h, item.id, h.owner.id);
    assert.equal(refused.records[0]!.state, "rejected");
    assert.match(refused.records[0]!.logExcerpt!, /not the analysed revision/);
    assert.equal(refused.jobs[0]!.status, "FAILED", "a rejected run is a FAILED job, never a success");
    assert.equal(repo.ran(), 0);
    assert.equal(h.services.backlog.getItem(item.id, h.owner.id).review.behavior, "BEHAVIOR_UNVERIFIED", "a refused run verifies nothing");
  } finally {
    await h.platform.backgroundRunner.stop();
    h.close();
  }
});

test("E2E with a REAL revision: analysis is run against a real git repository, the check runs in a workspace prepared by the platform at exactly that commit, and the claim becomes CHECK_CONTRADICTED / VERIFIED_CONFLICT", async () => {
  const repo = await makeRepo();
  const { fakeStructure } = await import("./helpers/backlog-harness.js");
  const structure = fakeStructure({ "throttle.js": "x", "throttle-check.js": "y" }, { revision: repo.sha });
  const h = await setupBacklogHarness("claim-e2e-real", {
    structure,
    respond: () => json(validAnalysis({ claims: [{ statement: "OTP attempts are not limited on POST /login.", kind: "BEHAVIOR_INCORRECT", path: null, searchTerms: ["otp", "limit"], confidence: "high" }], candidateFiles: [] })),
  });
  try {
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [THROTTLE] }, new Date().toISOString());
    // Point the project at the real repository so the platform can prepare the workspace itself.
    h.platform.db.prepare("UPDATE project_repos SET repo_url = ? WHERE project_id = ?").run(repo.dir, h.project.id);
    const item = h.item("No limit on OTP attempts", "BUG-073", "There is no limit on OTP attempts during login.");
    await h.analyze(item.id);
    assert.equal(h.platform.backlogAnalyses.findLatestForItem(item.id)!.platformChecks!.assessment!.reconciliation!.revision, repo.sha);

    const outcome = await verifyViaWorker(h, item.id, h.owner.id);
    assert.equal(outcome.jobs[0]!.status, "SUCCEEDED");
    assert.equal(outcome.records[0]!.jobId, outcome.jobs[0]!.id, "the record names the job that produced it");
    assert.equal(outcome.records.length, 1);
    const rec = outcome.records[0]!;
    assert.equal(rec.state, "passed");
    assert.equal(rec.revision, repo.sha);
    assert.equal(rec.headBefore, repo.sha);
    assert.equal(rec.headAfter, repo.sha);
    assert.equal(h.platform.db.prepare("SELECT COUNT(*) AS n FROM claim_verifications").get()!["n"], 1, "persisted, append-only");

    const detail = h.services.backlog.getItem(item.id, h.owner.id);
    const asm = detail.latestAnalysis!.platformChecks!.assessment!;
    assert.equal(asm.reconciliation!.findings[0]!.outcome, "CHECK_CONTRADICTED");
    assert.equal(asm.reconciliation!.behavior, "CHECK_VERIFIED");
    assert.equal(asm.verification![0]!.state, "passed");
    assert.ok(asm.evidence.some((e) => e.type === "CHECK_RESULT" && e.revision === repo.sha));
    assert.deepEqual(detail.review, { state: "VERIFIED_CONFLICT", implementation: "present", behavior: "CHECK_VERIFIED" });
    assert.equal(detail.claimVerifications.length, 1);
    assert.equal(detail.item.status, "ANALYZED", "verification never closes, converts or approves anything");
    assert.equal(h.platform.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!["n"], 0);
    // Editing the project's check afterwards makes the recorded result stale.
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [{ ...THROTTLE, command: "node throttle-check.js && echo changed" }] }, new Date().toISOString());
    assert.equal(h.services.backlog.getItem(item.id, h.owner.id).review.behavior, "BEHAVIOR_UNVERIFIED");
    // Human approval is still mandatory for a proposal → task.
    const { proposal } = h.services.backlog.generateProposal(item.id, h.owner.id);
    await assert.rejects(() => h.services.backlog.convertProposal(proposal.id, h.owner.id), /must be approved/);
  } finally {
    await h.platform.backgroundRunner.stop();
    h.close();
  }
});

test("the model cannot request verification or name a command: any such field makes the whole analysis malformed", () => {
  for (const extra of [{ claimChecks: [THROTTLE] }, { verification: { checkId: "otp-throttle" } }, { command: "rm -rf /" }, { checkId: "otp-throttle" }, { investigation: {} }]) {
    assert.equal(parseAnalysisOutput(json(validAnalysis(extra))).ok, false, JSON.stringify(extra));
  }
  assert.equal(parseAnalysisOutput(json(validAnalysis({ claims: [{ statement: "x", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp"], confidence: "high", checkId: "otp-throttle", command: "rm -rf /" }] }))).ok, false);
});

test("prepareRevisionWorkspace: checks out EXACTLY the requested commit (not a moved-on HEAD) and rejects non-hex / short revisions", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo.dir, "later.txt"), "later\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-m", "later");
  const registry = new SourceControlProviderRegistry();
  registry.register(new LocalGitSourceControlProvider());
  const proj = { ...project({}), repoUrl: repo.dir, sourceControlProvider: "local-git" } as Project;
  const w = await prepareRevisionWorkspace(proj, repo.sha, registry, signal);
  try {
    assert.equal(w.head, repo.sha);
    assert.equal(existsSync(join(w.dir, "later.txt")), false, "the later commit is not in the workspace");
    assert.equal(existsSync(join(w.dir, "throttle.js")), true);
  } finally {
    await w.dispose();
  }
  assert.equal(existsSync(w.dir), false, "disposed");
  await assert.rejects(() => prepareRevisionWorkspace(proj, "main", registry, signal), /full commit id/);
  await assert.rejects(() => prepareRevisionWorkspace(proj, "abc123", registry, signal), /full commit id/);
  await assert.rejects(() => prepareRevisionWorkspace(proj, "--upload-pack=x", registry, signal), /full commit id/);
});

void ClaimVerifier;

// ---------------------------------------------------------------------------
// ClaimVerifier guard paths (found by mutation testing)
// ---------------------------------------------------------------------------

test("ClaimVerifier refuses politely: no analysis, an analysis that did not record its revision, and nothing bound ⇒ NOTHING is cloned or run", async () => {
  const h = await setupBacklogHarness("verifier-guards", { respond: () => json(validAnalysis({ claims: [{ statement: "OTP sends are throttled on POST /login.", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" }], candidateFiles: [] })) });
  try {
    const item = h.item("OTP", "B-1");
    assert.throws(() => h.services.claimVerifier.request(item.id, h.owner.id), /no successful analysis/);

    // No approved checks ⇒ nothing bound ⇒ returns a note; a bogus repo URL proves no workspace was even attempted.
    h.platform.db.prepare("UPDATE project_repos SET repo_url = ? WHERE project_id = ?").run("/definitely/not/a/repo", h.project.id);
    await h.analyze(item.id);
    const none = h.services.claimVerifier.request(item.id, h.owner.id);
    assert.deepEqual(none.jobs, []);
    assert.match(none.note!, /No approved check of this project is bound/);
    assert.equal(h.platform.db.prepare("SELECT COUNT(*) AS n FROM claim_verifications").get()!["n"], 0);

    // A legacy analysis (no reconciliation ⇒ no recorded revision) cannot be verified: a check has nothing to bind to.
    h.platform.projects.updateCommands(h.project.id, { claimChecks: [THROTTLE] }, new Date().toISOString());
    const row = h.platform.db.prepare("SELECT id, platform_checks_json FROM backlog_analyses").get() as { id: string; platform_checks_json: string };
    const pc = JSON.parse(row.platform_checks_json);
    delete pc.assessment.reconciliation;
    h.platform.db.prepare("UPDATE backlog_analyses SET platform_checks_json = ? WHERE id = ?").run(JSON.stringify(pc), row.id);
    assert.throws(() => h.services.claimVerifier.request(item.id, h.owner.id), /did not record the repository revision/);
    // Another owner cannot verify it at all.
    const other = h.addUser("intruder");
    assert.throws(() => h.services.claimVerifier.request(item.id, other.id), /not found/i);
  } finally {
    await h.platform.backgroundRunner.stop();
    h.close();
  }
});

// ---------------------------------------------------------------------------
// Regression: the FIRST REAL validation run bound a claim about the MOBILE client to a BACKEND throttle test and produced a
// false CHECK_CONTRADICTED. Two independent guards now stop that.
// ---------------------------------------------------------------------------

test("REAL-RUN REGRESSION: a claim about the mobile client is never bound to a backend check, and broad 'without checking' wording is never CONTRADICTED", () => {
  const backend: ApprovedClaimCheck = { ...THROTTLE, application: "backend" };
  const real = claim({
    statement: "The `_resendOtp` method in the mobile client triggers an OTP event without checking if a request is already in-flight or if the cooldown has elapsed.",
    kind: "BEHAVIOR_INCORRECT",
    searchTerms: ["resend", "otp", "trigger"],
  });
  // Guard 1 — application scoping (claims carry the entry point, as the semantic contract requires).
  const mobileScope = (application: string) => ({ ...backend, application, establishes: { ...backend.establishes, scope: { ...backend.establishes.scope!, application } } });
  assert.deepEqual(bindClaimsToChecks([real], [backend]), [], "the claim names the mobile client; the check exercises the backend");
  assert.equal(bindClaimsToChecks([{ ...real, statement: "The OTP resend cooldown is not enforced on POST /login." }], [backend]).length, 1, "an application-neutral claim naming the entry point binds");
  assert.equal(bindClaimsToChecks([{ ...real, statement: "The backend does not throttle the OTP cooldown on POST /login." }], [backend]).length, 1, "a backend claim binds");
  assert.equal(bindClaimsToChecks([{ ...real, statement: "The mobile client does not enforce the OTP cooldown on POST /login." }], [mobileScope("mobile")]).length, 1, "the same kind of claim DOES bind to a mobile-scoped check");
  assert.equal(bindClaimsToChecks([{ ...real, statement: "The OTP cooldown is not enforced on POST /login." }], [mobileScope("some-custom-name")]).length, 1, "unknown application names never filter");
  assert.equal(bindClaimsToChecks([claim({ statement: "OTP limits are wrong on POST /login.", path: "frontend/mobile/lib/otp_page.dart" })], [backend]).length, 0, "the file path a claim names counts");
  // The declared application is part of the check's identity.
  assert.notEqual(checkFingerprint(backend), checkFingerprint({ ...backend, application: "mobile" }));

  // Guard 2 — even if such a claim WERE bound (application-neutral wording), broad negation is not contradicted by a pass.
  const neutral = claim({ statement: "The resend handler on POST /login triggers an OTP event without checking whether the cooldown has elapsed.", kind: "BEHAVIOR_INCORRECT", searchTerms: ["otp", "cooldown"] });
  assert.equal(bindClaimsToChecks([neutral], [backend]).length, 1);
  const r = verdict(neutral, asRecord({ c: neutral, rev: REV_B, checkFingerprint: checkFingerprint(backend) }), { checks: [backend] });
  assert.equal(r.findings[0]!.outcome, "UNRESOLVED", "broad wording ('without checking') is only UNRESOLVED even after a verified pass");
  assert.equal(r.behaviorVerified, false);
  // Explicit absence wording — including 'is not limited/throttled' — is contradicted.
  for (const statement of ["OTP attempts are not limited on POST /login.", "There is no limit on OTP attempts on POST /login.", "OTP sends are not throttled on POST /login.", "OTP resend is unlimited on POST /login."]) {
    const c = claim({ statement, kind: "BEHAVIOR_INCORRECT", searchTerms: ["otp", "limit"] });
    assert.equal(verdict(c, asRecord({ c, rev: REV_B, checkFingerprint: checkFingerprint(backend) }), { checks: [backend] }).findings[0]!.outcome, "CHECK_CONTRADICTED", statement);
  }
});
