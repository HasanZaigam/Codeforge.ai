import type { ApprovedClaimCheck, CheckScope } from "../domain/types.js";
import type { AnalysisClaim } from "./backlog-types.js";

/**
 * Phase 4A.7 — the semantic verification contract. Four separate questions, never one:
 *   1. did the check PASS            (an execution fact — see ClaimVerificationRecord)
 *   2. is it RELEVANT to the claim   (topic overlap — a discovery hint only, never authorization)
 *   3. is it SUFFICIENT for the claim (its DECLARED scope covers exactly what the claim asserts)
 *   4. CHECK_VERIFIED                (passed at the exact revision AND sufficient AND still bound)
 * Pure and deterministic; no model. It classifies conservatively — anything it cannot classify is UNSUPPORTED, which no check can
 * ever verify. It prefers UNRESOLVED over a false VERIFIED.
 */

/** What a claim is ABOUT, as classified by the platform (the model's wording never sets it). */
export type ClaimClass =
  | "EXISTENCE" // "X exists / is defined / is declared" — answered by the index, not by running anything
  | "WIRING" // "A imports / calls / uses B" — a structural fact; a behavioural test cannot establish it
  | "FLOW" // "route/screen R does/enforces X" — needs a check whose scope is that entry point
  | "BEHAVIOR" // "mechanism M does X" — needs a check whose scope names that mechanism and behavior
  | "UNSUPPORTED"; // could not be classified confidently

export interface ClaimSemantics {
  claimClass: ClaimClass;
  /** An explicitly named HTTP entry point, normalised ("POST /request-otp"), when the claim states one. */
  entryPoint: string | null;
  /** Absence wording ("does not", "no", "fails to", "unlimited"). */
  negative: boolean;
}

export type Relevance = "not_relevant" | "relevant";
export type Sufficiency = "sufficient" | "insufficient";

export interface Compatibility {
  relevance: Relevance;
  sufficiency: Sufficiency;
  claimClass: ClaimClass;
  /** Why — shown to reviewers, so it says what the check does and does not establish. */
  reason: string;
}

const wordsOf = (text: string): string[] => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const WIRING_WORDS = new Set(["import", "imports", "imported", "importing", "call", "calls", "called", "calling", "invoke", "invokes", "invoked", "invoking", "use", "uses", "used", "using", "reference", "references", "referenced", "wired", "wiring", "depends", "dependency", "expected"]);
const EXISTENCE_WORDS = new Set(["exist", "exists", "existing", "define", "defines", "defined", "declare", "declares", "declared", "present", "located", "contains", "contain", "included", "includes"]);
const FLOW_WORDS = new Set(["route", "routes", "endpoint", "endpoints", "handler", "controller", "middleware", "flow", "screen", "page", "widget", "request", "api"]);
const BEHAVIOR_WORDS = new Set(["enforce", "enforces", "enforced", "reject", "rejects", "rejected", "block", "blocks", "blocked", "limit", "limits", "limited", "throttle", "throttles", "throttled", "allow", "allows", "allowed", "deny", "denies", "denied", "return", "returns", "returned", "apply", "applies", "applied", "prevent", "prevents", "implement", "implements", "implemented", "cooldown", "cap", "expire", "expires"]);
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-/:.{}]*)/i;
const NEGATIVE = /\b(not|no|never|without|lacks?|missing|unlimited|fails? to|does ?n['’]?t|doesn['’]?t|cannot|can['’]?t)\b/i;

export function normalizeEntryPoint(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\/+$/, "") || "/"}`;
}

export function classifyClaim(claim: Pick<AnalysisClaim, "statement" | "kind">): ClaimSemantics {
  const route = ROUTE.exec(claim.statement);
  const entryPoint = route ? normalizeEntryPoint(route[1]!, route[2]!.replace(/[.:,;)]+$/, "")) : null;
  const negative = NEGATIVE.test(claim.statement);
  const words = new Set(wordsOf(claim.statement));
  const has = (set: Set<string>) => [...words].some((w) => set.has(w));
  let claimClass: ClaimClass = "UNSUPPORTED";
  // Structure first: a claim about what imports/calls/uses/defines what is never a behavioural claim, whatever else it says.
  if (has(WIRING_WORDS)) claimClass = "WIRING";
  else if (has(EXISTENCE_WORDS)) claimClass = "EXISTENCE";
  else if (entryPoint || has(FLOW_WORDS)) claimClass = "FLOW";
  else if (has(BEHAVIOR_WORDS)) claimClass = "BEHAVIOR";
  return { claimClass, entryPoint, negative };
}

/** Topic overlap: every declared discovery group is hit by the claim's words. A hint for ranking/display — never authorization. */
export function topicRelevant(check: ApprovedClaimCheck, claim: Pick<AnalysisClaim, "statement" | "searchTerms">): boolean {
  const words = new Set(wordsOf(`${claim.statement} ${claim.searchTerms.join(" ")}`));
  const hit = (t: string) => words.has(t) || [...words].some((w) => w.length > t.length && t.length >= 4 && w.startsWith(t));
  return check.establishes.claimTerms.every((group) => group.some(hit));
}

const namesMechanism = (statement: string, mechanism: string): boolean => {
  const want = wordsOf(mechanism);
  const text = wordsOf(statement);
  for (let i = 0; i + want.length <= text.length; i++) if (want.every((w, j) => text[i + j] === w)) return true;
  return false;
};

/** The claim's words with the mechanism's own name removed: `evaluateOtpThrottle` must not supply the "throttle" behaviour by itself. */
function withoutMechanism(statement: string, mechanism: string): string {
  const want = wordsOf(mechanism);
  const text = wordsOf(statement);
  for (let i = 0; i + want.length <= text.length; i++) if (want.every((w, j) => text[i + j] === w)) return [...text.slice(0, i), ...text.slice(i + want.length)].join(" ");
  return text.join(" ");
}

/** Behaviours of the check's declared scope that the claim mentions (outside the mechanism's own name). */
export function behaviorsHit(scope: CheckScope, statement: string): string[] {
  const words = new Set(wordsOf(withoutMechanism(statement, scope.mechanism)));
  return scope.behaviors.filter((b) => b.terms.some((t) => words.has(t.toLowerCase()))).map((b) => b.id);
}

/**
 * Is `check` SUFFICIENT for `claim`? Only when the check's DECLARED scope covers exactly what the claim asserts:
 * a mechanism-level check speaks to BEHAVIOR claims that name its mechanism and one of its declared behaviours; only a flow-level
 * check whose entry point is the claim's explicit entry point speaks to a FLOW claim. WIRING / EXISTENCE / UNSUPPORTED claims are
 * never sufficient for any check. A check with no declared scope is never sufficient.
 */
export function evaluateCompatibility(check: ApprovedClaimCheck, claim: Pick<AnalysisClaim, "statement" | "searchTerms" | "path" | "kind">, applicationOk: boolean): Compatibility {
  const sem = classifyClaim(claim);
  const scope = check.establishes.scope;
  const relevant = topicRelevant(check, claim) || (!!scope && namesMechanism(claim.statement, scope.mechanism));
  const base = { claimClass: sem.claimClass };
  const no = (reason: string): Compatibility => ({ ...base, relevance: relevant ? "relevant" : "not_relevant", sufficiency: "insufficient", reason });
  if (claim.kind !== "BEHAVIOR_CORRECT" && claim.kind !== "BEHAVIOR_INCORRECT") return no("Only behaviour claims can be verified by a check.");
  if (!(check.establishes.claimKinds ?? ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"]).includes(claim.kind)) return no("This check does not speak to this kind of claim.");
  if (!relevant) return no("The check is not about this claim.");
  if (!scope) return no("The check declares no semantic scope, so it cannot be shown to establish this claim.");
  if (!applicationOk || (claim.statement && !applicationMatches(scope.application, claim))) return no(`The claim concerns a different application than the check's (${scope.application}).`);
  const established = `it establishes ${check.establishes.behavior}`;
  if (sem.claimClass === "WIRING") return no(`The claim is about how code is wired (imports/calls/uses); ${established}, not that.`);
  if (sem.claimClass === "EXISTENCE") return no(`The claim is about what exists; ${established}, not that.`);
  if (sem.claimClass === "UNSUPPORTED") return no("The platform cannot confidently classify this claim, so no check is sufficient for it.");
  if (sem.claimClass === "FLOW") {
    if (scope.level !== "flow") return no(`The claim is about a flow/entry point; this check's scope is the mechanism ${scope.mechanism}, and ${established}, not that the flow reaches or enforces it.`);
    if (!sem.entryPoint) return no("The claim does not name its entry point (e.g. POST /path), so the platform cannot tell it is the check's flow.");
    if (normalizeEntry(scope.entryPoint ?? "") !== sem.entryPoint) return no(`The claim's entry point ${sem.entryPoint} is not the check's (${scope.entryPoint ?? "none"}).`);
    if (behaviorsHit(scope, claim.statement).length === 0) return no("The claim asserts nothing this check declares it establishes.");
    return { ...base, relevance: "relevant", sufficiency: "sufficient", reason: `Flow-level check for ${scope.entryPoint}; ${established}.` };
  }
  // BEHAVIOR
  if (!namesMechanism(claim.statement, scope.mechanism)) return no(`The claim does not name the mechanism this check exercises (${scope.mechanism}).`);
  const hit = behaviorsHit(scope, claim.statement);
  const stripped = new Set(wordsOf(withoutMechanism(claim.statement, scope.mechanism)));
  if (hit.length === 0 || ![...stripped].some((w) => BEHAVIOR_WORDS.has(w))) return no("The claim asserts nothing this check declares it establishes.");
  return { ...base, relevance: "relevant", sufficiency: "sufficient", reason: `Mechanism-level check of ${scope.mechanism} (${hit.join(", ")}); ${established}.` };
}

function normalizeEntry(e: string): string {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i.exec(e.trim());
  return m ? normalizeEntryPoint(m[1]!, m[2]!) : e;
}

const APPLICATIONS: Record<string, string[]> = { backend: ["backend", "server", "api", "express", "mongoose"], mobile: ["mobile", "flutter", "android", "ios", "dart"], web: ["web", "react", "browser", "nextjs"] };
/** The claim must not talk ONLY about another application than the check's scope. Unmentioned application does not filter (the mechanism/entry point pins it). */
function applicationMatches(application: string, claim: Pick<AnalysisClaim, "statement" | "searchTerms" | "path">): boolean {
  const own = application.toLowerCase();
  const words = new Set(wordsOf(`${claim.statement} ${claim.searchTerms.join(" ")} ${(claim.path ?? "").replace(/[/._-]/g, " ")}`));
  const mentioned = Object.entries(APPLICATIONS).filter(([, ws]) => ws.some((w) => words.has(w))).map(([k]) => k);
  if (mentioned.length === 0) return true;
  return mentioned.includes(own) || (own === "frontend" && (mentioned.includes("mobile") || mentioned.includes("web")));
}
