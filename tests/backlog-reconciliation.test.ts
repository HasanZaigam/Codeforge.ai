import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, assertsAbsence, assertsExplicitAbsence } from "../src/backlog/reconciliation.js";
import { collectEvidence, findReferences } from "../src/backlog/evidence.js";
import { applyVerification, planVerification, type VerificationRun } from "../src/backlog/verification.js";
import { buildRepositoryIndex, sourceKeyOf } from "../src/backlog/repository-index.js";
import { parseAnalysisOutput } from "../src/backlog/analysis-schema.js";
import { deriveAnalysisOutcome } from "../src/backlog/backlog-state-machine.js";
import type { AnalysisClaim, ClaimAssessment, EvidenceAssessment, PlatformEvidence } from "../src/backlog/backlog-types.js";
import { fakeStructure, json, setupBacklogHarness, validAnalysis, type BacklogHarness, type BacklogHarnessOptions } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.4 — evidence-aware reconciliation. Three objects stay separate (AI CLAIM · PLATFORM EVIDENCE ·
 * RECONCILIATION). The platform, never the model, decides how they relate. An IMPLEMENTATION ABSENCE claim can be
 * contradicted by strong structural evidence; a BEHAVIOUR claim never can (existence ≠ behaviour); nothing here
 * ever says "fixed". These are DETERMINISTIC FIXTURE tests — they are not evidence about any real model.
 */

const signal = new AbortController().signal;
const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

const SERVICE = "backend/src/modules/profiles/services/profile.service.ts";
const REPO: Record<string, string> = {
  [SERVICE]: [
    "export const getProfileDeleteBlocker = (profile: { isPrimary: boolean }, total: number): string | null => {",
    "  if (profile.isPrimary) return \"The main profile can't be deleted\";",
    "  return null;",
    "};",
    "export class ProfileService {",
    "  async deleteProfile(userId: string, profileId: string) {",
    "    const blockerMessage = getProfileDeleteBlocker({ isPrimary: true }, 3);",
    "    if (blockerMessage) throw new Error(blockerMessage);",
    "  }",
    "}",
  ].join("\n"),
  "backend/src/modules/profiles/controllers/profile.controller.ts": "export const deleteProfileHandler = async (req, res) => { await profileService.deleteProfile(req.user, req.params.id); };\n",
  // Declared but NEVER referenced anywhere in the file: existence only, not "wired in".
  "backend/src/modules/user/services/user.service.ts": "export function validateNewMobile(n: string) { return n.length === 10; }\nexport class UserService {}\n",
  "README.md": "# Jinvani\n",
};

async function withHarness(label: string, options: BacklogHarnessOptions, fn: (h: BacklogHarness) => Promise<void>): Promise<void> {
  const h = await setupBacklogHarness(label, options);
  try {
    await fn(h);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
}
const claim = (over: Partial<AnalysisClaim>): AnalysisClaim => ({ statement: "x", kind: "FEATURE_ABSENT", path: null, searchTerms: [], confidence: "high", ...over });
const assessmentOf = (h: BacklogHarness, itemId: string) => h.platform.backlogAnalyses.findLatestForItem(itemId)!.platformChecks!.assessment!;

// ===========================================================================
// Classification: what does the claim ASSERT? (independent of the `kind` the model chose)
// ===========================================================================

test("wording: explicit existence-absence vs broad negation vs behaviour", () => {
  for (const s of ["The project has no OTP validation implementation.", "There is no rate limiting.", "Nothing enforces the limit.", "OTP throttling is not implemented.", "A check is missing."]) {
    assert.equal(assertsExplicitAbsence(s), true, s);
  }
  for (const s of ["The OTP change endpoint does not validate the new number.", "Deletion happens without any validation.", "The endpoint lacks OTP verification."]) {
    assert.equal(assertsExplicitAbsence(s), false, `${s} is NOT an explicit existence claim`);
    assert.equal(assertsAbsence(s), true, `${s} is broadly negative`);
  }
  for (const s of ["Users can delete every profile.", "The API returns 500 on bad input.", "The limiter works correctly."]) assert.equal(assertsAbsence(s), false, s);
});

test("findReferences: declared once, used elsewhere ⇒ wired in; declared and never used ⇒ null", () => {
  assert.deepEqual(findReferences("const foo = 1;\nfoo();\nfoo();", "foo"), { declaredAt: 1, count: 2, firstReference: { line: 2, excerpt: "foo();" } });
  assert.equal(findReferences("const foo = 1;\nconst foobar = 2;", "foo"), null, "a longer identifier is not a use");
  assert.equal(findReferences("const $x = 1;\n$x++;", "$x")?.firstReference.line, 2, "regex metacharacters in names are escaped");
});

// ===========================================================================
// DETERMINISTIC CONTRADICTION FIXTURE (end to end through the real worker path)
// ===========================================================================

test("DETERMINISTIC FIXTURE — explicit absence claim vs declared-AND-wired-in code ⇒ IMPLEMENTATION_PRESENT (strong); item needs a human; nothing says 'fixed' or 'verified'", async () => {
  await withHarness("recon-strong", {
    structure: fakeStructure(REPO),
    respond: () =>
      json(validAnalysis({
        // `low` confidence: the strong conflict must stop the item regardless of what the model said about itself.
        claims: [{ statement: "There is no deletion blocker check for profiles.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["delete", "profile", "blocker"], confidence: "low" }],
        confidence: { overall: "low", uncertainties: [] },
      })),
  }, async (h) => {
    const item = h.item("Profile deletion is unguarded", "B-1", "The main profile can be deleted.");
    await h.analyze(item.id);
    const a = assessmentOf(h, item.id);
    // 1. AI CLAIM (unchanged) · 2. PLATFORM EVIDENCE · 3. RECONCILIATION — three separate objects.
    assert.equal(h.platform.backlogAnalyses.findLatestForItem(item.id)!.result!.claims[0]!.kind, "FEATURE_ABSENT");
    assert.equal(a.claims[0]!.status, "CONTRADICTED");
    const types = a.evidence.map((e) => e.type);
    assert.ok(types.includes("SYMBOL_MATCH") && types.includes("SYMBOL_REFERENCE"), `evidence: ${types}`);
    const ref = a.evidence.find((e) => e.type === "SYMBOL_REFERENCE")!;
    assert.equal(ref.path, SERVICE);
    assert.match(ref.detail!, /getProfileDeleteBlocker: declared L1, referenced L7/);
    assert.equal(ref.revision, "a".repeat(40));

    const r = a.reconciliation!;
    assert.equal(r.revision, "a".repeat(40));
    assert.equal(r.alreadyImplemented, "strong");
    assert.equal(r.behaviorVerified, false);
    const f = r.findings[0]!;
    assert.equal(f.outcome, "IMPLEMENTATION_PRESENT");
    assert.equal(f.strength, "strong");
    assert.equal(f.behaviorVerified, false);
    assert.match(f.explanation, /inconsistent with the current revision/);
    assert.match(f.explanation, /Behavioral correctness was not verified\./);
    assert.doesNotMatch(JSON.stringify(r), /\bfixed\b|BUG FIXED|correct implementation/i);
    // A human must look; the item is not closed, converted, or given a task.
    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "NEEDS_CLARIFICATION");
    assert.equal((h.platform.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);
  });
});

test("FILE_ABSENT claim about a file that exists ⇒ strong (direct); a single generic term is never enough for a conflict", () => {
  const ev = (id: string, type: PlatformEvidence["type"], path: string | null, revision: string | null = REV_A): PlatformEvidence => ({ id, type, source: "repository_listing", path, detail: null, matchedTerms: [], revision });
  const mk = (c: AnalysisClaim, evidence: PlatformEvidence[]) => {
    const ca: ClaimAssessment = { claimIndex: 0, statement: c.statement, kind: c.kind, aiConfidence: c.confidence, status: "CONTRADICTED", establishes: "existence", evidenceIds: evidence.map((e) => e.id), reason: "r" };
    return reconcile([c], { claims: [ca], evidence, verification: [] }, REV_A);
  };
  assert.equal(mk(claim({ kind: "FILE_ABSENT", path: "a.ts" }), [ev("E1", "FILE_EXISTS", "a.ts")]).findings[0]!.outcome, "IMPLEMENTATION_PRESENT");
  // Wired in, but the claim only has ONE search term ⇒ not specific enough ⇒ only POSSIBLE.
  const one = mk(claim({ searchTerms: ["delete"] }), [ev("E1", "SYMBOL_MATCH", "a.ts"), ev("E2", "SYMBOL_REFERENCE", "a.ts")]);
  assert.equal(one.findings[0]!.outcome, "IMPLEMENTATION_POSSIBLE");
  assert.equal(one.alreadyImplemented, "possible");
  // Nothing found ⇒ UNRESOLVED (a bounded search proves nothing), never NO_CONFLICT-as-proof.
  const none = mk(claim({ searchTerms: ["delete", "profile"] }), []);
  assert.equal(none.findings[0]!.outcome, "UNRESOLVED");
  assert.equal(none.alreadyImplemented, "none");
});

// ===========================================================================
// BEHAVIOUR claims stay UNRESOLVED — existence never proves behaviour
// ===========================================================================

test("the brief's OTP example: 'endpoint does not validate the new number' + endpoint and validator EXIST (not wired) ⇒ UNRESOLVED, no conflict, item not blocked", async () => {
  await withHarness("recon-otp", {
    structure: fakeStructure(REPO),
    respond: () =>
      json(validAnalysis({
        claims: [{ statement: "The OTP change endpoint does not validate the new number.", kind: "BEHAVIOR_INCORRECT", path: null, searchTerms: ["validate", "mobile"], confidence: "high" }],
      })),
  }, async (h) => {
    const item = h.item("Mobile change is unchecked", "B-2", "Anyone can change the mobile number.");
    await h.analyze(item.id);
    const a = assessmentOf(h, item.id);
    assert.ok(a.evidence.some((e) => e.type === "SYMBOL_MATCH" && e.path!.endsWith("user.service.ts")), "the validator DOES exist — platform evidence");
    assert.ok(!a.evidence.some((e) => e.type === "SYMBOL_REFERENCE"), "…but is not shown to be wired in");
    assert.equal(a.claims[0]!.status, "UNRESOLVED");
    assert.equal(a.reconciliation!.findings[0]!.outcome, "UNRESOLVED");
    assert.equal(a.reconciliation!.findings[0]!.claimClass, "behavior");
    assert.equal(a.reconciliation!.alreadyImplemented, "none");
    assert.equal(a.reconciliation!.behaviorVerified, false);
    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "ANALYZED");
  });
});

test("the brief's flagship: 'deletion does not check whether it is allowed' + blocker declared AND referenced ⇒ IMPLEMENTATION_PRESENT (weak, behaviour-worded) — a lead, status still UNRESOLVED, item not blocked", async () => {
  await withHarness("recon-flagship", {
    structure: fakeStructure(REPO),
    respond: () =>
      json(validAnalysis({
        claims: [{ statement: "Profile deletion does not check whether deletion is allowed.", kind: "BEHAVIOR_INCORRECT", path: null, searchTerms: ["delete", "profile", "blocker"], confidence: "high" }],
      })),
  }, async (h) => {
    const item = h.item("Profile deletion unchecked", "B-3", "A user can delete their main profile.");
    await h.analyze(item.id);
    const a = assessmentOf(h, item.id);
    assert.equal(a.claims[0]!.status, "UNRESOLVED", "a behaviour-worded claim never becomes CONTRADICTED");
    const f = a.reconciliation!.findings[0]!;
    assert.equal(f.outcome, "IMPLEMENTATION_PRESENT");
    assert.equal(f.strength, "weak");
    assert.equal(f.labelledAsBehavior, true);
    assert.match(f.explanation, /Implementation evidence conflicts with the reported absence/);
    assert.match(f.explanation, /not a conclusion/);
    assert.equal(a.reconciliation!.alreadyImplemented, "possible");
    assert.equal(h.platform.backlogItems.findById(item.id)!.status, "ANALYZED", "'possible' is shown, it does not block or close anything");

    // The proposal carries the signal and becomes an INVESTIGATION — never "fixed", never an automatic change task.
    const { proposal } = h.services.backlog.generateProposal(item.id, h.owner.id);
    const c = proposal.content!;
    assert.equal(c.implementationConflict, "possible");
    assert.equal(c.investigateFirst, true);
    assert.match(c.goal, /IMPLEMENTATION EVIDENCE CONFLICTS WITH THE REPORTED ABSENCE \(possible\)/);
    assert.match(c.goal, /does NOT mean the item is fixed/);
    assert.match(c.goal, /SYMBOL_REFERENCE/);
    assert.doesNotMatch(c.goal, /BUG FIXED|is fixed\b(?! or)/);
    // Human approval is still required, then still a human Start: conversion before approval is refused.
    await assert.rejects(() => h.services.backlog.convertProposal(proposal.id, h.owner.id), /must be approved/);
    assert.equal((h.platform.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);
    h.services.backlog.approveProposal(proposal.id, h.owner.id);
    const converted = await h.services.backlog.convertProposal(proposal.id, h.owner.id);
    assert.equal(converted.task.status, "BACKLOG", "even then nothing runs: a human still has to Start it");
  });
});

test("an explicit absence wording on a behaviour-LABELLED claim ('the project has no OTP validation implementation') is recognised, but existence alone caps it at POSSIBLE", async () => {
  await withHarness("recon-labelled", {
    structure: fakeStructure(REPO),
    respond: () =>
      json(validAnalysis({
        claims: [{ statement: "The project has no mobile number validation implementation.", kind: "BEHAVIOR_INCORRECT", path: null, searchTerms: ["validate", "mobile"], confidence: "high" }],
      })),
  }, async (h) => {
    const item = h.item("No validation", "B-4", "There is no mobile validation.");
    await h.analyze(item.id);
    const f = assessmentOf(h, item.id).reconciliation!.findings[0]!;
    assert.equal(f.claimClass, "implementation_absence");
    assert.equal(f.labelledAsBehavior, true);
    assert.equal(f.outcome, "IMPLEMENTATION_POSSIBLE");
    assert.equal(f.strength, "weak");
  });
});

test("FILE_EXISTS / SYMBOL_MATCH alone can never make a behaviour claim anything but UNRESOLVED", () => {
  const evidence: PlatformEvidence[] = [
    { id: "E1", type: "FILE_EXISTS", source: "repository_listing", path: "a.ts", detail: null, matchedTerms: [], revision: REV_A },
    { id: "E2", type: "SYMBOL_MATCH", source: "repository_index", path: "a.ts", detail: "x", matchedTerms: ["x"], revision: REV_A },
    { id: "E3", type: "SYMBOL_REFERENCE", source: "repository_content", path: "a.ts", detail: "x", matchedTerms: ["x"], revision: REV_A },
  ];
  for (const kind of ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"] as const) {
    const c = claim({ kind, statement: "The limiter behaves correctly.", searchTerms: ["limit", "otp"] });
    const ca: ClaimAssessment = { claimIndex: 0, statement: c.statement, kind, aiConfidence: "high", status: "UNRESOLVED", establishes: "nothing", evidenceIds: ["E1", "E2", "E3"], reason: "r" };
    const r = reconcile([c], { claims: [ca], evidence, verification: [] }, REV_A);
    assert.equal(r.findings[0]!.outcome, "UNRESOLVED", kind);
    assert.equal(r.findings[0]!.behaviorVerified, false);
    assert.equal(r.behaviorVerified, false);
    assert.equal(r.alreadyImplemented, "none");
  }
});

// ===========================================================================
// CHECK_VERIFIED — only a check explicitly BOUND to the claim, at this revision
// ===========================================================================

test("CHECK_VERIFIED needs (a) a passed platform check, (b) explicitly bound to the claim, (c) whose CHECK_RESULT is for this revision — a generic passing check never does", () => {
  const c = claim({ kind: "BEHAVIOR_CORRECT", statement: "The limiter works correctly.", searchTerms: ["otp", "limit"] });
  const checkEv = (revision: string | null): PlatformEvidence => ({ id: "E1", type: "CHECK_RESULT", source: "platform_check", path: null, detail: "test: passed (exit 0)", matchedTerms: [], revision });
  const ca: ClaimAssessment = { claimIndex: 0, statement: c.statement, kind: c.kind, aiConfidence: "high", status: "UNRESOLVED", establishes: "nothing", evidenceIds: ["E1"], reason: "r" };
  const run = (bindsClaim: boolean | undefined, evRev: string | null, atRev: string) =>
    reconcile([c], { claims: [ca], evidence: [checkEv(evRev)], verification: [{ claimIndex: 0, checkId: "test", state: "passed", reason: "", evidenceId: "E1", ...(bindsClaim === undefined ? {} : { bindsClaim }) }] }, atRev);

  assert.equal(run(undefined, REV_A, REV_A).findings[0]!.outcome, "UNRESOLVED", "today's requirements are never bound ⇒ a passing generic check verifies nothing");
  assert.equal(run(false, REV_A, REV_A).behaviorVerified, false);
  const ok = run(true, REV_A, REV_A);
  assert.equal(ok.findings[0]!.outcome, "CHECK_VERIFIED");
  assert.equal(ok.findings[0]!.behaviorVerified, true);
  assert.equal(ok.behaviorVerified, true);
  // Stale CHECK_RESULT (run against another revision) can never verify — and is reported as ignored.
  const stale = run(true, REV_A, REV_B);
  assert.equal(stale.findings[0]!.outcome, "UNRESOLVED");
  assert.equal(stale.behaviorVerified, false);
  assert.deepEqual(stale.ignoredEvidence.map((i) => i.id), ["E1"]);
  // A CHECK_RESULT with no revision cannot be bound to the analysed one either.
  assert.equal(run(true, null, REV_A).findings[0]!.outcome, "UNRESOLVED");
});

// ===========================================================================
// REVISION INTEGRITY — evidence from revision A can never reconcile claims for revision B
// ===========================================================================

test("evidence stamped with another revision is IGNORED by reconciliation and listed; with an unknown analysed revision stamped evidence is not usable", () => {
  const evidence: PlatformEvidence[] = [
    { id: "E1", type: "SYMBOL_MATCH", source: "repository_index", path: "a.ts", detail: "n", matchedTerms: [], revision: REV_A },
    { id: "E2", type: "SYMBOL_REFERENCE", source: "repository_content", path: "a.ts", detail: "n", matchedTerms: [], revision: REV_A },
  ];
  const c = claim({ searchTerms: ["delete", "profile"] });
  const ca: ClaimAssessment = { claimIndex: 0, statement: c.statement, kind: c.kind, aiConfidence: "high", status: "CONTRADICTED", establishes: "existence", evidenceIds: ["E1", "E2"], reason: "r" };
  const same = reconcile([c], { claims: [ca], evidence, verification: [] }, REV_A);
  assert.equal(same.alreadyImplemented, "strong");
  const other = reconcile([c], { claims: [ca], evidence, verification: [] }, REV_B);
  assert.equal(other.alreadyImplemented, "none", "evidence from A does not reconcile a claim analysed at B");
  assert.equal(other.findings[0]!.outcome, "UNRESOLVED");
  assert.deepEqual(other.ignoredEvidence.map((i) => i.id).sort(), ["E1", "E2"]);
  assert.match(other.ignoredEvidence[0]!.reason, /not the analysed/);
  const unknown = reconcile([c], { claims: [ca], evidence, verification: [] }, null);
  assert.equal(unknown.alreadyImplemented, "none");
  assert.equal(unknown.revision, null);
});

test("a STALE INDEX (built for another revision) is refused by collectEvidence itself — it cannot produce current evidence", async () => {
  const s = await fakeStructure(REPO, { revision: REV_A }).open({} as never, signal);
  const idxA = await buildRepositoryIndex(s, sourceKeyOf({ repoUrl: "r", defaultBranch: "main" }), signal);
  const sessionB = await fakeStructure(REPO, { revision: REV_B }).open({} as never, signal);
  const c = { claims: [claim({ searchTerms: ["delete", "profile", "blocker"] })], candidateFiles: [] };
  const stale = await collectEvidence(c, sessionB, null, signal, idxA);
  assert.ok(!stale.evidence.some((e) => e.type === "SYMBOL_MATCH"), "index for A produced no evidence for a session at B");
  const current = await collectEvidence(c, s, null, signal, idxA);
  assert.ok(current.evidence.some((e) => e.type === "SYMBOL_MATCH"));
  // …and a session that cannot name its revision never uses an index at all.
  const noRev = await fakeStructure(REPO, { revision: null }).open({} as never, signal);
  assert.ok(!(await collectEvidence(c, noRev, null, signal, idxA)).evidence.some((e) => e.type === "SYMBOL_MATCH"));
});

test("a STALE CHECK_RESULT (run at revision A) folded into an analysis at revision B cannot reconcile or verify anything", () => {
  const c = claim({ kind: "BEHAVIOR_CORRECT", statement: "The limiter works.", searchTerms: ["otp", "limit"] });
  const before: EvidenceAssessment = {
    evidence: [],
    claims: [{ claimIndex: 0, statement: c.statement, kind: c.kind, aiConfidence: "high", status: "UNRESOLVED", establishes: "nothing", evidenceIds: [], reason: "r" }],
    summary: { supported: 0, contradicted: 0, unresolved: 1, notChecked: 0 },
    confidenceOverridden: false,
    inspection: { listing: "complete", filesRead: 0, bytesRead: 0, filesSkipped: [], limits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 } },
    verification: planVerification([c], { commands: { test: "npm test" } } as never).map((r) => ({ ...r, bindsClaim: true })),
  };
  const runs: VerificationRun[] = [{ checkId: "test", claimIndexes: [0], state: "passed", evidence: { exitCode: 0, durationMs: 5, commitSha: REV_A } as never, reason: "ok" }];
  const applied = applyVerification(before, runs, REV_A); // the check really did run at A…
  assert.equal(reconcile([c], applied, REV_A).behaviorVerified, true, "(control) at A it verifies the bound claim");
  const atB = reconcile([c], applied, REV_B); // …but this analysis is about B
  assert.equal(atB.behaviorVerified, false);
  assert.equal(atB.findings[0]!.outcome, "UNRESOLVED");
  assert.ok(atB.ignoredEvidence.length >= 1);
});

// ===========================================================================
// Trust boundaries that must survive this phase
// ===========================================================================

test("reconciliation evidence never cites a secret file or a symlink, and the model cannot supply reconciliation/verification/commands", async () => {
  const files = { ...REPO, ".env": "PROFILE_DELETE_BLOCKER=topsecretvalue1234567890\ngetProfileDeleteBlocker\n", "backend/src/link.ts": "x" };
  await withHarness("recon-safe", {
    structure: fakeStructure(files, { modes: { "backend/src/link.ts": "120000" } }),
    respond: () => json(validAnalysis({ claims: [{ statement: "There is no blocker check.", kind: "FEATURE_ABSENT", path: null, searchTerms: ["delete", "profile", "blocker"], confidence: "high" }] })),
  }, async (h) => {
    const item = h.item("Blocker", "B-5", "delete profile blocker");
    await h.analyze(item.id);
    const persisted = JSON.stringify(h.platform.backlogAnalyses.findLatestForItem(item.id));
    assert.ok(!persisted.includes("topsecretvalue1234567890"));
    for (const e of assessmentOf(h, item.id).evidence) assert.ok(!/\.env$|link\.ts$/.test(e.path ?? ""), `${e.type} ${e.path}`);
  });
  for (const extra of [{ reconciliation: { alreadyImplemented: "none" } }, { verification: [] }, { command: "rm -rf /" }, { alreadyImplemented: "strong" }]) {
    assert.equal(parseAnalysisOutput(json(validAnalysis(extra))).ok, false, JSON.stringify(extra));
  }
  assert.equal(parseAnalysisOutput(json(validAnalysis({ claims: [{ statement: "x", kind: "FEATURE_ABSENT", path: null, searchTerms: [], confidence: "low", reconciliation: "strong", verified: true }] }))).ok, false);
});

test("deriveAnalysisOutcome: a strong conflict needs a human whatever the confidence; a possible one does not block", () => {
  const base = validAnalysis() as never;
  const asm = (level: "strong" | "possible" | "none"): EvidenceAssessment =>
    ({ evidence: [], claims: [], summary: { supported: 0, contradicted: 0, unresolved: 0, notChecked: 0 }, confidenceOverridden: false, inspection: {} as never, reconciliation: { revision: REV_A, findings: [], alreadyImplemented: level, behaviorVerified: false, ignoredEvidence: [] } }) as EvidenceAssessment;
  assert.equal(deriveAnalysisOutcome(base, asm("strong")), "analysis_needs_clarification");
  assert.equal(deriveAnalysisOutcome(base, asm("possible")), "analysis_succeeded");
  assert.equal(deriveAnalysisOutcome(base, asm("none")), "analysis_succeeded");
  assert.equal(deriveAnalysisOutcome(base, undefined), "analysis_succeeded");
});

test("legacy analyses (no reconciliation) still render/parse: the field is optional and proposals default to `none`", async () => {
  const { TaskProposalContentSchema } = await import("../src/backlog/analysis-schema.js");
  const parsed = TaskProposalContentSchema.parse({
    title: "t", goal: "g", summary: "s", issueType: "bug", affectedApplication: null, suspectedArea: null, candidateFiles: [], acceptanceCriteria: [], validation: [],
    dependencies: [], duplicateWarnings: [], uncertainty: { overall: "low", uncertainties: [], missingInformation: [] },
  });
  assert.equal(parsed.implementationConflict, "none");
});

test("CHECK_VERIFIED requires the bound check to have PASSED — a failed or timed-out bound check verifies nothing", () => {
  const c = claim({ kind: "BEHAVIOR_CORRECT", statement: "The limiter works.", searchTerms: ["otp", "limit"] });
  const ev: PlatformEvidence = { id: "E1", type: "CHECK_RESULT", source: "platform_check", path: null, detail: "test: failed (exit 1)", matchedTerms: [], revision: REV_A };
  const ca: ClaimAssessment = { claimIndex: 0, statement: c.statement, kind: c.kind, aiConfidence: "high", status: "UNRESOLVED", establishes: "nothing", evidenceIds: ["E1"], reason: "r" };
  for (const state of ["failed", "timed_out", "infrastructure_error", "rejected", "not_run"] as const) {
    const r = reconcile([c], { claims: [ca], evidence: [ev], verification: [{ claimIndex: 0, checkId: "test", state, reason: "", evidenceId: "E1", bindsClaim: true }] }, REV_A);
    assert.equal(r.behaviorVerified, false, state);
    assert.equal(r.findings[0]!.outcome, "UNRESOLVED", state);
  }
});

test("'wired in' means the reference is in the SAME file as the matching declaration — a reference elsewhere is not wiring", () => {
  const evidence: PlatformEvidence[] = [
    { id: "E1", type: "SYMBOL_MATCH", source: "repository_index", path: "a.ts", detail: "n", matchedTerms: [], revision: REV_A },
    { id: "E2", type: "SYMBOL_REFERENCE", source: "repository_content", path: "other.ts", detail: "n", matchedTerms: [], revision: REV_A },
  ];
  const c = claim({ searchTerms: ["delete", "profile"] });
  const ca: ClaimAssessment = { claimIndex: 0, statement: c.statement, kind: c.kind, aiConfidence: "high", status: "CONTRADICTED", establishes: "existence", evidenceIds: ["E1", "E2"], reason: "r" };
  const r = reconcile([c], { claims: [ca], evidence, verification: [] }, REV_A);
  assert.equal(r.findings[0]!.outcome, "IMPLEMENTATION_POSSIBLE", "presence, but not declared-and-wired in one file");
  assert.equal(r.alreadyImplemented, "possible");
});
