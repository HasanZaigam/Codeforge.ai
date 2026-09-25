import type {
  AnalysisClaim,
  ClaimAssessment,
  EvidenceAssessment,
  PlatformEvidence,
  Reconciliation,
  ReconciliationFinding,
  ReconciliationOutcome,
} from "./backlog-types.js";

/**
 * Deterministic reconciliation of AI claims with platform evidence (Phase 4A.4 — /docs/BACKLOG_INTELLIGENCE.md §4d).
 *
 * THREE objects, never collapsed:  AI CLAIM (what the model asserts)  ·  PLATFORM EVIDENCE (what CodeForge
 * obtained)  ·  RECONCILIATION (what the platform concludes about how they relate). The model is never asked
 * whether evidence contradicts its claim; this pure function decides, from evidence alone.
 *
 * The distinction that matters is what the claim ASSERTS, not the `kind` label the model chose (real runs showed
 * the model mislabelling behaviour as existence and absence as behaviour):
 *  - an IMPLEMENTATION ABSENCE claim ("nothing implements X", "there is no check for Y") CAN be contradicted by
 *    platform evidence that the implementation exists — strongly, when a declared name is also wired in
 *    (SYMBOL_MATCH + SYMBOL_REFERENCE in a file the platform read), weakly otherwise;
 *  - a BEHAVIOUR claim ("deletion is not blocked", "the endpoint accepts …") can NOT be settled by inspection:
 *    it is UNRESOLVED however much exists, unless a platform check explicitly bound to the claim passed at this
 *    revision (CHECK_VERIFIED — nothing binds checks to claims yet, so it cannot occur today).
 * An absence the model labelled as behaviour is still recognised, but capped at IMPLEMENTATION_POSSIBLE.
 *
 * NOTHING here concludes "the bug is fixed" or "the behaviour is correct". `behaviorVerified` is false unless a
 * bound check passed. Existence (FILE_EXISTS / SYMBOL_MATCH) never proves behaviour.
 *
 * REVISION BINDING: reconciliation is done against ONE revision. Evidence stamped with any other revision (a stale
 * index row, a check run against another commit) is IGNORED and listed in `ignoredEvidence` — evidence from
 * revision A can never reconcile a claim about revision B.
 */

/**
 * EXPLICIT existence-absence wording: the claim says the project/feature is not there at all ("there is no rate
 * limiting", "nothing enforces X", "X is not implemented", "the project has no OTP validation implementation").
 */
const EXPLICIT_ABSENCE =
  /\b(?:there (?:is|are) no|has no|have no|no [\w\s-]{0,40}(?:implementation|support|mechanism|logic|check|validation|limit(?:er|ing)?|throttl\w+|guard|protection)|not (?:been )?implemented|nothing (?:implements|handles|enforces|checks|validates|limits|blocks|prevents)|(?:is|are) missing|missing (?:implementation|check|validation|logic)|never implemented)\b/i;

/** BROAD negation wording that a behaviour claim may carry ("does not check", "without validation", "lacks"). Ambiguous on its own. */
const BROAD_ABSENCE =
  /\b(?:no|not any|none|nothing|without|lacks?|lacking|missing|absent|never|(?:does|do|is|are|was|were|has|have)(?:n't| not)\s+(?:have|exist|implement\w*|include\w*|contain\w*|check\w*|validat\w*|verif\w*|enforc\w*|block\w*|prevent\w*|limit\w*|restrict\w*|protect\w*|guard\w*|handle\w*|call\w*|us\w+|invok\w*|appl\w+))\b/i;

export function assertsExplicitAbsence(statement: string): boolean {
  return EXPLICIT_ABSENCE.test(statement);
}
export function assertsAbsence(statement: string): boolean {
  return EXPLICIT_ABSENCE.test(statement) || BROAD_ABSENCE.test(statement);
}

type Class = ReconciliationFinding["claimClass"];

function classify(claim: AnalysisClaim): { claimClass: Class; labelledAsBehavior: boolean; explicit: boolean; broad: boolean } {
  switch (claim.kind) {
    case "FEATURE_ABSENT":
    case "FILE_ABSENT":
      return { claimClass: "implementation_absence", labelledAsBehavior: false, explicit: true, broad: false };
    case "BEHAVIOR_CORRECT":
    case "BEHAVIOR_INCORRECT":
      if (assertsExplicitAbsence(claim.statement)) return { claimClass: "implementation_absence", labelledAsBehavior: true, explicit: true, broad: false };
      // Broad wording is ambiguous: it stays a behaviour claim UNLESS the platform can see the code declared AND wired in (below).
      return { claimClass: "behavior", labelledAsBehavior: true, explicit: false, broad: assertsAbsence(claim.statement) };
    default:
      return { claimClass: "presence", labelledAsBehavior: false, explicit: false, broad: false };
  }
}

const NOT_VERIFIED = "Behavioral correctness was not verified.";

export function reconcile(claims: AnalysisClaim[], assessment: Pick<EvidenceAssessment, "claims" | "evidence" | "verification">, revision: string | null): Reconciliation {
  const byId = new Map(assessment.evidence.map((e) => [e.id, e]));
  const ignored = new Map<string, string>();

  // Evidence is usable only if it is for THIS revision. Evidence with no revision stamp is about the session
  // the assessment was built from (the same revision); a stamp that differs is stale and is dropped.
  const usable = (e: PlatformEvidence | undefined): e is PlatformEvidence => {
    if (!e) return false;
    if (e.revision && revision && e.revision !== revision) {
      ignored.set(e.id, `describes revision ${e.revision.slice(0, 12)}, not the analysed ${revision.slice(0, 12)}`);
      return false;
    }
    if (e.revision && !revision) {
      ignored.set(e.id, "the analysed revision is unknown, so revision-stamped evidence cannot be bound to it");
      return false;
    }
    return true;
  };

  const findings: ReconciliationFinding[] = assessment.claims.map((ca: ClaimAssessment) => {
    const claim = claims[ca.claimIndex]!;
    const { claimClass, labelledAsBehavior, broad } = classify(claim);
    const evidence = ca.evidenceIds.map((id) => byId.get(id)).filter(usable);
    const ids = evidence.map((e) => e.id);
    const base = { claimIndex: ca.claimIndex, statement: ca.statement, claimClass, labelledAsBehavior, evidenceIds: ids };
    const finding = (outcome: ReconciliationOutcome, strength: "strong" | "weak" | null, explanation: string): ReconciliationFinding => ({
      ...base,
      outcome,
      strength,
      explanation,
      behaviorVerified: outcome === "CHECK_VERIFIED",
    });

    // CHECK_VERIFIED: ONLY an approved platform check that the contract explicitly binds to this claim, that passed,
    // and whose CHECK_RESULT belongs to this revision. A project-wide check that happened to pass is not this.
    const req = (assessment.verification ?? []).find((r) => r.claimIndex === ca.claimIndex && r.bindsClaim === true && r.state === "passed" && r.evidenceId !== null);
    const checkEvidence = req ? byId.get(req.evidenceId!) : undefined;
    if (req && checkEvidence?.type === "CHECK_RESULT" && usable(checkEvidence) && checkEvidence.revision === revision) {
      return { ...base, evidenceIds: [...new Set([...ids, checkEvidence.id])], ...{ outcome: "CHECK_VERIFIED" as const, strength: null, explanation: `The project's configured '${req.checkId}' check, bound to this claim, passed at revision ${revision?.slice(0, 12)}.`, behaviorVerified: true } };
    }

    if (claimClass === "presence") {
      return ca.status === "SUPPORTED"
        ? finding("NO_CONFLICT", null, "The claim says something exists and platform evidence agrees (existence only).")
        : finding("UNRESOLVED", null, "Platform evidence does not confirm this claim; see its assessment.");
    }

    // Structural facts shared by the absence branches.
    const symbolPaths = new Set(evidence.filter((e) => e.type === "SYMBOL_MATCH" && e.path).map((e) => e.path!));
    const wired = evidence.some((e) => e.type === "SYMBOL_REFERENCE" && e.path && symbolPaths.has(e.path));
    const specific = claim.searchTerms.length >= 2; // a single common word is never enough for a conflict

    if (claimClass === "behavior") {
      if (broad && wired && specific) {
        // Broad negation wording ("does not check …") on a behaviour claim, while the platform SEES the code declared AND
        // referenced: a conflict with the reported absence — but the claim may be about how it behaves, so a lead only.
        return {
          ...finding(
            "IMPLEMENTATION_PRESENT",
            "weak",
            `Implementation evidence conflicts with the reported absence: a matching declaration exists and is referenced in a file the platform read. The claim was worded as behaviour, so this is a lead for a human, not a conclusion. ${NOT_VERIFIED}`,
          ),
          claimClass: "implementation_absence",
        };
      }
      return finding("UNRESOLVED", null, `This is a claim about behaviour. Existing files, declarations and calls do not establish it and no check bound to this claim ran. ${NOT_VERIFIED}`);
    }

    // ---- explicit implementation absence ----
    const fileExists = claim.kind === "FILE_ABSENT" && evidence.some((e) => e.type === "FILE_EXISTS");
    const anyPresence = evidence.some((e) => e.type === "FILE_EXISTS" || e.type === "PATH_MATCH" || e.type === "CONTENT_MATCH" || e.type === "SYMBOL_MATCH" || e.type === "SYMBOL_REFERENCE");

    if (fileExists || (wired && specific)) {
      return finding(
        "IMPLEMENTATION_PRESENT",
        "strong",
        `Repository evidence indicates the reported implementation absence is inconsistent with the current revision: ${fileExists ? "the file exists" : "a matching declaration exists and is referenced in a file the platform read"}. ${NOT_VERIFIED}`,
      );
    }
    if (anyPresence) {
      return finding(
        "IMPLEMENTATION_POSSIBLE",
        "weak",
        `Related files or code exist that may conflict with the reported absence, but the platform did not find a declaration that is also wired in. This is a lead, not a conclusion. ${NOT_VERIFIED}`,
      );
    }
    return finding("UNRESOLVED", null, "The platform found nothing that conflicts with the reported absence in what it inspected. A bounded search finding nothing does not prove the absence.");
  });

  const strong = findings.some((f) => f.outcome === "IMPLEMENTATION_PRESENT" && f.strength === "strong");
  const possible = findings.some((f) => f.outcome === "IMPLEMENTATION_POSSIBLE" || f.outcome === "IMPLEMENTATION_PRESENT"); // (a weak PRESENT counts as possible)
  return {
    revision,
    findings,
    alreadyImplemented: strong ? "strong" : possible ? "possible" : "none",
    behaviorVerified: findings.some((f) => f.outcome === "CHECK_VERIFIED"),
    ignoredEvidence: [...ignored].map(([id, reason]) => ({ id, reason })),
  };
}
