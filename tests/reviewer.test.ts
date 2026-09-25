import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveReviewResult, parseVerificationRequest } from "../src/review/reviewer.js";
import type { StepResult, VerificationEvidence } from "../src/domain/types.js";

function makeStep(summary: string, overrides: Partial<StepResult> = {}): StepResult {
  return { status: "completed", summary, filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null, ...overrides };
}

function makeEvidence(overrides: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    requested: { checkId: "test", purpose: null },
    outcome: "passed",
    rejectionReason: null,
    checkId: "test",
    command: "npm test",
    expectedBranch: "task/abc123",
    actualBranch: "task/abc123",
    commitSha: "deadbeef",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    exitCode: 0,
    logExcerpt: "1 passing",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Item 9.F — reviewer verification language (see PLATFORM_GAPS.md GAP-016,
// "'Independently verified' means read, not run"). A real reviewer has
// previously described in detail how a regex correctly rejected bad input
// while that exact regex, run against that exact input, let it through — the
// platform must never present that as more than a static read-through unless
// the model explicitly says it ran something.
//
// V1.1 Slice 2 ("AI may request verification. CodeForge owns verification
// evidence."): a text-only "VERIFICATION: EXECUTED" claim, with no platform
// VerificationEvidence to back it, can no longer become `"executed"` at
// all — see the "downgraded" tests below. Only real evidence (the second
// `deriveReviewResult` argument) can produce `"executed"`.
// ---------------------------------------------------------------------------

test("VERIFICATION: EXECUTED with no platform evidence is downgraded to 'static' — a text claim alone is never evidence", () => {
  const review = deriveReviewResult(makeStep("Looks correct.\n\nVERIFICATION: EXECUTED\nVERDICT: APPROVED"));
  assert.equal(review.verificationMethod, "static");
  assert.equal(review.verification, null);
});

test("VERIFICATION: EXECUTED backed by real platform evidence (outcome passed) becomes 'executed'", () => {
  const evidence = makeEvidence({ outcome: "passed" });
  const review = deriveReviewResult(makeStep("Ran the test suite.\n\nVERIFICATION: EXECUTED\nVERDICT: APPROVED"), evidence);
  assert.equal(review.verificationMethod, "executed");
  assert.equal(review.verification, evidence);
});

test("platform evidence with outcome 'failed'/'timed_out'/'infrastructure_error' still counts as 'executed' — a real check genuinely running and failing is not the same as nothing running", () => {
  for (const outcome of ["failed", "timed_out", "infrastructure_error"] as const) {
    const review = deriveReviewResult(makeStep("VERIFICATION: EXECUTED\nVERDICT: CHANGES_REQUESTED"), makeEvidence({ outcome }));
    assert.equal(review.verificationMethod, "executed", `outcome ${outcome} should still count as executed`);
  }
});

test("a REJECTED verification request never becomes 'executed', even if the reviewer's text still claims EXECUTED", () => {
  const evidence = makeEvidence({ outcome: "rejected", rejectionReason: "not an approved check", checkId: "rm", command: null, actualBranch: null, commitSha: null });
  const review = deriveReviewResult(makeStep("VERIFICATION: EXECUTED\nVERDICT: APPROVED"), evidence);
  assert.equal(review.verificationMethod, "static", "a rejected request produced no real execution — never presented as more thorough than a static read");
  assert.equal(review.verification, evidence, "the rejection itself is still real evidence and is preserved on the result");
});

test("VERIFICATION: STATIC is parsed as 'static'", () => {
  const review = deriveReviewResult(makeStep("Read through the diff.\n\nVERIFICATION: STATIC\nVERDICT: APPROVED"));
  assert.equal(review.verificationMethod, "static");
});

test("no VERIFICATION line at all resolves to 'unknown' — never silently assumed to be 'executed' just because the prose sounds confident", () => {
  const review = deriveReviewResult(
    makeStep(
      "I independently verified that the regex correctly rejects all the bad inputs described in the bug reports, including names made only of symbols.\n\nVERDICT: APPROVED",
    ),
  );
  assert.equal(review.verificationMethod, "unknown", "confident prose is not evidence of execution");
});

test("VERIFICATION line is case-insensitive and tolerates the same formatting variance VERDICT already does, but still only 'static' without backing evidence", () => {
  const review = deriveReviewResult(makeStep("verification: executed\nverdict: approved"));
  assert.equal(review.verificationMethod, "static");
});

test("a malformed VERIFICATION line (not exactly STATIC or EXECUTED) resolves to 'unknown' rather than guessing", () => {
  const review = deriveReviewResult(makeStep("VERIFICATION: PROBABLY\nVERDICT: APPROVED"));
  assert.equal(review.verificationMethod, "unknown");
});

// ---------------------------------------------------------------------------
// V1.1 Slice 2 — parseVerificationRequest (the reviewer's VERIFY: protocol)
// ---------------------------------------------------------------------------

test("parseVerificationRequest: extracts a well-formed VERIFY: line and optional PURPOSE:", () => {
  const req = parseVerificationRequest("Some reasoning.\n\nVERIFY: test\nPURPOSE: confirm the regex rejects '---'");
  assert.deepEqual(req, { checkId: "test", purpose: "confirm the regex rejects '---'" });
});

test("parseVerificationRequest: PURPOSE is optional", () => {
  const req = parseVerificationRequest("VERIFY: build");
  assert.deepEqual(req, { checkId: "build", purpose: null });
});

test("parseVerificationRequest: case-insensitive, matching the same convention as VERDICT/VERIFICATION", () => {
  const req = parseVerificationRequest("verify: lint");
  assert.deepEqual(req, { checkId: "lint", purpose: null });
});

test("parseVerificationRequest: absent VERIFY: line returns null — never invents a request", () => {
  assert.equal(parseVerificationRequest("VERDICT: APPROVED"), null);
});

test("parseVerificationRequest: a single unknown checkId token is still PARSED as a candidate — policy rejection is reviewer-verification.ts's job, not the parser's", () => {
  const req = parseVerificationRequest("VERIFY: rm");
  assert.deepEqual(req, { checkId: "rm", purpose: null });
});

test("parseVerificationRequest: a multi-word 'command' on the VERIFY: line does not match at all — the line must be exactly one token, so an attempted shell command is safely ignored, never partially parsed", () => {
  assert.equal(parseVerificationRequest("VERIFY: rm -rf /"), null);
});

// ---------------------------------------------------------------------------
// Existing VERDICT/FINDING parsing — unchanged behavior, kept covered here
// now that this module has a dedicated test file.
// ---------------------------------------------------------------------------

test("an explicit VERDICT: CHANGES_REQUESTED always wins, even with no blocker findings", () => {
  const review = deriveReviewResult(makeStep("VERDICT: CHANGES_REQUESTED"));
  assert.equal(review.verdict, "rejected");
});

test("a real blocker finding overrides a contradictory VERDICT: APPROVED line", () => {
  const review = deriveReviewResult(
    makeStep("FINDING: blocker | correctness | The regex still lets '---' through\nVERDICT: APPROVED"),
  );
  assert.equal(review.verdict, "rejected");
  assert.equal(review.findings.length, 1);
});

test("structured step.findings take priority over text-parsed FINDING: lines when both are present", () => {
  const review = deriveReviewResult(
    makeStep("FINDING: note | test_gap | text-parsed, should be ignored\nVERDICT: APPROVED", {
      findings: [{ severity: "concern", category: "security", summary: "structured finding wins" }],
    }),
  );
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0]!.summary, "structured finding wins");
});

test("no VERDICT line at all falls back to the original completed-status heuristic", () => {
  const approved = deriveReviewResult(makeStep("Looks fine to me.", { status: "completed" }));
  assert.equal(approved.verdict, "approved");

  const rejected = deriveReviewResult(makeStep("Something's wrong.", { status: "blocked" }));
  assert.equal(rejected.verdict, "rejected");
});
