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

/**
 * The ranking's tunable knobs, named so an experiment is a configuration and not a code fork. `BASELINE_RANK_CONFIG`
 * is exactly the Phase 4A.3 behaviour and exists so the retrieval benchmark can measure every change against it
 * (see docs/BACKLOG_INTELLIGENCE.md §4e/§15); `DEFAULT_RANK_CONFIG` is what production uses.
 */
export interface RankConfig {
  /**
   * How much a token's SECOND, THIRD… kind of evidence (name, directory, feature, symbol, route) counts relative to
   * its strongest one. 1 = they simply add (Phase 4A.3): one generic word that appears in a file's name, folder,
   * feature AND a declared symbol then outscores a file matching several DIFFERENT words once. Lower values reward
   * breadth across distinct query words over repeated evidence for one.
   */
  evidenceSaturation: number;
  /** Bonus when the item text names the file by path (a suffix of its repo path) — an exact, human-supplied pointer. 0 = off. */
  exactPathBonus: number;
  /** Bonus when the item text names the file by its full file name (with extension), if that name is not shared by many files. 0 = off. */
  exactFileBonus: number;
  /** Bonus per declared identifier the item text quotes verbatim (camelCase/snake_case), up to two. 0 = off. */
  exactIdentifierBonus: number;
  /**
   * How a query word matches a DECLARED symbol: `substring` (Phase 4A.3: `scroll` hits `_pausePlayerWhenScrolledOffScreen`) or
   * `word` (the word must be a whole camelCase/snake_case part of the name, or its stem).
   */
  symbolMatch: "substring" | "word";
  /** Only the first N characters of the item text supply query WORDS (named files/identifiers are still read from all of it). 0 = no cap. */
  queryWordChars: number;
}

export const BASELINE_RANK_CONFIG: RankConfig = { evidenceSaturation: 1, exactPathBonus: 0, exactFileBonus: 0, exactIdentifierBonus: 0, symbolMatch: "substring", queryWordChars: 0 };
/**
 * Adopted in Phase 4A.5 after being measured on the TUNE half of the retrieval benchmark (variants: exact mentions,
 * evidence saturation, whole-word symbol matching, query-length cap, excerpt count — see docs/BACKLOG_INTELLIGENCE.md §15).
 * Evidence saturation was tried and REJECTED (it lowered excerpt recall). The hold-out half was not inspected while choosing.
 */
export const DEFAULT_RANK_CONFIG: RankConfig = { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, symbolMatch: "word", queryWordChars: 600 };

export interface RankOptions {
  maxResults: number;
  config?: Partial<RankConfig>;
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

/** True if the name's parts contain the word, or a part starts with the (stemmed) word — so `delet` (from "deleting") meets `delete`. */
function partsHaveWord(parts: Set<string>, variants: string[]): boolean {
  for (const v of variants) {
    if (parts.has(v)) return true;
    if (v.length >= 4) for (const part of parts) if (part.startsWith(v)) return true;
  }
  return false;
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

const FILENAME_IN_TEXT = /[\w.-]+\.(?:dart|tsx?|jsx?|kt|kts|gradle|properties|ya?ml)\b/gi;
const PATH_IN_TEXT = /[\w.-]+(?:\/[\w.-]+)+/g;
const IDENT_IN_TEXT = /\b(?:[a-z_$]+[A-Z][A-Za-z0-9_$]*|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
/** A file name shared by more than this many files says nothing when the text mentions it. */
const MAX_SHARED_BASENAME = 3;

/** What the item text names verbatim: files (by name), paths (by suffix) and identifiers. Pure. */
export function mentionsIn(text: string): { files: Set<string>; paths: string[]; identifiers: Set<string> } {
  const files = new Set((text.match(FILENAME_IN_TEXT) ?? []).map((f) => f.toLowerCase()));
  const paths = (text.match(PATH_IN_TEXT) ?? []).map((p) => p.toLowerCase().replace(/^\.?\//, "")).filter((p) => p.split("/").length >= 2);
  const identifiers = new Set((text.match(IDENT_IN_TEXT) ?? []).filter((i) => i.length >= 6));
  return { files, paths, identifiers };
}

interface Prepared {
  file: IndexedFile;
  nameLower: string;
  dirs: string[];
  symbolsLower: string[];
  symbolWords: Array<Set<string>>;
  routesLower: string;
}

export function rankFiles(index: RepositoryIndex, queryText: string, options: RankOptions): RankedFile[] {
  const cfg: RankConfig = { ...DEFAULT_RANK_CONFIG, ...options.config };
  const tokens = tokenize(cfg.queryWordChars > 0 ? queryText.slice(0, cfg.queryWordChars) : queryText);
  if (tokens.length === 0) return [];
  const mentioned = mentionsIn(queryText);
  const basenameCount = new Map<string, number>();
  for (const f of index.files) {
    const b = f.path.slice(f.path.lastIndexOf("/") + 1).toLowerCase();
    basenameCount.set(b, (basenameCount.get(b) ?? 0) + 1);
  }
  const wantsTests = TEST_WORDS.test(queryText);
  const roleTargets = new Set<string>();
  for (const [re, roles] of ROLE_WORDS) if (re.test(queryText)) for (const r of roles) roleTargets.add(r);

  const candidates: Prepared[] = index.files
    .filter((f) => !isNoisePath(f.path) && !isSecretPath(f.path))
    .map((file) => {
      const segments = file.path.toLowerCase().split("/");
      return { file, nameLower: segments[segments.length - 1] ?? "", dirs: segments.slice(0, -1), symbolsLower: file.symbols.map((s) => s.toLowerCase()), symbolWords: file.symbols.map((s) => new Set(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))), routesLower: file.routes.join(" ").toLowerCase() };
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
      if (hasIn(p.nameLower) || p.dirs.some((d) => hasIn(d)) || (cfg.symbolMatch === "word" ? p.symbolWords.some((ws) => partsHaveWord(ws, variants)) : p.symbolsLower.some((sym) => hasIn(sym))) || hasIn(p.routesLower) || featureNamesOf(p).includes(singular(word))) df++;
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
      const evidence: number[] = [];
      if (hasIn(p.nameLower)) {
        evidence.push(NAME_WEIGHT);
        if (!reasons.includes("name")) reasons.push("name");
      } else if (p.dirs.some((d) => hasIn(d))) {
        evidence.push(DIR_WEIGHT);
        if (!reasons.includes("directory")) reasons.push("directory");
      }
      const symbolIdx = cfg.symbolMatch === "word" ? p.symbolWords.findIndex((ws) => partsHaveWord(ws, variants)) : p.symbolsLower.findIndex((s) => hasIn(s));
      if (symbolIdx !== -1) {
        evidence.push(SYMBOL_WEIGHT);
        if (symbolNote.length < 2) symbolNote.push(p.file.symbols[symbolIdx]!);
      }
      if (hasIn(p.routesLower)) {
        evidence.push(ROUTE_WEIGHT);
        if (!reasons.includes("route")) reasons.push("route");
      }
      if (featureNamesOf(p).includes(singular(token))) {
        evidence.push(FEATURE_WEIGHT);
        if (!reasons.includes("feature")) reasons.push("feature");
      }
      if (evidence.length > 0) {
        const top = Math.max(...evidence);
        const rest = evidence.reduce((a, b) => a + b, 0) - top;
        score += w * (top + cfg.evidenceSaturation * rest);
      }
    }
    // Exact pointers the item text itself supplies — far more specific than any word overlap.
    if (cfg.exactPathBonus > 0 || cfg.exactFileBonus > 0) {
      const pathLower = p.file.path.toLowerCase();
      if (cfg.exactPathBonus > 0 && mentioned.paths.some((m) => pathLower === m || pathLower.endsWith(`/${m}`))) {
        score += cfg.exactPathBonus;
        reasons.push("named-path");
      } else if (cfg.exactFileBonus > 0 && mentioned.files.has(p.nameLower) && (basenameCount.get(p.nameLower) ?? 0) <= MAX_SHARED_BASENAME) {
        score += cfg.exactFileBonus;
        reasons.push("named-file");
      }
    }
    if (cfg.exactIdentifierBonus > 0 && mentioned.identifiers.size > 0) {
      const hits = p.file.symbols.filter((sym) => mentioned.identifiers.has(sym));
      if (hits.length > 0) {
        score += cfg.exactIdentifierBonus * Math.min(2, hits.length);
        reasons.push(`named-symbol:${hits[0]}`);
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
