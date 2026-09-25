import type { IndexedFile, RepositoryIndex } from "./repository-index.js";
import { isNoisePath, tokenize } from "./repository-structure.js";
import { isSecretPath } from "./repository-inspector.js";

/**
 * Deterministic, bounded file ranking from the repository index (Phase 4A.3). Replaces "the file NAME
 * contains a word from the item" with a score that also uses declared symbols, route strings, the
 * application/feature the file belongs to, its role, and its import neighbourhood.
 *
 * Pure: the same (index, query, options) always gives the same ranking — no clock, no randomness, no I/O,
 * no model. It ranks; it establishes nothing. A high rank means "probably worth reading", never "this is
 * where the bug is" and never "this works" — what is ultimately claimed about a file comes from platform
 * evidence gathered by reading it (evidence.ts), not from where it ranked.
 */

export interface RankedFile {
  path: string;
  score: number;
  /** Why it ranked ("name", "symbol:deleteProfile", "route", "feature", "imports:profile.service.ts", …) — for people, never fed back as evidence. */
  reasons: string[];
}

export interface RankOptions {
  maxResults: number;
  /** Project Context text (project-owned data). It can only nudge files inside applications/features it names; it never adds a file on its own. */
  contextText?: string | null;
}

const NAME_WEIGHT = 3;
const DIR_WEIGHT = 1;
const SYMBOL_WEIGHT = 4;
const ROUTE_WEIGHT = 3;
const FEATURE_WEIGHT = 2;
const NEIGHBOR_WEIGHT = 2;
const ROLE_WEIGHT = 1;
const CONTEXT_WEIGHT = 1;
const TEST_PENALTY = 2;
/** Files that must already score at least this to seed import-neighbour boosts. */
const SEED_MIN_SCORE = 4;
const MAX_SEEDS = 5;

/**
 * The query word and, when it has an inflection, its stem — so "deleting"/"blocked"/"limits" still meet
 * `deleteProfile`/`Blocker`/`limit`. Deliberately crude (suffix stripping, no dictionary): it widens
 * what a WORD can match, and the ranking is only a shortlist that the evidence layer re-checks.
 */
export function wordVariants(token: string): string[] {
  const stem = token.replace(/(ing|ed|es|s)$/, "");
  return stem.length >= 4 && stem !== token ? [token, stem] : [token];
}

/**
 * How much a query word counts, by how many files it touches: a word matching a handful of files is a strong
 * signal, one matching hundreds ("error", "message", "status", "mobile" in a mobile app) is nearly noise. Pure
 * document-frequency damping (no dictionary, no model): 1 up to 4 matching files, then falling logarithmically
 * (16 files ≈ 0.59, 64 ≈ 0.42, 300 ≈ 0.31). Found by a real run whose top files were driven by generic words.
 */
export function rarityWeight(matchingFiles: number): number {
  return 1 / (1 + 0.35 * Math.log2(Math.max(1, matchingFiles / 4)));
}

const singular = (s: string) => (s.length > 3 && s.endsWith("s") ? s.slice(0, -1) : s);

/** Words in an item that suggest which ROLE of file it is about. A nudge only (applied to files that already matched). */
const ROLE_WORDS: Array<[RegExp, Array<IndexedFile["roles"][number]>]> = [
  [/\b(screen|page|ui|button|widget|tab|menu|dialog|modal|layout|scroll|render|tile|banner|icon|view)\b/i, ["screen", "component"]],
  [/\b(api|endpoint|route|request|response|http|status|payload|controller|rate|limit|throttle)\b/i, ["route", "controller", "service"]],
  [/\b(model|schema|database|collection|record|field|persist)\b/i, ["model", "repository"]],
  [/\b(valid|validation|invalid|format|required)\b/i, ["validator", "middleware"]],
];
const TEST_WORDS = /\b(test|tests|spec|unit|coverage|regression)\b/i;

interface Prepared {
  file: IndexedFile;
  nameLower: string;
  dirs: string[];
  symbolsLower: string[];
  routesLower: string;
}

export function rankFiles(index: RepositoryIndex, queryText: string, options: RankOptions): RankedFile[] {
  const tokens = tokenize(queryText);
  if (tokens.length === 0) return [];
  const wantsTests = TEST_WORDS.test(queryText);
  const roleTargets = new Set<string>();
  for (const [re, roles] of ROLE_WORDS) if (re.test(queryText)) for (const r of roles) roleTargets.add(r);

  const candidates: Prepared[] = index.files
    .filter((f) => !isNoisePath(f.path) && !isSecretPath(f.path))
    .map((file) => {
      const segments = file.path.toLowerCase().split("/");
      return { file, nameLower: segments[segments.length - 1] ?? "", dirs: segments.slice(0, -1), symbolsLower: file.symbols.map((s) => s.toLowerCase()), routesLower: file.routes.join(" ").toLowerCase() };
    });

  // Names of applications/features the Project Context mentions (it can only boost files in these).
  const contextTokens = new Set(options.contextText ? tokenize(options.contextText) : []);
  const hinted = new Set<string>();
  for (const { file } of candidates) {
    for (const name of [file.feature, ...file.application.split("/")]) {
      if (name && contextTokens.has(singular(name.toLowerCase()))) hinted.add(singular(name.toLowerCase()));
    }
  }

  const featureNamesOf = (p: Prepared) => [p.file.feature, ...p.file.application.split("/")].filter((x): x is string => !!x).map((x) => singular(x.toLowerCase()));
  const weightOf = new Map<string, number>();
  for (const word of tokens) {
    const variants = wordVariants(word);
    const hasIn = (haystack: string) => variants.some((v) => haystack.includes(v));
    let df = 0;
    for (const p of candidates) {
      if (hasIn(p.nameLower) || p.dirs.some((d) => hasIn(d)) || p.symbolsLower.some((sym) => hasIn(sym)) || hasIn(p.routesLower) || featureNamesOf(p).includes(singular(word))) df++;
    }
    weightOf.set(word, rarityWeight(df));
  }

  const scores = new Map<string, { score: number; reasons: string[]; direct: number }>();
  for (const p of candidates) {
    const reasons: string[] = [];
    let score = 0;
    let symbolNote: string[] = [];
    for (const word of tokens) {
      const variants = wordVariants(word);
      const token = word;
      const hasIn = (haystack: string) => variants.some((v) => haystack.includes(v));
      const w = weightOf.get(word) ?? 1;
      if (hasIn(p.nameLower)) {
        score += NAME_WEIGHT * w;
        if (!reasons.includes("name")) reasons.push("name");
      } else if (p.dirs.some((d) => hasIn(d))) {
        score += DIR_WEIGHT * w;
        if (!reasons.includes("directory")) reasons.push("directory");
      }
      const symbolIdx = p.symbolsLower.findIndex((s) => hasIn(s));
      if (symbolIdx !== -1) {
        score += SYMBOL_WEIGHT * w;
        if (symbolNote.length < 2) symbolNote.push(p.file.symbols[symbolIdx]!);
      }
      if (hasIn(p.routesLower)) {
        score += ROUTE_WEIGHT * w;
        if (!reasons.includes("route")) reasons.push("route");
      }
      if (featureNamesOf(p).includes(singular(token))) {
        score += FEATURE_WEIGHT * w;
        if (!reasons.includes("feature")) reasons.push("feature");
      }
    }
    if (symbolNote.length > 0) reasons.push(...symbolNote.map((s) => `symbol:${s}`));
    scores.set(p.file.path, { score, reasons, direct: score });
  }

  // Structural relationship: files a strong match imports, or is imported by, are likely part of the same change.
  const seeds = [...scores.entries()]
    .filter(([, v]) => v.direct >= SEED_MIN_SCORE)
    .sort((a, b) => b[1].direct - a[1].direct || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SEEDS)
    .map(([path]) => path);
  if (seeds.length > 0) {
    const seedSet = new Set(seeds);
    const byPath = new Map(index.files.map((f) => [f.path, f]));
    const boosted = new Set<string>();
    const boost = (path: string, reason: string) => {
      const entry = scores.get(path);
      if (!entry || seedSet.has(path) || boosted.has(path)) return;
      boosted.add(path);
      entry.score += NEIGHBOR_WEIGHT;
      entry.reasons.push(reason);
    };
    for (const seed of seeds) {
      const seedName = seed.slice(seed.lastIndexOf("/") + 1);
      for (const imported of byPath.get(seed)?.imports ?? []) boost(imported, `imported-by:${seedName}`);
    }
    for (const f of index.files) {
      const hit = f.imports.find((i) => seedSet.has(i));
      if (hit) boost(f.path, `imports:${hit.slice(hit.lastIndexOf("/") + 1)}`);
    }
  }

  const ranked: RankedFile[] = [];
  for (const p of candidates) {
    const entry = scores.get(p.file.path)!;
    let { score } = entry;
    const reasons = [...entry.reasons];
    if (score <= 0) continue;
    if (roleTargets.size > 0 && p.file.roles.some((r) => roleTargets.has(r))) {
      score += ROLE_WEIGHT;
      reasons.push("role");
    }
    if (entry.direct > 0 && (hinted.has(singular((p.file.feature ?? "").toLowerCase())) || p.file.application.split("/").some((a) => hinted.has(singular(a.toLowerCase()))))) {
      score += CONTEXT_WEIGHT;
      reasons.push("project-context");
    }
    if (!wantsTests && p.file.roles.includes("test")) score -= TEST_PENALTY;
    if (score > 0) ranked.push({ path: p.file.path, score: Math.round(score * 100) / 100, reasons });
  }
  ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ranked.slice(0, options.maxResults);
}
