import type { Investigation, InvestigationCandidate, InvestigationFlow, InvestigationSignal, PlatformEvidence } from "./backlog-types.js";
import { locateEntries, traceFlow } from "./flow.js";
import { findReferences } from "./evidence.js";
import type { IndexedFile, RepositoryIndex } from "./repository-index.js";
import { maskSecrets, type RepositoryInspector } from "./repository-inspector.js";
import { isNoisePath, tokenize, type RepositorySession } from "./repository-structure.js";

/**
 * The platform's own investigation of a backlog item's premise (Phase 4A.5 — /docs/BACKLOG_INTELLIGENCE.md §4g).
 *
 * WHY: real models almost never state "X does not exist" — they accept the bug report's premise and make behavioural
 * claims, which reconciliation can only leave UNRESOLVED. So the platform looks for itself, from the ITEM TEXT alone
 * (never from anything the model said): does the repository at this revision already contain an implementation of the
 * mechanism the item says is missing?
 *
 *   item text ──► premise (what mechanism is reported missing/unguarded, about which subject)
 *   premise   ──► declared names / files in the revision-bound index naming BOTH the mechanism and the subject
 *   candidate ──► wired in? — the declaration is used elsewhere in its own file, or by a file that imports it
 *
 * It concludes at most "an implementation appears present" (`IMPLEMENTATION_PRESENT`) and ALWAYS
 * `BEHAVIOR_UNVERIFIED`: a declared, referenced `getProfileDeleteBlocker` says nothing about whether deletion is in fact
 * blocked. Conservative by construction: a premise needs an explicit cue AND a recognisable mechanism; "present" needs
 * a name that carries the mechanism, a name/path that carries the subject, and structural wiring; and finding nothing
 * is `NO_CONFLICTING_IMPLEMENTATION_EVIDENCE`, never "absent".
 */

/** Mechanism concepts: the words in the ITEM that name a mechanism, and the words that name it in CODE (matched as whole name parts or stems). Narrow on purpose. */
const MECHANISMS: Record<string, { cue: RegExp; names: string[] }> = {
  limit: { cue: /\b(?:limit(?:s|ed|ing)?|rate[- ]?limit\w*|throttl\w*|unlimited|brute[- ]?force|quota|cooldown)\b/gi, names: ["limit", "limiter", "throttle", "throttling", "ratelimit", "cooldown", "quota"] },
  validate: { cue: /\b(?:validat\w*|verif(?:y|ied|ication|ying)|sanitiz\w*)\b/gi, names: ["validate", "validator", "validation", "validates", "verify", "verification", "sanitize", "sanitizer"] },
  block: { cue: /\b(?:block(?:ed|ing|er)?|prevent\w*|forbid\w*|disallow\w*|protect(?:ed|ion)?|restrict\w*)\b/gi, names: ["blocker", "blocked", "prevent", "prevents", "forbid", "deny", "disallow", "protect", "restrict", "permission", "authorize"] },
};

/** A cue that something is MISSING, which must sit next to the mechanism word ("no limit", "without verification", "never validated"). */
const ABSENCE_CUE = /\b(?:no|not|without|never|missing|lacks?|lacking|unlimited|unchecked|unprotected|nothing)\b/i;
const PROXIMITY = 40;
/** "A user can delete …" — a destructive/privileged action reported as possible, which implies a missing guard. */
const PERMISSIVE = /\b(?:any(?:one)?|a user|users?|any (?:signed|logged)[- ]in user)\s+(?:can|could|is able to|are able to)\s+(?:still\s+)?(?:delete|remove|change|edit|modify|bypass|skip)\b/i;

/** Subject words too common in any app to identify what an item is about. */
const GENERIC_SUBJECT = new Set([
  "user", "users", "error", "errors", "message", "messages", "page", "pages", "screen", "screens", "app", "data", "mobile", "file", "files", "list", "state", "value", "values", "field", "fields",
  "button", "text", "name", "request", "requests", "response", "current", "every", "signed", "during", "there", "including", "after", "still", "shows", "shown", "instead", "wrong", "account", "session",
  "breaks", "effectively", "expected", "returns", "using", "used", "make", "made", "does", "doesn", "when", "then", "than", "into", "from", "this", "that", "with", "have", "has", "been", "issue",
  "backend", "frontend", "security", "reported", "confirmed", "bug", "fix", "case", "only", "also", "their", "other", "another", "already", "should", "would", "could", "check", "number",
]);

export interface Premise {
  kind: "absence" | "permissive";
  mechanism: string;
  subjectTerms: string[];
}

/** Only the item's opening (title + first sentences) states the symptom; later text is implementation detail, notes and lists. */
const FOCUS_CHARS = 420;
const MAX_SUBJECT_TERMS = 8;

/** Reads the item text for a reported missing/unguarded mechanism. `null` when the text carries no such premise (⇒ UNRESOLVED). Pure. */
export function detectPremise(text: string): Premise | null {
  const focus = text.slice(0, FOCUS_CHARS);
  let found: { mechanism: string; at: number; kind: Premise["kind"] } | null = null;
  for (const [mechanism, m] of Object.entries(MECHANISMS)) {
    for (const hit of focus.matchAll(m.cue)) {
      const at = hit.index ?? 0;
      const near = focus.slice(Math.max(0, at - PROXIMITY), at + hit[0].length + PROXIMITY);
      if (ABSENCE_CUE.test(near.replace(hit[0], " ")) || /^unlimited$/i.test(hit[0])) {
        if (!found || at < found.at) found = { mechanism, at, kind: "absence" };
      }
    }
  }
  if (!found && PERMISSIVE.test(focus)) found = { mechanism: "block", at: 0, kind: "permissive" };
  if (!found) return null;
  const mechWords = new Set(Object.values(MECHANISMS).flatMap((m) => m.names));
  const subjectTerms = tokenize(focus).filter((t) => t.length >= 3 && !GENERIC_SUBJECT.has(t) && !mechWords.has(t) && !MECHANISMS[found!.mechanism]!.names.some((n) => t.startsWith(n.slice(0, 5))));
  return subjectTerms.length === 0 ? null : { kind: found.kind, mechanism: found.mechanism, subjectTerms };
}

const words = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Mechanism names match a name PART exactly (`blocker`, not `block` — a UI `Block` widget is not a guard). */
const hasExact = (parts: Set<string>, name: string): boolean => parts.has(name);
const hasWord = (parts: Set<string>, term: string): boolean => {
  if (parts.has(term)) return true;
  const stem = term.replace(/(ing|ed|es|s)$/, "");
  if (stem.length >= 4) for (const p of parts) if (p.startsWith(stem)) return true;
  return false;
};

interface Match {
  file: IndexedFile;
  symbol: string | null;
  subjectHits: string[];
}

const MAX_CANDIDATES = 4;
const MAX_IMPORTERS = 4;

/** Which of a file's names produced `parts`: the declared symbol whose words are exactly this set, else the file itself (null). */
function symbolFor(file: IndexedFile, parts: Set<string>): string | null {
  const key = [...parts].join(" ");
  return file.symbols.find((sy) => words(sy).join(" ") === key) ?? null;
}

/** The platform's investigation. `startEvidenceNumber` continues the analysis' evidence ids (E<n>). Never throws for an unreadable file. */
export async function investigate(input: {
  text: string;
  session: RepositorySession | null;
  inspector: RepositoryInspector | null;
  index: RepositoryIndex | null;
  startEvidenceNumber: number;
  signal: AbortSignal;
}): Promise<{ investigation: Investigation; evidence: PlatformEvidence[] }> {
  const { text, session, inspector, index } = input;
  const revision = session?.revision ?? null;
  const done = (signal: InvestigationSignal, explanation: string, premise: Premise | null = null, candidates: InvestigationCandidate[] = [], evidence: PlatformEvidence[] = [], filesRead = 0): { investigation: Investigation; evidence: PlatformEvidence[] } => ({
    investigation: { revision, premise, signal, behavior: "BEHAVIOR_UNVERIFIED" as const, candidates, filesRead, explanation },
    evidence,
  });

  if (!session || !inspector || !revision) return done("UNRESOLVED", "The repository could not be inspected, so the platform investigated nothing.");
  if (!index || index.revision !== revision) return done("UNRESOLVED", "No repository index for this exact revision was available, so the platform could not search declared names.");
  const premise = detectPremise(text);
  if (!premise) return done("UNRESOLVED", "The item text does not report a missing or unguarded mechanism the platform can look for.");

  // 1. Declared names / files that carry BOTH the mechanism and the subject. Only a name's OWN words count (its declared
  //    symbol, or the file's base name) — never its directories: "src/modules/auth" would otherwise match everything.
  const mech = MECHANISMS[premise.mechanism]!.names;
  const partsOfFile = (f: IndexedFile): Array<Set<string>> => [...f.symbols.map((sy) => new Set(words(sy))), new Set(words(f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")))];
  // Distinctiveness of each subject term: in how many files' own names does it occur? A common one (`profile`) needs a partner.
  const df = new Map<string, number>();
  const eligible = index.files.filter((f) => !isNoisePath(f.path) && f.contentIndexed);
  for (const f of eligible) {
    const seen = new Set<string>();
    for (const parts of partsOfFile(f)) for (const t of premise.subjectTerms) if (hasWord(parts, t)) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Words that occur in no file's own names cannot match anything; keep the rest (rarest first).
  const ranked = premise.subjectTerms.filter((t) => (df.get(t) ?? 0) > 0).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, MAX_SUBJECT_TERMS);
  const focusLower = text.slice(0, FOCUS_CHARS).toLowerCase();
  const mentions = (t: string) => focusLower.split(t).length - 1;
  // Distinctive = (almost) unique in this repository's own names, or the item's central noun (named at least twice in its opening).
  // A word mentioned once — often a reference to some OTHER existing mechanism — is not enough on its own.
  const distinctive = (t: string) => (df.get(t) ?? 0) > 0 && ((df.get(t) ?? 0) <= 3 || mentions(t) >= 2);
  const matches: Match[] = [];
  for (const file of eligible) {
    if (file.roles.includes("test")) continue;
    for (const parts of partsOfFile(file)) {
      if (!mech.some((m) => hasExact(parts, m))) continue;
      const hits = ranked.filter((t) => hasWord(parts, t));
      // ≥2 distinct subject words, or one that is rare in this repository's own names.
      if (hits.length >= 2 || (hits.length === 1 && distinctive(hits[0]!))) matches.push({ file, symbol: symbolFor(file, parts), subjectHits: hits });
    }
  }
  matches.sort((a, b) => b.subjectHits.length - a.subjectHits.length || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0) || String(a.symbol).localeCompare(String(b.symbol)));
  const distinct: Match[] = [];
  for (const m of matches) if (distinct.length < MAX_CANDIDATES && !distinct.some((d) => d.file.path === m.file.path)) distinct.push(m);
  if (distinct.length === 0) {
    return done("NO_CONFLICTING_IMPLEMENTATION_EVIDENCE", `The item reports a missing ${premise.mechanism} mechanism; the platform found no declared name or file combining it with ${ranked.slice(0, 4).join("/")} in this revision. This is not proof that none exists.`, premise);
  }

  // 2. Is any of them wired in? Same file (declared and used again) or a file that imports it and uses the name.
  const evidence: PlatformEvidence[] = [];
  const add = (e: Omit<PlatformEvidence, "id" | "revision">): PlatformEvidence => {
    const full: PlatformEvidence = { ...e, id: `E${input.startEvidenceNumber + evidence.length}`, revision };
    evidence.push(full);
    return full;
  };
  const candidates: InvestigationCandidate[] = [];
  let filesRead = 0;
  let extraReads = 0;
  for (const m of distinct) {
    const ids: string[] = [];
    ids.push(add({ type: "SYMBOL_MATCH", source: "repository_index", path: m.file.path, detail: `${m.symbol ?? "(file name)"} — names the ${premise.mechanism} mechanism and ${m.subjectHits.join("/")} @ ${revision.slice(0, 12)}`, matchedTerms: m.subjectHits }).id);
    let wiredIn: string | null = null;
    const own = await inspector.read(m.file.path, input.signal);
    if (own.ok) {
      filesRead++;
      if (m.symbol) {
        const ref = findReferences(own.file.text, m.symbol);
        if (ref) {
          wiredIn = `${m.file.path}:${ref.firstReference.line}`;
          ids.push(add({ type: "SYMBOL_REFERENCE", source: "repository_content", path: m.file.path, detail: `${m.symbol}: declared L${ref.declaredAt}, referenced L${ref.firstReference.line}: ${ref.firstReference.excerpt}`, matchedTerms: [m.symbol] }).id);
        }
      }
    }
    if (wiredIn === null) {
      // A file that imports the candidate AND uses its declared name (or, for a file-level match, simply imports it).
      const importers = index.files.filter((f) => f.imports.includes(m.file.path) && !f.roles.includes("test") && !isNoisePath(f.path)).slice(0, MAX_IMPORTERS);
      for (const imp of importers) {
        if (m.symbol === null) {
          wiredIn = `${imp.path}`;
          ids.push(add({ type: "SYMBOL_REFERENCE", source: "repository_index", path: imp.path, detail: `${m.file.path.slice(m.file.path.lastIndexOf("/") + 1)} is imported here`, matchedTerms: [] }).id);
          break;
        }
        if (extraReads >= 6) break;
        const r = await inspector.read(imp.path, input.signal);
        extraReads++;
        if (!r.ok) continue;
        filesRead++;
        const ref = findReferencesIn(r.file.text, m.symbol);
        if (ref) {
          wiredIn = `${imp.path}:${ref.line}`;
          ids.push(add({ type: "SYMBOL_REFERENCE", source: "repository_content", path: imp.path, detail: `${m.symbol}: imported from ${m.file.path.slice(m.file.path.lastIndexOf("/") + 1)} and used L${ref.line}: ${ref.excerpt}`, matchedTerms: [m.symbol] }).id);
          break;
        }
      }
    }
    candidates.push({ path: m.file.path, symbol: m.symbol, subjectHits: m.subjectHits, wiredIn, evidenceIds: ids });
  }
  // FLOW: does the item's ENTRY POINT reach any of the mechanism candidates? Existence and even use-somewhere are not enough
  // (a login OTP verifier that exists for another endpoint says nothing about `PATCH /user`).
  const entries = locateEntries(index, { text, subjectTerms: ranked, mechanismNames: mech, centralTerms: ranked.filter((t) => mentions(t) >= 2) });
  const trace = traceFlow(index, entries, matches.slice(0, 12).map((m) => ({ file: m.file.path, symbol: m.symbol })));
  const flowIds: string[] = [];
  if (trace.status === "FLOW_REFERENCE_PRESENT") {
    for (const step of trace.path) flowIds.push(add({ type: "SYMBOL_REFERENCE", source: "repository_index", path: step.file, detail: `${step.kind}: ${step.symbol} (entry ${trace.via!.route})`, matchedTerms: [step.symbol] }).id);
  }
  const flow: InvestigationFlow = { status: trace.status, entries: trace.entries, path: trace.path, evidenceIds: flowIds };
  const present = trace.status === "FLOW_REFERENCE_PRESENT";
  const subjects = [...new Set(candidates.flatMap((c) => c.subjectHits))].slice(0, 3).join("/");
  const routes = trace.entries.map((e) => e.route).slice(0, 3).join(", ");
  const explanation = present
    ? `The item reports a missing ${premise.mechanism} mechanism. This revision declares one that names it with ${subjects} (MECHANISM_PRESENT), and the entry point ${trace.via!.route} references it through ${trace.path.map((s) => s.symbol).join(" → ")} (FLOW_REFERENCE_PRESENT — a static name-reference path, not a proven call path). That conflicts with a reported absence. Behavior is unverified.`
    : trace.status === "FLOW_NOT_ESTABLISHED"
      ? `A ${premise.mechanism} mechanism naming ${subjects} exists in this revision (MECHANISM_PRESENT), but the platform could NOT establish that the reported entry point (${routes}) references it (FLOW_NOT_ESTABLISHED). It may protect a different flow; this is not evidence against the item. Behavior is unverified.`
      : `A ${premise.mechanism} mechanism naming ${subjects} exists in this revision (MECHANISM_PRESENT), but the platform could not locate the item's entry point among registered routes (ENTRY_POINT_NOT_LOCATED), so it cannot say whether the mechanism is on the reported flow. A lead, not a conclusion. Behavior is unverified.`;
  const result = done(present ? "IMPLEMENTATION_PRESENT" : "POSSIBLY_ALREADY_IMPLEMENTED", explanation, premise, candidates, evidence, filesRead);
  result.investigation.flow = flow;
  return result;
}

/** First use of `name` in `text` that is not its declaration line (a file that merely imports it). Pure. */
function findReferencesIn(text: string, name: string): { line: number; excerpt: string } | null {
  const re = new RegExp("(?<![\\w$])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w$])");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!) && !/^\s*(?:import|export\s*\{|from\b)/.test(lines[i]!) && !/\brequire\(/.test(lines[i]!)) return { line: i + 1, excerpt: maskSecrets(lines[i]!.trim()).slice(0, 140) };
  }
  return null;
}

