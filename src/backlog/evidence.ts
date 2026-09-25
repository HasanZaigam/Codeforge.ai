import type {
  AnalysisClaim,
  AnalysisResult,
  ClaimAssessment,
  ClaimEstablishes,
  ClaimStatus,
  ConfidenceLevel,
  EvidenceAssessment,
  InspectionSummary,
  PlatformEvidence,
} from "./backlog-types.js";
import { findContentMatches, maskSecrets, normalizeRepoPath, type RepositoryInspector } from "./repository-inspector.js";
import type { IndexedFile, RepositoryIndex } from "./repository-index.js";
import { isNoisePath, tokenize, type RepositorySession } from "./repository-structure.js";

/**
 * Claim-vs-evidence for backlog analysis (Phase 4A.2 — /docs/BACKLOG_INTELLIGENCE.md "Evidence").
 *
 * THE INVARIANT: AI may suggest; CodeForge obtains; CodeForge owns. Every `PlatformEvidence` here is
 * produced by THIS code from the repository listing or from file content the platform read itself. The
 * model's output enters only as `AnalysisClaim`s (structured assertions) and is never consulted for
 * "was it verified" — a claim's status is a pure function of the evidence the platform gathered
 * (`assessClaims`). Words like "verified", "confirmed", "tested", "implemented" inside a claim statement
 * are inert text.
 *
 * HONESTY RULES baked into the assessment:
 *  - EXISTENCE NEVER PROVES BEHAVIOR: finding `otpThrottle.ts` cannot make "throttling works correctly"
 *    SUPPORTED — it is UNRESOLVED (no test was run; TEST_RESULT evidence does not exist yet).
 *  - A BOUNDED SEARCH THAT FINDS NOTHING NEVER PROVES ABSENCE: "nothing implements X" is at best
 *    UNRESOLVED when no match is found, and only a definite hit can CONTRADICT it.
 *  - "NOT FOUND" IS ONLY EVIDENCE OF ABSENCE WHEN THE LISTING IS COMPLETE. On a truncated or unavailable
 *    listing the platform emits no FILE_NOT_FOUND at all.
 */

export type ListingState = InspectionSummary["listing"];

/** Per-claim evidence handed to the (pure) assessment. */
export interface ClaimEvidence {
  /** FILE_EXISTS / FILE_NOT_FOUND for `claim.path`, if the platform could decide it. */
  file: PlatformEvidence | null;
  /** PATH_MATCH / CONTENT_MATCH evidence for `claim.searchTerms`. */
  matches: PlatformEvidence[];
  /** True when the platform actually searched (there was a listing and search terms). */
  searched: boolean;
}

/** A hit needs at least this many DISTINCT search terms — a single common word ("otp") must not, alone, contradict a claim about "OTP throttling". */
export const minTermsFor = (termCount: number): number => Math.min(2, Math.max(1, termCount));

const MAX_MATCHES_PER_CLAIM = 4;
const MAX_FILES_READ_PER_CLAIM = 3;

export interface CollectedEvidence {
  evidence: PlatformEvidence[];
  perClaim: ClaimEvidence[];
  /** Evidence for candidate-file paths the model named (drives the existing "verified in repository" labels). */
  candidateFiles: Array<{ path: string; existsInRepository: boolean | null }>;
}

/**
 * Gathers platform evidence for every claim (and candidate file) — from the listing first, then by
 * reading a bounded number of the most relevant files. Deterministic: same listing + same files + same
 * claims ⇒ same evidence, in the same order. Never throws for an unreadable file (that is a recorded skip).
 */
export async function collectEvidence(
  result: Pick<AnalysisResult, "claims" | "candidateFiles">,
  session: RepositorySession | null,
  inspector: RepositoryInspector | null,
  signal: AbortSignal,
  /**
   * The revision-bound repository index, ONLY if the caller has already established it describes exactly this
   * session's revision (`indexMismatch`). Symbol/route matches from it are EXISTENCE evidence at that revision.
   */
  index: RepositoryIndex | null = null,
): Promise<CollectedEvidence> {
  const listing = listingState(session);
  // Defence in depth: an index for any other revision (or none the session can name) is never used for evidence.
  if (index && (!session?.revision || index.revision !== session.revision)) index = null;
  const sessionRevision = session?.revision ?? null;
  const evidence: PlatformEvidence[] = [];
  const dedupe = new Set<string>();
  const add = (e: Omit<PlatformEvidence, "id">): PlatformEvidence | null => {
    const key = `${e.type}|${e.path ?? ""}|${e.detail ?? ""}`;
    if (dedupe.has(key)) return evidence.find((x) => `${x.type}|${x.path ?? ""}|${x.detail ?? ""}` === key) ?? null;
    dedupe.add(key);
    // Everything derived from this session (listing, content, index) describes THIS session's revision — stamp it so
    // reconciliation can refuse evidence that ever ends up next to a different one.
    const full: PlatformEvidence = { ...e, revision: e.revision ?? sessionRevision, id: `E${evidence.length + 1}` };
    evidence.push(full);
    return full;
  };

  const fileEvidence = (rawPath: string): PlatformEvidence | null => {
    const path = normalizeRepoPath(rawPath);
    if (!session || path === null) return null;
    if (session.entries.has(path)) return add({ type: "FILE_EXISTS", source: "repository_listing", path, detail: null, matchedTerms: [] });
    // Absence is only evidence when EVERY file was listed.
    if (listing === "complete") return add({ type: "FILE_NOT_FOUND", source: "repository_listing", path, detail: null, matchedTerms: [] });
    return null;
  };

  const candidateFiles = result.candidateFiles.map((f) => {
    const ev = fileEvidence(f.path);
    return { path: f.path, existsInRepository: ev === null ? null : ev.type === "FILE_EXISTS" };
  });

  const perClaim: ClaimEvidence[] = [];
  for (const claim of result.claims) {
    const file = claim.path !== null ? fileEvidence(claim.path) : null;
    const matches: PlatformEvidence[] = [];
    const searched = session !== null && claim.searchTerms.length > 0 && claim.kind !== "FILE_EXISTS" && claim.kind !== "FILE_ABSENT";

    if (searched && session) {
      const need = minTermsFor(claim.searchTerms.length);
      const lowerTerms = claim.searchTerms.map((t) => t.toLowerCase());

      // 1. Paths whose own name matches enough of the terms.
      const pathHits: string[] = [];
      for (const path of session.structure.paths) {
        if (matches.length >= MAX_MATCHES_PER_CLAIM) break;
        if (isNoisePath(path)) continue;
        const lower = path.toLowerCase();
        const matched = lowerTerms.filter((t) => lower.includes(t));
        if (matched.length >= need) {
          const ev = add({ type: "PATH_MATCH", source: "repository_listing", path, detail: null, matchedTerms: matched });
          if (ev) matches.push(ev);
          pathHits.push(path);
        }
      }

      // 1b. Declared symbols / routes from the revision-bound index. Existence only: "a declaration whose name
      //     contains these words is in that file at that revision" — it says nothing about what the code does.
      const symbolHits: string[] = [];
      const symbolNames = new Map<string, string[]>();
      if (index) {
        for (const hit of symbolMatches(index, claim.searchTerms, need)) {
          if (matches.length >= MAX_MATCHES_PER_CLAIM) break;
          const ev = add({
            type: "SYMBOL_MATCH",
            source: "repository_index",
            path: hit.file.path,
            detail: `${hit.names.join(", ")} @ ${index.revision.slice(0, 12)}`,
            matchedTerms: hit.matched,
            revision: index.revision,
          });
          if (ev) matches.push(ev);
          symbolHits.push(hit.file.path);
          symbolNames.set(hit.file.path, hit.names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)));
        }
      }

      // 2. Content: the claim's own file, then the best path/symbol hits — within the shared inspection budget.
      if (inspector) {
        const toRead = [...new Set([...(claim.path !== null && file?.type === "FILE_EXISTS" ? [claim.path] : []), ...pathHits, ...symbolHits])].slice(0, MAX_FILES_READ_PER_CLAIM);
        for (const path of toRead) {
          const outcome = await inspector.read(path, signal);
          if (!outcome.ok) continue;
          // Structure: a declared name that the platform read AND that is used elsewhere in the same file — "wired in".
          for (const name of symbolNames.get(path) ?? []) {
            const ref = findReferences(outcome.file.text, name);
            if (ref && matches.length < MAX_MATCHES_PER_CLAIM + 4) {
              const ev = add({ type: "SYMBOL_REFERENCE", source: "repository_content", path: outcome.file.path, detail: `${name}: declared L${ref.declaredAt}, referenced L${ref.firstReference.line}${ref.count > 1 ? ` (+${ref.count - 1} more)` : ""}: ${ref.firstReference.excerpt}`, matchedTerms: [name] });
              if (ev) matches.push(ev);
            }
          }
          for (const m of findContentMatches(outcome.file.text, claim.searchTerms, need, 2)) {
            if (matches.length >= MAX_MATCHES_PER_CLAIM + 2) break;
            const ev = add({ type: "CONTENT_MATCH", source: "repository_content", path: outcome.file.path, detail: `L${m.line}: ${m.excerpt}`, matchedTerms: m.matched });
            if (ev) matches.push(ev);
          }
        }
      }
    }
    perClaim.push({ file, matches, searched });
  }
  return { evidence, perClaim, candidateFiles };
}

/** True when a search term (a word, or a camelCase identifier) is contained in a declared name, by substring or by whole sub-words. */
function termMatchesName(term: string, nameLower: string, nameTokens: Set<string>): boolean {
  const t = term.toLowerCase();
  if (nameLower.includes(t)) return true;
  const parts = tokenize(term);
  return parts.length > 1 && parts.every((p) => nameTokens.has(p));
}

/**
 * Index files with a declared symbol or route that matches at least `need` DISTINCT search terms — WITHIN ONE
 * NAME. Terms spread across different symbols do not add up: `parseUserAgent` ("user") next to
 * `recordSuccessfulOtpSend` ("otp") in one file is not a declaration about "user OTP" (a real run accepted
 * exactly that as a two-term hit before this rule). Best first (most terms, then path). Pure.
 */
export function symbolMatches(index: RepositoryIndex, terms: string[], need: number, max = MAX_MATCHES_PER_CLAIM): Array<{ file: IndexedFile; matched: string[]; names: string[] }> {
  const out: Array<{ file: IndexedFile; matched: string[]; names: string[] }> = [];
  for (const file of index.files) {
    if (!file.contentIndexed || isNoisePath(file.path) || (file.symbols.length === 0 && file.routes.length === 0)) continue;
    const matched = new Set<string>();
    const hitNames: Array<{ name: string; count: number }> = [];
    for (const name of [...file.symbols, ...file.routes]) {
      const lower = name.toLowerCase();
      const tokens = new Set(tokenize(name));
      const here = terms.filter((t) => termMatchesName(t, lower, tokens));
      if (here.length >= need) {
        for (const t of here) matched.add(t);
        hitNames.push({ name, count: here.length });
      }
    }
    if (hitNames.length > 0) {
      hitNames.sort((a, b) => b.count - a.count);
      out.push({ file, matched: [...matched], names: hitNames.slice(0, 4).map((h) => h.name) });
    }
  }
  out.sort((a, b) => b.matched.length - a.matched.length || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  return out.slice(0, max);
}

/** Where a declared `name` first appears (its declaration) and where else the same file uses it. `null` if it is never used again. Pure. */
export function findReferences(text: string, name: string): { declaredAt: number; count: number; firstReference: { line: number; excerpt: string } } | null {
  const re = new RegExp("(?<![\\w$])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w$])");
  const lines = text.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) hits.push(i);
  if (hits.length < 2) return null;
  const first = hits[1]!;
  return { declaredAt: hits[0]! + 1, count: hits.length - 1, firstReference: { line: first + 1, excerpt: maskSecrets(lines[first]!.trim()).slice(0, 140) } };
}

function listingState(session: RepositorySession | null): ListingState {
  if (!session) return "unavailable";
  return session.structure.truncated ? "truncated" : "complete";
}

export { listingState };

// ---------------------------------------------------------------------------
// The deterministic assessment (pure)
// ---------------------------------------------------------------------------

const idsOf = (evs: PlatformEvidence[]): string[] => evs.map((e) => e.id);
const first = (evs: PlatformEvidence[], n = MAX_MATCHES_PER_CLAIM): PlatformEvidence[] => evs.slice(0, n);

/**
 * Maps each claim to SUPPORTED / CONTRADICTED / UNRESOLVED / NOT_CHECKED using ONLY platform evidence.
 * Pure and total: the same inputs always give the same statuses, and no input is a "verified" flag from
 * the model (there is none in the type).
 */
export function assessClaims(claims: AnalysisClaim[], perClaim: ClaimEvidence[], listing: ListingState): ClaimAssessment[] {
  return claims.map((claim, claimIndex) => {
    const ce = perClaim[claimIndex] ?? { file: null, matches: [], searched: false };
    const { status, evidenceIds, reason } = assessOne(claim, ce, listing);
    // Only a definite existence/absence finding establishes anything, and only about EXISTENCE. Behaviour
    // claims and every UNRESOLVED / NOT_CHECKED result establish nothing — whatever `kind` the model chose.
    const establishes: ClaimEstablishes = (status === "SUPPORTED" || status === "CONTRADICTED") && claim.kind !== "BEHAVIOR_CORRECT" && claim.kind !== "BEHAVIOR_INCORRECT" ? "existence" : "nothing";
    return { claimIndex, statement: claim.statement, kind: claim.kind, aiConfidence: claim.confidence, status, establishes, evidenceIds, reason };
  });
}

function assessOne(claim: AnalysisClaim, ce: ClaimEvidence, listing: ListingState): { status: ClaimStatus; evidenceIds: string[]; reason: string } {
  const fileExists = ce.file?.type === "FILE_EXISTS";
  const fileMissing = ce.file?.type === "FILE_NOT_FOUND";
  const hasMatches = ce.matches.length > 0;
  const none = (status: ClaimStatus, reason: string) => ({ status, evidenceIds: [] as string[], reason });
  const unchecked = (): { status: ClaimStatus; evidenceIds: string[]; reason: string } =>
    listing === "unavailable"
      ? none("NOT_CHECKED", "The repository could not be inspected, so the platform checked nothing for this claim.")
      : none("UNRESOLVED", "The repository listing was truncated, so the platform cannot establish absence.");

  switch (claim.kind) {
    case "FILE_EXISTS":
      if (fileExists) return { status: "SUPPORTED", evidenceIds: idsOf([ce.file!]), reason: `The platform found ${claim.path} in the repository listing.` };
      if (fileMissing) return { status: "CONTRADICTED", evidenceIds: idsOf([ce.file!]), reason: `The repository listing is complete and does not contain ${claim.path}.` };
      return unchecked();

    case "FILE_ABSENT":
      if (fileMissing) return { status: "SUPPORTED", evidenceIds: idsOf([ce.file!]), reason: `The repository listing is complete and does not contain ${claim.path}.` };
      if (fileExists) return { status: "CONTRADICTED", evidenceIds: idsOf([ce.file!]), reason: `The platform found ${claim.path} in the repository listing.` };
      return unchecked();

    case "FEATURE_ABSENT": {
      const contradicting = [...(fileExists ? [ce.file!] : []), ...ce.matches];
      if (contradicting.length > 0) {
        return {
          status: "CONTRADICTED",
          evidenceIds: idsOf(first(contradicting)),
          reason: "The claim says nothing implements this, but the platform found matching files/code (listed as evidence). This does not show the existing code is correct or complete — only that something exists.",
        };
      }
      if (listing === "unavailable") return none("NOT_CHECKED", "The repository could not be inspected, so the platform checked nothing for this claim.");
      return none(
        "UNRESOLVED",
        ce.searched
          ? "The platform found no matching path or content in what it inspected. A bounded search finding nothing does not prove nothing exists."
          : "The claim gave no search terms, so the platform had nothing to look for.",
      );
    }

    case "FEATURE_PRESENT": {
      const supporting = [...(fileExists ? [ce.file!] : []), ...ce.matches];
      if (supporting.length > 0) {
        return {
          status: "SUPPORTED",
          evidenceIds: idsOf(first(supporting)),
          reason: "The platform found matching files/code, which is evidence that something related EXISTS. It is not evidence that it is correct or complete.",
        };
      }
      if (fileMissing) return { status: "CONTRADICTED", evidenceIds: idsOf([ce.file!]), reason: `The claim names ${claim.path}, but the repository listing is complete and does not contain it.` };
      if (listing === "unavailable") return none("NOT_CHECKED", "The repository could not be inspected, so the platform checked nothing for this claim.");
      return none("UNRESOLVED", "The platform found no matching path or content in what it inspected; that does not prove the feature is absent.");
    }

    case "BEHAVIOR_CORRECT":
    case "BEHAVIOR_INCORRECT": {
      const related = [...(fileExists ? [ce.file!] : []), ...ce.matches];
      if (fileMissing && related.length === 0) {
        return { status: "CONTRADICTED", evidenceIds: idsOf([ce.file!]), reason: `The claim is about ${claim.path}, but the repository listing is complete and does not contain it.` };
      }
      if (listing === "unavailable") return none("NOT_CHECKED", "The repository could not be inspected, so the platform checked nothing for this claim.");
      return {
        status: "UNRESOLVED",
        evidenceIds: idsOf(first(related)),
        reason:
          related.length > 0
            ? "The platform found related files/code, but existence does not establish behavior and no test was run — the correctness of this claim is not established either way."
            : "Behavior cannot be established by inspection, and the platform found nothing related to look at.",
      };
    }
  }
}

/** Builds the full assessment and applies the confidence rule: a `high` confidence never overrides a contradiction — it is EXPOSED (`confidenceOverridden`), never silently downgraded. */
export function buildAssessment(
  evidence: PlatformEvidence[],
  claims: ClaimAssessment[],
  overallConfidence: ConfidenceLevel,
  inspection: InspectionSummary,
): EvidenceAssessment {
  const count = (s: ClaimStatus) => claims.filter((c) => c.status === s).length;
  const contradicted = claims.filter((c) => c.status === "CONTRADICTED");
  return {
    evidence,
    claims,
    summary: { supported: count("SUPPORTED"), contradicted: contradicted.length, unresolved: count("UNRESOLVED"), notChecked: count("NOT_CHECKED") },
    confidenceOverridden: contradicted.some((c) => c.aiConfidence === "high") || (contradicted.length > 0 && overallConfidence === "high"),
    inspection,
  };
}

/** Whether platform evidence contradicts a claim the model stated with real confidence — the deterministic trigger for NEEDS_CLARIFICATION. */
export function hasConfidentContradiction(assessment: EvidenceAssessment | undefined): boolean {
  return !!assessment && assessment.claims.some((c) => c.status === "CONTRADICTED" && (c.aiConfidence === "high" || c.aiConfidence === "medium"));
}
