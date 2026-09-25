import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisResultSchema, parseAnalysisOutput } from "../src/backlog/analysis-schema.js";
import { assessClaims, buildAssessment, collectEvidence, hasConfidentContradiction, listingState, minTermsFor, type ClaimEvidence } from "../src/backlog/evidence.js";
import { deriveAnalysisOutcome } from "../src/backlog/backlog-state-machine.js";
import { RepositoryInspector, excerptFor, findContentMatches, isSecretPath, maskSecrets, normalizeRepoPath, DEFAULT_INSPECTION_LIMITS, type InspectionLimits } from "../src/backlog/repository-inspector.js";
import { parseLsTree } from "../src/backlog/repository-structure.js";
import type { AnalysisClaim, ClaimKind, PlatformEvidence } from "../src/backlog/backlog-types.js";
import { TaskProposalContentSchema } from "../src/backlog/analysis-schema.js";
import { fakeStructure, json, setupBacklogHarness, validAnalysis, type BacklogHarness, type BacklogHarnessOptions } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.2 — evidence-grounded analysis. The invariant under test everywhere: AI may SUGGEST; the
 * PLATFORM obtains evidence and OWNS it; a claim's status is a deterministic function of platform
 * evidence, never of anything the model says about itself. Existence never proves behavior.
 */

const signal = new AbortController().signal;

// The Jinvani-style repository: the throttle file EXISTS.
const OTP_THROTTLE = "backend/src/modules/auth/services/otpThrottle.ts";
const JINVANI_FILES: Record<string, string> = {
  [OTP_THROTTLE]: "export const OTP_MAX_SENDS_PER_WINDOW = 5;\nexport function evaluateOtpThrottle(record: unknown, now: Date) {\n  // cooldown + window cap\n  return { allowed: true };\n}\n",
  "backend/src/modules/auth/services/auth.service.ts": "export async function requestOTP(id: string) {\n  const verdict = evaluateOtpThrottle(null, new Date());\n}\n",
  "backend/src/modules/auth/models/otp.model.ts": "export const OtpModel = {};\n",
  "backend/src/common/utils/ApiError.ts": "export class ApiError {}\n",
  "README.md": "# Jinvani\n",
};

function claim(overrides: Partial<AnalysisClaim> = {}): AnalysisClaim {
  return { statement: "OTP throttling does not exist.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "high", ...overrides };
}

const ev = (id: string, type: PlatformEvidence["type"], path: string | null = null, detail: string | null = null): PlatformEvidence => ({
  id, type, source: type === "CONTENT_MATCH" ? "repository_content" : "repository_listing", path, detail, matchedTerms: [],
});

// ===========================================================================
// The assessment is deterministic and never overclaims (pure)
// ===========================================================================

test("FILE_ABSENT: 'otpThrottle.ts does not exist' + the platform finds it ⇒ CONTRADICTED (never VERIFIED)", () => {
  const perClaim: ClaimEvidence[] = [{ file: ev("E1", "FILE_EXISTS", OTP_THROTTLE), matches: [], searched: false }];
  const [a] = assessClaims([claim({ kind: "FILE_ABSENT", statement: "otpThrottle.ts does not exist", path: OTP_THROTTLE, searchTerms: [] })], perClaim, "complete");
  assert.equal(a!.status, "CONTRADICTED");
  assert.deepEqual(a!.evidenceIds, ["E1"]);
});

test("FILE_EXISTS / FILE_ABSENT: supported and contradicted in both directions on a COMPLETE listing", () => {
  const exists: ClaimEvidence = { file: ev("E1", "FILE_EXISTS", "a.ts"), matches: [], searched: false };
  const missing: ClaimEvidence = { file: ev("E2", "FILE_NOT_FOUND", "b.ts"), matches: [], searched: false };
  const c = (kind: ClaimKind, path: string) => claim({ kind, path, searchTerms: [] });
  assert.equal(assessClaims([c("FILE_EXISTS", "a.ts")], [exists], "complete")[0]!.status, "SUPPORTED");
  assert.equal(assessClaims([c("FILE_EXISTS", "b.ts")], [missing], "complete")[0]!.status, "CONTRADICTED");
  assert.equal(assessClaims([c("FILE_ABSENT", "b.ts")], [missing], "complete")[0]!.status, "SUPPORTED");
  assert.equal(assessClaims([c("FILE_ABSENT", "a.ts")], [exists], "complete")[0]!.status, "CONTRADICTED");
});

test("absence is never established without a complete listing: truncated ⇒ UNRESOLVED, unavailable ⇒ NOT_CHECKED", () => {
  const none: ClaimEvidence = { file: null, matches: [], searched: false };
  const c = claim({ kind: "FILE_ABSENT", path: "x.ts", searchTerms: [] });
  assert.equal(assessClaims([c], [none], "truncated")[0]!.status, "UNRESOLVED");
  assert.equal(assessClaims([c], [none], "unavailable")[0]!.status, "NOT_CHECKED");
});

test("FEATURE_ABSENT: matching evidence ⇒ CONTRADICTED; a bounded search finding NOTHING is UNRESOLVED, never SUPPORTED", () => {
  const hit: ClaimEvidence = { file: null, matches: [ev("E1", "PATH_MATCH", OTP_THROTTLE)], searched: true };
  const miss: ClaimEvidence = { file: null, matches: [], searched: true };
  assert.equal(assessClaims([claim()], [hit], "complete")[0]!.status, "CONTRADICTED");
  const unresolved = assessClaims([claim()], [miss], "complete")[0]!;
  assert.equal(unresolved.status, "UNRESOLVED");
  assert.match(unresolved.reason, /does not prove nothing exists/);
  assert.equal(assessClaims([claim()], [miss], "unavailable")[0]!.status, "NOT_CHECKED");
  assert.equal(assessClaims([claim({ searchTerms: [] })], [{ file: null, matches: [], searched: false }], "complete")[0]!.status, "UNRESOLVED", "no terms ⇒ nothing was searched");
});

test("FEATURE_PRESENT: evidence of presence supports EXISTENCE only, and says so", () => {
  const hit: ClaimEvidence = { file: null, matches: [ev("E1", "PATH_MATCH", OTP_THROTTLE)], searched: true };
  const a = assessClaims([claim({ kind: "FEATURE_PRESENT", statement: "OTP throttling exists" })], [hit], "complete")[0]!;
  assert.equal(a.status, "SUPPORTED");
  assert.match(a.reason, /not evidence that it is correct or complete/);
});

test("BEHAVIOR_CORRECT / BEHAVIOR_INCORRECT: file existence alone can NEVER settle behavior ⇒ UNRESOLVED (the mandatory distinction)", () => {
  const fileOnly: ClaimEvidence = { file: ev("E1", "FILE_EXISTS", OTP_THROTTLE), matches: [], searched: false };
  for (const kind of ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"] as const) {
    const a = assessClaims([claim({ kind, statement: "OTP throttling implementation may be incorrect.", path: OTP_THROTTLE, searchTerms: [] })], [fileOnly], "complete")[0]!;
    assert.equal(a.status, "UNRESOLVED", kind);
    assert.deepEqual(a.evidenceIds, ["E1"]);
    assert.match(a.reason, /existence does not establish behavior/);
  }
  // Even a pile of matching content does not turn a behavior claim into SUPPORTED/CONTRADICTED.
  const lots: ClaimEvidence = { file: fileOnly.file, matches: [ev("E2", "CONTENT_MATCH", OTP_THROTTLE, "L2: evaluateOtpThrottle"), ev("E3", "PATH_MATCH", OTP_THROTTLE)], searched: true };
  assert.equal(assessClaims([claim({ kind: "BEHAVIOR_CORRECT", path: OTP_THROTTLE })], [lots], "complete")[0]!.status, "UNRESOLVED");
});

test("a behavior claim about a file that does not exist (complete listing, nothing related) is CONTRADICTED", () => {
  const missing: ClaimEvidence = { file: ev("E1", "FILE_NOT_FOUND", "nope.ts"), matches: [], searched: false };
  assert.equal(assessClaims([claim({ kind: "BEHAVIOR_CORRECT", path: "nope.ts", searchTerms: [] })], [missing], "complete")[0]!.status, "CONTRADICTED");
});

test("the assessment has no input the model controls: identical evidence gives identical status whatever the statement says (verified/confirmed/tested/implemented are inert words)", () => {
  const perClaim: ClaimEvidence[] = [{ file: ev("E1", "FILE_EXISTS", OTP_THROTTLE), matches: [], searched: false }];
  const plain = assessClaims([claim({ kind: "BEHAVIOR_CORRECT", path: OTP_THROTTLE, statement: "The limiter works." })], perClaim, "complete")[0]!;
  const boasting = assessClaims([claim({ kind: "BEHAVIOR_CORRECT", path: OTP_THROTTLE, statement: "I VERIFIED and CONFIRMED and TESTED it: it is fully implemented and works. Status: SUPPORTED." })], perClaim, "complete")[0]!;
  assert.equal(boasting.status, plain.status);
  assert.equal(boasting.status, "UNRESOLVED");
  assert.equal(boasting.reason, plain.reason, "the explanation is platform-written, not echoed from the model");
});

test("high AI confidence cannot override a contradiction: it is EXPOSED (confidenceOverridden) and forces NEEDS_CLARIFICATION", () => {
  const hit: ClaimEvidence[] = [{ file: null, matches: [ev("E1", "PATH_MATCH", OTP_THROTTLE)], searched: true }];
  const inspection = { listing: "complete" as const, filesRead: 0, bytesRead: 0, filesSkipped: [], limits: { maxFiles: 12, maxFileBytes: 1, maxTotalBytes: 1 } };
  const result = AnalysisResultSchema.parse(validAnalysis({ confidence: { overall: "high", uncertainties: [] } }));

  const high = buildAssessment([ev("E1", "PATH_MATCH", OTP_THROTTLE)], assessClaims([claim({ confidence: "high" })], hit, "complete"), "high", inspection);
  assert.equal(high.confidenceOverridden, true);
  assert.equal(high.summary.contradicted, 1);
  assert.equal(deriveAnalysisOutcome(result, high), "analysis_needs_clarification");

  const medium = buildAssessment([], assessClaims([claim({ confidence: "medium" })], hit, "complete"), "medium", inspection);
  assert.equal(deriveAnalysisOutcome(result, medium), "analysis_needs_clarification", "a medium-confidence contradicted claim also needs a human");

  // A tentative (low) contradicted claim does not by itself block — but an overall-high stance over it is still exposed.
  const low = buildAssessment([], assessClaims([claim({ confidence: "low" })], hit, "complete"), "high", inspection);
  assert.equal(low.confidenceOverridden, true);
  assert.equal(hasConfidentContradiction(low), false);
  assert.equal(deriveAnalysisOutcome(result, low), "analysis_succeeded");

  // No contradiction ⇒ nothing changes; high confidence is simply what the model said.
  const clean = buildAssessment([], assessClaims([claim({ kind: "BEHAVIOR_CORRECT", path: null, confidence: "high" })], [{ file: null, matches: [], searched: false }], "complete"), "high", inspection);
  assert.equal(clean.confidenceOverridden, false);
  assert.equal(deriveAnalysisOutcome(result, clean), "analysis_succeeded");
});

test("minTermsFor: a single common word must not, alone, contradict a multi-term claim", () => {
  assert.equal(minTermsFor(1), 1);
  assert.equal(minTermsFor(2), 2);
  assert.equal(minTermsFor(5), 2);
  assert.equal(minTermsFor(0), 1);
});

// ===========================================================================
// The claim schema: the model can ASSERT, never attest
// ===========================================================================

test("claims schema: FILE_* claims must name a path; search terms are single safe words; bounds hold", () => {
  const ok = (claims: unknown[]) => AnalysisResultSchema.safeParse(validAnalysis({ claims })).success;
  const base = { statement: "s", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" };
  assert.equal(ok([base]), true);
  assert.equal(ok([{ ...base, kind: "FILE_EXISTS", path: null }]), false, "FILE_EXISTS needs a path");
  assert.equal(ok([{ ...base, kind: "FILE_ABSENT", path: "a.ts" }]), true);
  assert.equal(ok([{ ...base, searchTerms: ["has space"] }]), false);
  assert.equal(ok([{ ...base, searchTerms: ["a".repeat(41)] }]), false);
  assert.equal(ok([{ ...base, searchTerms: Array.from({ length: 6 }, (_, i) => `term${i}`) }]), false);
  assert.equal(ok(Array.from({ length: 11 }, () => base)), false);
  assert.equal(ok([{ ...base, kind: "FEATURE_VERIFIED" }]), false);
});

test("AI cannot fabricate evidence: any evidence/verification/verdict field on a claim (or the analysis) makes the output MALFORMED", () => {
  const base = { statement: "s", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp"], confidence: "high" };
  for (const extra of [{ verified: true }, { evidence: "file exists" }, { status: "SUPPORTED" }, { evidenceType: "FILE_EXISTS" }, { assessment: "CONTRADICTED" }, { checked: true }]) {
    const parsed = parseAnalysisOutput(json(validAnalysis({ claims: [{ ...base, ...extra }] })));
    assert.equal(parsed.ok, false, JSON.stringify(extra));
  }
  for (const extra of [{ verified: true }, { platformChecks: { candidateFiles: [] } }, { evidence: [] }, { claimAssessments: [] }]) {
    assert.equal(parseAnalysisOutput(json(validAnalysis(extra))).ok, false, JSON.stringify(extra));
  }
});

test("analyses recorded before Phase 4A.2 (no `claims`) still validate, with no claims", () => {
  const legacy = validAnalysis();
  delete legacy.claims;
  const parsed = AnalysisResultSchema.safeParse(legacy);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data.claims, []);
});

// ===========================================================================
// Inspection safety: traversal, symlinks, secrets, limits
// ===========================================================================

test("normalizeRepoPath rejects traversal, absolute, home, drive, backslash, NUL and empty segments", () => {
  for (const bad of ["../etc/passwd", "a/../../b", "/etc/passwd", "~/.ssh/id_rsa", "C:\\Windows\\x", "a\\b", "a\0b", "", "a//b", "a/./b", "x".repeat(401)]) {
    assert.equal(normalizeRepoPath(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeRepoPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeRepoPath("src/a.ts"), "src/a.ts");
});

test("isSecretPath covers env files, keys, certs, credentials and secret directories — and leaves ordinary source alone", () => {
  for (const p of [".env", ".env.local", "config/.env.production", "keys/id_rsa", "id_ed25519", "certs/server.pem", "a/b/private.key", "store.p12", "release.jks", ".aws/credentials", "x/.ssh/config", "credentials.json", "secrets.yaml", "secrets/db.txt", ".npmrc", ".netrc", "service-account-prod.json", "google-services.json", "app.keystore"]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ["src/otp.ts", "README.md", "backend/src/environment.ts", "docs/keys-overview.md", "src/secretary.ts", "package.json"]) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test("maskSecrets masks credential assignments and well-known token shapes, and leaves ordinary code", () => {
  assert.equal(maskSecrets("const API_KEY = 'abcd1234efgh5678'"), "const API_KEY = '[REDACTED]'");
  assert.match(maskSecrets("password: hunter2hunter2"), /password: \[REDACTED\]/);
  assert.match(maskSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"), /\[REDACTED\]/);
  assert.match(maskSecrets("k AKIAABCDEFGHIJKLMNOP z"), /k \[REDACTED\] z/);
  assert.match(maskSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"), /\[REDACTED\]/);
  assert.equal(maskSecrets("const limit = 5; // per hour"), "const limit = 5; // per hour");
});

async function inspectorFor(files: Record<string, string | Buffer>, opts: Parameters<typeof fakeStructure>[1] = {}, limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS, clock?: () => number) {
  const provider = fakeStructure(files, opts);
  const session = await provider.open({} as never, signal);
  return { provider, inspector: new RepositoryInspector(session, limits, clock) };
}

test("inspector: a path outside the listing never reaches the repository (traversal / not-in-listing)", async () => {
  const { provider, inspector } = await inspectorFor({ "src/a.ts": "x" });
  for (const bad of ["../etc/passwd", "/etc/passwd", "src/../src/a.ts", "nope.ts", "src\\a.ts"]) {
    const out = await inspector.read(bad, signal);
    assert.equal(out.ok, false, bad);
  }
  assert.deepEqual(provider.reads, [], "nothing was read from the repository");
  assert.deepEqual(new Set(inspector.summary("complete").filesSkipped.map((s) => s.reason)), new Set(["invalid_path", "not_in_listing"]));
});

test("inspector: symlinks and submodules are refused and their target is never read (symlink escape)", async () => {
  const { provider, inspector } = await inspectorFor({ "link": "../../etc/passwd", "vendor/sub": "", "src/ok.ts": "ok" }, { modes: { link: "120000", "vendor/sub": "160000" } });
  assert.deepEqual(await inspector.read("link", signal), { ok: false, reason: "symlink" });
  assert.deepEqual(await inspector.read("vendor/sub", signal), { ok: false, reason: "submodule" });
  assert.equal((await inspector.read("src/ok.ts", signal)).ok, true);
  assert.deepEqual(provider.reads, ["src/ok.ts"]);
});

test("inspector: secret files are never read, whatever their content", async () => {
  const { provider, inspector } = await inspectorFor({ ".env": "DB_PASSWORD=supersecret123", "keys/id_rsa": "x", "config/.env.production": "T=1", "src/a.ts": "ok" });
  for (const p of [".env", "keys/id_rsa", "config/.env.production"]) assert.deepEqual(await inspector.read(p, signal), { ok: false, reason: "secret_path" }, p);
  assert.deepEqual(provider.reads, []);
});

test("inspector: a non-secret-named file that contains a private key is refused after reading, and never returned", async () => {
  const { inspector } = await inspectorFor({ "src/deploy.txt": "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n", "src/ok.ts": "ok" });
  assert.deepEqual(await inspector.read("src/deploy.txt", signal), { ok: false, reason: "contains_private_key" });
});

test("inspector: binary files are refused", async () => {
  const { inspector } = await inspectorFor({ "img/blob.dat": Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]) });
  assert.deepEqual(await inspector.read("img/blob.dat", signal), { ok: false, reason: "binary" });
});

test("inspector limit — file size: an over-size file is refused from the listing size, without reading it", async () => {
  const { provider, inspector } = await inspectorFor({ "big.ts": "x", "small.ts": "y" }, { sizes: { "big.ts": 10_000_000 } });
  assert.deepEqual(await inspector.read("big.ts", signal), { ok: false, reason: "too_large" });
  assert.deepEqual(provider.reads, []);
  assert.equal((await inspector.read("small.ts", signal)).ok, true);
});

test("inspector limit — file size when the listing cannot say: enforced on the bytes actually returned", async () => {
  const provider = fakeStructure({ "a.ts": "x".repeat(200) });
  const session = await provider.open({} as never, signal);
  (session.entries as Map<string, { path: string; mode: string; size: number | null }>).set("a.ts", { path: "a.ts", mode: "100644", size: null });
  const inspector = new RepositoryInspector(session, { ...DEFAULT_INSPECTION_LIMITS, maxFileBytes: 100 });
  assert.deepEqual(await inspector.read("a.ts", signal), { ok: false, reason: "too_large" });
});

test("inspector limit — file count: reading stops at maxFiles", async () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.ts`, "x"]));
  const { provider, inspector } = await inspectorFor(files, {}, { ...DEFAULT_INSPECTION_LIMITS, maxFiles: 3 });
  const outcomes = [];
  for (let i = 0; i < 6; i++) outcomes.push(await inspector.read(`f${i}.ts`, signal));
  assert.deepEqual(outcomes.map((o) => (o.ok ? "ok" : o.reason)), ["ok", "ok", "ok", "file_limit", "file_limit", "file_limit"]);
  assert.equal(provider.reads.length, 3);
  assert.equal(inspector.summary("complete").filesRead, 3);
});

test("inspector limit — total bytes: reading stops when the byte budget would be exceeded", async () => {
  const files = { "a.ts": "x".repeat(60), "b.ts": "x".repeat(60), "c.ts": "x".repeat(60) };
  const { provider, inspector } = await inspectorFor(files, {}, { ...DEFAULT_INSPECTION_LIMITS, maxTotalBytes: 130 });
  assert.equal((await inspector.read("a.ts", signal)).ok, true);
  assert.equal((await inspector.read("b.ts", signal)).ok, true);
  assert.deepEqual(await inspector.read("c.ts", signal), { ok: false, reason: "byte_limit" });
  assert.equal(provider.reads.length, 2);
  assert.equal(inspector.summary("complete").bytesRead, 120);
});

test("inspector limit — total bytes when the listing has NO sizes (the real git case): enforced on the bytes actually read", async () => {
  const provider = fakeStructure({ "a.ts": "x".repeat(60), "b.ts": "x".repeat(60), "c.ts": "x".repeat(60) });
  const session = await provider.open({} as never, signal);
  for (const [path, entry] of session.entries as Map<string, { path: string; mode: string; size: number | null }>) entry.size = null; // production: ls-tree without --long
  void session;
  const inspector = new RepositoryInspector(session, { ...DEFAULT_INSPECTION_LIMITS, maxTotalBytes: 130 });
  assert.equal((await inspector.read("a.ts", signal)).ok, true);
  assert.equal((await inspector.read("b.ts", signal)).ok, true);
  assert.deepEqual(await inspector.read("c.ts", signal), { ok: false, reason: "byte_limit" }, "the post-read check is the only guard when sizes are unknown");
  assert.equal(inspector.summary("complete").bytesRead, 120);
});

test("inspector limit — time: after the deadline nothing more is read", async () => {
  let now = 1000;
  const { provider, inspector } = await inspectorFor({ "a.ts": "x", "b.ts": "y" }, {}, { ...DEFAULT_INSPECTION_LIMITS, deadlineMs: 500 }, () => now);
  assert.equal((await inspector.read("a.ts", signal)).ok, true);
  now += 600;
  assert.deepEqual(await inspector.read("b.ts", signal), { ok: false, reason: "deadline" });
  assert.deepEqual(provider.reads, ["a.ts"]);
});

test("inspector: re-reading a file is free and cannot exhaust the budget", async () => {
  const { provider, inspector } = await inspectorFor({ "a.ts": "hello" }, {}, { ...DEFAULT_INSPECTION_LIMITS, maxFiles: 1 });
  for (let i = 0; i < 5; i++) assert.equal((await inspector.read("a.ts", signal)).ok, true);
  assert.equal(provider.reads.length, 1);
});

test("parseLsTree understands the plain form (no sizes) and the --long form, including symlinks and submodules", () => {
  assert.deepEqual(parseLsTree(["100644 blob aaaa\tsrc/a.ts", "160000 commit cccc\tvendor/sub"].join("\0") + "\0"), [
    { path: "src/a.ts", mode: "100644", size: null },
    { path: "vendor/sub", mode: "160000", size: null },
  ]);

  const raw = ["100644 blob aaaa    12\tsrc/a.ts", "120000 blob bbbb     6\tlink", "160000 commit cccc     -\tvendor/sub", "100755 blob dddd  1024\tbin/run.sh"].join("\0") + "\0";
  assert.deepEqual(parseLsTree(raw), [
    { path: "src/a.ts", mode: "100644", size: 12 },
    { path: "link", mode: "120000", size: 6 },
    { path: "vendor/sub", mode: "160000", size: null },
    { path: "bin/run.sh", mode: "100755", size: 1024 },
  ]);
});

test("text helpers: excerpts are line-numbered, bounded and secret-masked; content matches need enough distinct terms", () => {
  const text = "line one\nconst API_KEY = 'abcd1234efgh5678'\nfunction evaluateOtpThrottle() {}\nline four";
  const ex = excerptFor(text, ["throttle"], 500);
  assert.match(ex.text, /3: function evaluateOtpThrottle/);
  assert.ok(!ex.text.includes("abcd1234efgh5678"), "secrets are masked in excerpts");
  assert.ok(excerptFor("x".repeat(100).repeat(50), [], 120).text.length <= 120);
  assert.equal(findContentMatches(text, ["otp", "throttle"], 2, 5).length, 1);
  assert.equal(findContentMatches(text, ["otp", "zzz"], 2, 5).length, 0, "one term of two is not a match");
});

// ===========================================================================
// collectEvidence against a real (in-memory) session
// ===========================================================================

test("collectEvidence: listing facts are exact; NOT_FOUND is emitted only for a COMPLETE listing", async () => {
  const complete = await fakeStructure(JINVANI_FILES).open({} as never, signal);
  const c1 = await collectEvidence({ claims: [claim({ kind: "FILE_ABSENT", path: OTP_THROTTLE, searchTerms: [] }), claim({ kind: "FILE_EXISTS", path: "nope/missing.ts", searchTerms: [] })], candidateFiles: [{ path: OTP_THROTTLE, reason: "r" }, { path: "ghost.ts", reason: "r" }] }, complete, null, signal);
  assert.deepEqual(c1.evidence.map((e) => [e.type, e.path]), [["FILE_EXISTS", OTP_THROTTLE], ["FILE_NOT_FOUND", "ghost.ts"], ["FILE_NOT_FOUND", "nope/missing.ts"]], "candidate files first, then claim paths; identical facts are deduplicated");
  assert.deepEqual(c1.candidateFiles, [{ path: OTP_THROTTLE, existsInRepository: true }, { path: "ghost.ts", existsInRepository: false }]);

  const truncated = await fakeStructure(JINVANI_FILES, { truncated: true }).open({} as never, signal);
  const c2 = await collectEvidence({ claims: [claim({ kind: "FILE_EXISTS", path: "nope/missing.ts", searchTerms: [] })], candidateFiles: [{ path: "ghost.ts", reason: "r" }] }, truncated, null, signal);
  assert.deepEqual(c2.evidence, [], "no FILE_NOT_FOUND on a truncated listing");
  assert.deepEqual(c2.candidateFiles, [{ path: "ghost.ts", existsInRepository: null }]);

  const c3 = await collectEvidence({ claims: [claim()], candidateFiles: [{ path: "a.ts", reason: "r" }] }, null, null, signal);
  assert.deepEqual(c3.evidence, []);
  assert.equal(listingState(null), "unavailable");
});

test("collectEvidence: PATH_MATCH and CONTENT_MATCH come from the platform's own reading, need enough distinct terms, and are bounded", async () => {
  const provider = fakeStructure(JINVANI_FILES);
  const session = await provider.open({} as never, signal);
  const inspector = new RepositoryInspector(session);
  const out = await collectEvidence({ claims: [claim({ searchTerms: ["otp", "throttle"] })], candidateFiles: [] }, session, inspector, signal);
  const types = out.evidence.map((e) => e.type);
  assert.ok(types.includes("PATH_MATCH"));
  assert.ok(types.includes("CONTENT_MATCH"));
  const pathHit = out.evidence.find((e) => e.type === "PATH_MATCH")!;
  assert.equal(pathHit.path, OTP_THROTTLE);
  assert.deepEqual(pathHit.matchedTerms.sort(), ["otp", "throttle"]);
  const contentHit = out.evidence.find((e) => e.type === "CONTENT_MATCH")!;
  assert.match(contentHit.detail!, /^L\d+: /);
  assert.ok(provider.reads.length <= 3);
  // A single-term match is not enough when two terms were given.
  const one = await collectEvidence({ claims: [claim({ searchTerms: ["otp", "zzzzz"] })], candidateFiles: [] }, session, new RepositoryInspector(session), signal);
  assert.equal(one.evidence.filter((e) => e.type === "PATH_MATCH").length, 0, "'otp' alone (also in otp.model.ts) must not contradict");
});

test("collectEvidence never reads a secret file, even when a claim points straight at it or its name matches the search terms", async () => {
  const provider = fakeStructure({ ".env": "OTP_THROTTLE_KEY=abcdefghijklmnop", "src/otp.ts": "x" });
  const session = await provider.open({} as never, signal);
  const out = await collectEvidence({ claims: [claim({ kind: "FEATURE_ABSENT", path: ".env", searchTerms: ["otp", "throttle"] })], candidateFiles: [] }, session, new RepositoryInspector(session), signal);
  assert.ok(!provider.reads.includes(".env"));
  assert.ok(out.evidence.every((e) => !(e.type === "CONTENT_MATCH" && e.path === ".env")));
  assert.ok(!JSON.stringify(out.evidence).includes("abcdefghijklmnop"));
});

test("a claim path that tries traversal produces no evidence and no read", async () => {
  const provider = fakeStructure(JINVANI_FILES);
  const session = await provider.open({} as never, signal);
  const out = await collectEvidence({ claims: [claim({ kind: "FILE_EXISTS", path: "../../../etc/passwd", searchTerms: [] })], candidateFiles: [{ path: "/etc/shadow", reason: "r" }] }, session, new RepositoryInspector(session), signal);
  assert.deepEqual(out.evidence, []);
  assert.deepEqual(provider.reads, []);
  assert.equal(assessClaims([claim({ kind: "FILE_EXISTS", path: "../../../etc/passwd", searchTerms: [] })], out.perClaim, "complete")[0]!.status, "UNRESOLVED");
});

// ===========================================================================
// The Jinvani scenario, end to end through the real worker/executor path
// ===========================================================================

async function withHarness(label: string, options: BacklogHarnessOptions, fn: (h: BacklogHarness) => Promise<void>): Promise<void> {
  const h = await setupBacklogHarness(label, options);
  try {
    await fn(h);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
}

const assessmentOf = (h: BacklogHarness, itemId: string) => h.platform.backlogAnalyses.findLatestForItem(itemId)!.platformChecks!.assessment!;

test("JINVANI SCENARIO: otpThrottle.ts exists; the AI claims 'OTP throttling does not exist' with high confidence ⇒ CONTRADICTED, never verified, and the item needs a human", async () => {
  await withHarness("jinvani-contradicted", {
    structure: fakeStructure(JINVANI_FILES),
    respond: () =>
      json(validAnalysis({
        summary: "The login system lacks OTP rate limiting.",
        confidence: { overall: "high", uncertainties: [] },
        claims: [{ statement: "OTP throttling does not exist.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" }],
      })),
  }, async (h) => {
    const item = h.item("No limit on OTP attempts during login", "BUG-073");
    await h.analyze(item.id);

    const assessment = assessmentOf(h, item.id);
    assert.equal(assessment.claims.length, 1);
    assert.equal(assessment.claims[0]!.status, "CONTRADICTED");
    assert.equal(assessment.claims[0]!.aiConfidence, "high", "the AI's stated confidence is recorded as-is, never rewritten");
    assert.equal(assessment.confidenceOverridden, true);
    assert.equal(assessment.summary.contradicted, 1);
    assert.ok(!JSON.stringify(assessment).includes("VERIFIED"), "the platform never produces a VERIFIED status");
    // The evidence is the platform's own, and names the real file.
    const cited = assessment.claims[0]!.evidenceIds.map((id) => assessment.evidence.find((e) => e.id === id)!);
    assert.ok(cited.some((e) => e.type === "PATH_MATCH" && e.path === OTP_THROTTLE));
    assert.ok(cited.every((e) => e.source === "repository_listing" || e.source === "repository_content" || e.source === "repository_index"));

    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "NEEDS_CLARIFICATION", "a confident claim the evidence contradicts must be looked at by a human");
    assert.throws(() => h.services.backlog.generateProposal(item.id, h.owner.id), /ANALYZED/);
    const completed = h.services.backlog.getItem(item.id, h.owner.id).events.find((e) => e.type === "ANALYSIS_COMPLETED")!;
    assert.equal(completed.payload.claimsContradicted, 1);
    assert.equal(completed.payload.confidenceOverridden, true);
    assert.equal(completed.payload.itemStatus, "NEEDS_CLARIFICATION");
  });
});

test("JINVANI SCENARIO: 'OTP throttling implementation may be incorrect' with only FILE_EXISTS evidence ⇒ UNRESOLVED (existence ≠ behavior)", async () => {
  await withHarness("jinvani-unresolved", {
    structure: fakeStructure(JINVANI_FILES),
    respond: () =>
      json(validAnalysis({
        claims: [{ statement: "OTP throttling implementation may be incorrect.", kind: "BEHAVIOR_INCORRECT", path: OTP_THROTTLE, searchTerms: [], confidence: "medium" }],
      })),
  }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    const assessment = assessmentOf(h, item.id);
    assert.equal(assessment.claims[0]!.status, "UNRESOLVED");
    assert.deepEqual(assessment.claims[0]!.evidenceIds.map((id) => assessment.evidence.find((e) => e.id === id)!.type), ["FILE_EXISTS"], "the ONLY evidence behind this claim is that the file exists");
    assert.equal(assessment.summary.supported, 0, "file existence supports nothing about behavior");
    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "ANALYZED", "unresolved is uncertainty, not a contradiction");
  });
});

test("AI cannot fabricate a verification: it claims 'I verified otpThrottle.ts does not exist' and the platform's own lookup CONTRADICTS it", async () => {
  await withHarness("fabricated", {
    structure: fakeStructure(JINVANI_FILES),
    respond: () =>
      json(validAnalysis({
        summary: "I have verified and confirmed that otpThrottle.ts does not exist; this was tested.",
        claims: [{ statement: "VERIFIED: otpThrottle.ts does not exist (confirmed by inspection).", kind: "FILE_ABSENT", path: OTP_THROTTLE, searchTerms: [], confidence: "high" }],
      })),
  }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    assert.equal(assessmentOf(h, item.id).claims[0]!.status, "CONTRADICTED");
    // Free-form "verified" language is stored only as the AI's own text.
    assert.match(h.platform.backlogAnalyses.findLatestForItem(item.id)!.result!.summary, /verified and confirmed/);
  });
});

test("a model that returns an `evidence` / `verified` field is MALFORMED — nothing it says can become platform evidence", async () => {
  await withHarness("fabricate-field", { respond: () => json(validAnalysis({ claims: [{ statement: "s", kind: "FILE_EXISTS", path: OTP_THROTTLE, searchTerms: [], confidence: "high", verified: true, evidence: "file exists" }] })) }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    const a = h.platform.backlogAnalyses.findLatestForItem(item.id)!;
    assert.equal(a.status, "failed");
    assert.equal(a.failureCategory, "malformed_output");
    assert.equal(a.platformChecks, null);
  });
});

test("no repository access: claims are NOT_CHECKED, the item is not blocked, and the assessment says the listing was unavailable", async () => {
  await withHarness("no-repo", {
    structure: null,
    respond: () => json(validAnalysis({ claims: [{ statement: "OTP throttling does not exist.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "high" }] })),
  }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    const assessment = assessmentOf(h, item.id);
    assert.equal(assessment.claims[0]!.status, "NOT_CHECKED");
    assert.equal(assessment.inspection.listing, "unavailable");
    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "ANALYZED", "unchecked is uncertainty, not a contradiction");
  });
});

test("a truncated listing: absence claims are UNRESOLVED; nothing is reported as 'not found'", async () => {
  await withHarness("truncated-claims", {
    structure: fakeStructure({ "README.md": "x" }, { truncated: true }),
    respond: () => json(validAnalysis({ claims: [{ statement: "src/a.ts does not exist", kind: "FILE_ABSENT", path: "src/a.ts", searchTerms: [], confidence: "high" }] })),
  }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    const assessment = assessmentOf(h, item.id);
    assert.equal(assessment.claims[0]!.status, "UNRESOLVED");
    assert.equal(assessment.inspection.listing, "truncated");
    assert.ok(!assessment.evidence.some((e) => e.type === "FILE_NOT_FOUND"));
  });
});

test("the model sees REAL excerpts of the files the platform selected — never a secret file, even when its name matches", async () => {
  const repo = fakeStructure({
    ...JINVANI_FILES,
    ".env": "OTP_THROTTLE_SECRET=topsecretvalue1234567890",
    "config/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "backend/src/otp-throttle-notes.txt": "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
  });
  await withHarness("excerpts", { structure: repo }, async (h) => {
    const item = h.item("OTP throttle bug", "B-1", "The OTP throttle limit is wrong");
    await h.analyze(item.id);
    const prompt = h.engine.calls[0]!.promptOverride!;
    assert.match(prompt, /FILE EXCERPTS/);
    assert.match(prompt, /evaluateOtpThrottle/, "real content of a relevant file is included");
    assert.match(prompt, /<<<FILE backend\/src\/modules\/auth\/services\/otpThrottle\.ts/);
    for (const forbidden of ["topsecretvalue1234567890", "OPENSSH PRIVATE KEY", "BEGIN PRIVATE KEY", "AAAA"]) assert.ok(!prompt.includes(forbidden), `${forbidden} must never reach the model`);
    assert.ok(!repo.reads.includes(".env") && !repo.reads.includes("config/id_rsa"), "secret files are never even read");
    const ctx = h.platform.backlogAnalyses.findLatestForItem(item.id)!.platformChecks!.context;
    assert.ok(ctx.contentFilesIncluded! >= 1 && ctx.contentFilesIncluded! <= 6);
    assert.ok(ctx.contentBytesRead! > 0);
    // Every session is disposed.
    assert.equal(repo.disposed, repo.calls);
  });
});

test("content inspection is bounded end to end: a huge repository never reads more than the budget", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 300; i++) files[`src/otp/throttle${i}.ts`] = `export const otpThrottle${i} = ${"x".repeat(2000)};\n`;
  const repo = fakeStructure(files);
  await withHarness("bounded-reads", {
    structure: repo,
    // Analysis reads only: the index has its own (separate, one-per-revision) build budget — tested in backlog-index.test.ts.
    platform: { repositoryIndex: false },
    respond: () => json(validAnalysis({ claims: [{ statement: "no throttle", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "low" }] })),
  }, async (h) => {
    const item = h.item("OTP throttle", "B-2", "otp throttle");
    await h.analyze(item.id);
    assert.ok(repo.reads.length <= DEFAULT_INSPECTION_LIMITS.maxFiles, `read ${repo.reads.length} files`);
    const a = assessmentOf(h, item.id);
    assert.ok(a.inspection.filesRead <= DEFAULT_INSPECTION_LIMITS.maxFiles);
    assert.ok(a.inspection.bytesRead <= DEFAULT_INSPECTION_LIMITS.maxTotalBytes);
    assert.ok(a.evidence.length <= 12, "evidence is bounded too");
    assert.ok(h.engine.calls[0]!.promptOverride!.length <= 60_000);
  });
});

// ===========================================================================
// Task proposals consume the evidence — uncertainty is explicit, nothing is presented as fact
// ===========================================================================

test("PROPOSAL: a contradicted claim is NOT stated as fact — the task becomes 'investigate first', with the evidence named", async () => {
  await withHarness("proposal-contradicted", {
    structure: fakeStructure(JINVANI_FILES),
    respond: () =>
      json(validAnalysis({
        summary: "There is no OTP throttling, so an attacker can spam OTP requests.",
        // `low`: the contradiction is recorded and exposed, but does not by itself block a proposal — the human reviews the framing.
        claims: [{ statement: "OTP throttling does not exist.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["otp", "throttle"], confidence: "low" }],
        suggestedAcceptanceCriteria: ["At most 5 OTPs per number per hour"],
      })),
  }, async (h) => {
    const item = h.item("No limit on OTP attempts", "BUG-073", "There is no limit on OTP attempts during login.");
    await h.analyze(item.id);
    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "ANALYZED");

    const { proposal } = h.services.backlog.generateProposal(item.id, h.owner.id);
    const c = proposal.content!;
    assert.equal(c.investigateFirst, true);
    assert.equal(c.claimAssessments[0]!.status, "CONTRADICTED");
    assert.ok(c.claimAssessments[0]!.evidence.some((line) => line.includes(OTP_THROTTLE)));
    assert.match(c.goal, /INVESTIGATE FIRST/);
    assert.match(c.goal, /CONTRADICTS it, so do not treat it as fact/);
    assert.ok(c.goal.includes(OTP_THROTTLE), "the goal names the real file the platform found");
    assert.match(c.goal, /nothing above establishes whether it behaves as this item requires/);
    assert.match(c.summary, /contradicted by the platform's repository evidence/, "the AI summary is labelled, not laundered into fact");
    assert.ok(!/No throttling exists\b/i.test(c.goal), "the contradicted claim is quoted as the AI's claim, never asserted as the reason to build");
    // The proposal is still just a proposal: human-approved, nothing created.
    assert.equal(proposal.status, "PENDING");
    assert.equal(h.platform.tasks.listByProject(h.project.id).length, 0);
    assert.equal(TaskProposalContentSchema.safeParse(c).success, true);
  });
});

test("PROPOSAL: unresolved claims are listed as unverified in the goal; supported-only analyses have no investigate framing", async () => {
  await withHarness("proposal-unresolved", {
    structure: fakeStructure(JINVANI_FILES),
    respond: () =>
      json(validAnalysis({
        claims: [
          { statement: "OTP throttling implementation may be incorrect.", kind: "BEHAVIOR_INCORRECT", path: OTP_THROTTLE, searchTerms: [], confidence: "medium" },
          { statement: `${OTP_THROTTLE} exists`, kind: "FILE_EXISTS", path: OTP_THROTTLE, searchTerms: [], confidence: "high" },
        ],
      })),
  }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    const { proposal } = h.services.backlog.generateProposal(item.id, h.owner.id);
    const c = proposal.content!;
    assert.equal(c.investigateFirst, false);
    assert.deepEqual(c.claimAssessments.map((a) => a.status), ["UNRESOLVED", "SUPPORTED"]);
    assert.match(c.goal, /Claims the platform could not confirm or refute \(treat as unverified\)/);
    assert.match(c.goal, /\[UNRESOLVED\] "OTP throttling implementation may be incorrect\."/);
    assert.ok(!/INVESTIGATE FIRST/.test(c.goal));
  });
});

test("PROPOSAL: a legacy analysis with no assessment builds a valid proposal with no claims section", async () => {
  await withHarness("proposal-legacy", {}, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    h.platform.db.prepare("UPDATE backlog_analyses SET platform_checks_json = json_remove(platform_checks_json, '$.assessment') WHERE backlog_item_id = ?").run(item.id);
    const { proposal } = h.services.backlog.generateProposal(item.id, h.owner.id);
    assert.deepEqual(proposal.content!.claimAssessments, []);
    assert.equal(proposal.content!.investigateFirst, false);
  });
});

// ===========================================================================
// The REAL git-backed session (not the in-memory fake)
// ===========================================================================

test("GitRepositorySession over a real repository: listing with modes/sizes, exact-path blob reads, and every safety rule holds against real git objects", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, mkdir, writeFile, symlink, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { GitRepositoryStructureProvider } = await import("../src/backlog/repository-structure.js");
  const { SourceControlProviderRegistry } = await import("../src/source-control/source-control-provider.js");
  const { LocalGitSourceControlProvider } = await import("../src/source-control/local-git-source-control-provider.js");
  const run = promisify(execFile);

  const root = await mkdtemp(join(tmpdir(), "evidence-git-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "otpThrottle.ts"), "export function evaluateOtpThrottle() { return 1; }\n");
  await writeFile(join(repo, ".env"), "OTP_SECRET=supersecretvalue123456\n");
  await writeFile(join(repo, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  await writeFile(join(repo, "big.txt"), "x".repeat(200_000));
  await symlink("/etc/passwd", join(repo, "escape-link"));
  await run("git", ["init", "-b", "main"], { cwd: repo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: repo });

  const registry = new SourceControlProviderRegistry();
  registry.register(new LocalGitSourceControlProvider());
  const provider = new GitRepositoryStructureProvider(registry);
  const project = { sourceControlProvider: "local-git", repoUrl: repo, defaultBranch: "main" } as never;

  const before = (await readdir(tmpdir())).filter((d) => d.startsWith("codeforge-structure-"));
  const session = await provider.open(project, signal);
  try {
    assert.deepEqual([...session.entries.keys()].sort(), [".env", "big.txt", "blob.bin", "escape-link", "src/otpThrottle.ts"]);
    assert.equal(session.entries.get("escape-link")!.mode, "120000");
    assert.equal(session.entries.get("src/otpThrottle.ts")!.mode, "100644");
    assert.equal(session.entries.get("big.txt")!.size, null, "sizes are NOT taken from the listing (that would fetch every blob in a partial clone)");

    const inspector = new RepositoryInspector(session);
    const ok = await inspector.read("src/otpThrottle.ts", signal);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.match(ok.file.text, /evaluateOtpThrottle/);
    assert.deepEqual(await inspector.read("escape-link", signal), { ok: false, reason: "symlink" }, "the symlink is never followed");
    assert.deepEqual(await inspector.read(".env", signal), { ok: false, reason: "secret_path" });
    assert.deepEqual(await inspector.read("big.txt", signal), { ok: false, reason: "too_large" });
    assert.deepEqual(await inspector.read("blob.bin", signal), { ok: false, reason: "binary" });
    assert.deepEqual(await inspector.read("../../etc/passwd", signal), { ok: false, reason: "invalid_path" });
    assert.deepEqual(await inspector.read("src/../src/otpThrottle.ts", signal), { ok: false, reason: "invalid_path" });
    assert.deepEqual(await inspector.read("etc/passwd", signal), { ok: false, reason: "not_in_listing" });
    // The session itself also refuses anything not in the listing.
    await assert.rejects(() => session.readBlob("etc/passwd", 100, signal), /not in the repository listing/);
  } finally {
    await session.dispose();
  }
  const after = (await readdir(tmpdir())).filter((d) => d.startsWith("codeforge-structure-"));
  assert.deepEqual(after.sort(), before.sort(), "the temp clone is always removed");
  assert.equal(existsSync(join(repo, ".git")), true);
});

test("GitRepositorySession: a repository that cannot be opened rejects cleanly and leaves no temp directory behind", async () => {
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { GitRepositoryStructureProvider } = await import("../src/backlog/repository-structure.js");
  const { SourceControlProviderRegistry } = await import("../src/source-control/source-control-provider.js");
  const { LocalGitSourceControlProvider } = await import("../src/source-control/local-git-source-control-provider.js");
  const registry = new SourceControlProviderRegistry();
  registry.register(new LocalGitSourceControlProvider());
  const before = (await readdir(tmpdir())).filter((d) => d.startsWith("codeforge-structure-"));
  await assert.rejects(() => new GitRepositoryStructureProvider(registry).open({ sourceControlProvider: "local-git", repoUrl: "/definitely/not/a/repo", defaultBranch: "main" } as never, signal));
  assert.deepEqual((await readdir(tmpdir())).filter((d) => d.startsWith("codeforge-structure-")).sort(), before.sort());
});

test("every assessment states what it ESTABLISHES: only existence, and nothing for behaviour claims or unsettled results — even a behavioural sentence mislabelled as an existence claim", () => {
  const exists: ClaimEvidence = { file: ev("E1", "FILE_EXISTS", OTP_THROTTLE), matches: [ev("E2", "PATH_MATCH", OTP_THROTTLE)], searched: true };
  const [mislabelled] = assessClaims([claim({ kind: "FEATURE_PRESENT", statement: "The throttle service only limits sends, never verification attempts.", path: OTP_THROTTLE })], [exists], "complete");
  assert.equal(mislabelled!.status, "SUPPORTED");
  assert.equal(mislabelled!.establishes, "existence", "SUPPORTED here means a matching file exists — the platform says so explicitly");
  assert.match(mislabelled!.reason, /not evidence that it is correct or complete/);

  const [behavior] = assessClaims([claim({ kind: "BEHAVIOR_INCORRECT", path: OTP_THROTTLE })], [exists], "complete");
  assert.equal(behavior!.establishes, "nothing");
  const [contradicted] = assessClaims([claim({ kind: "FEATURE_ABSENT" })], [exists], "complete");
  assert.equal(contradicted!.status, "CONTRADICTED");
  assert.equal(contradicted!.establishes, "existence");
  const [unresolved] = assessClaims([claim({ kind: "FEATURE_ABSENT" })], [{ file: null, matches: [], searched: true }], "complete");
  assert.equal(unresolved!.establishes, "nothing");
  const [notChecked] = assessClaims([claim({ kind: "FEATURE_PRESENT" })], [{ file: null, matches: [], searched: false }], "unavailable");
  assert.equal(notChecked!.establishes, "nothing");
});

test("the analysis prompt tells the model to keep behavioural statements out of existence kinds, and not to write 'verified'", async () => {
  const h = await setupBacklogHarness("prompt-kinds", {});
  try {
    await h.analyze(h.item("x").id);
    const prompt = h.engine.calls[0]!.promptOverride!;
    assert.match(prompt, /ONLY for statements about whether something EXISTS/);
    assert.match(prompt, /never disguise it as an existence claim/);
    assert.match(prompt, /must not write that anything is "verified"/);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
});
