import type { IndexedFile, RepositoryIndex } from "./repository-index.js";
import { isNoisePath } from "./repository-structure.js";

/**
 * Narrow, deterministic FLOW evidence (Phase 4A.6 — /docs/BACKLOG_INTELLIGENCE.md §4g): does the indexed structure connect a
 * REPORTED ENTRY POINT to a MECHANISM?
 *
 *     route registration ─ROUTE_TO_HANDLER→ handler ─DIRECT_REFERENCE / IMPORT_REFERENCE→ … ─→ mechanism
 *
 * This is NOT a call graph. Edges are static NAME references extracted line-by-line for TypeScript/JavaScript (Express-style
 * `router.METHOD("/path", handler…)`): a function body mentions a name that is declared in its own file (DIRECT_REFERENCE) or in a
 * file it imports (IMPORT_REFERENCE). It knows nothing of types, dynamic dispatch, conditions, middleware order or whether the code
 * runs, so a found path means "FLOW_REFERENCE_PRESENT", never "the runtime call path is proven". Not finding one means
 * "FLOW_NOT_ESTABLISHED" — which is different from "there is no flow". Dart has declared-symbol references but no route
 * registrations the extractor understands, so a UI-only flow has no entry point here (ENTRY_POINT_NOT_LOCATED).
 *
 * Three facts, kept apart everywhere:  MECHANISM_PRESENT (it exists)  ≠  FLOW_REFERENCE_PRESENT (this entry point references
 * it, statically)  ≠  BEHAVIOR_VERIFIED (an approved check passed).
 */

export type FlowStatus = "FLOW_REFERENCE_PRESENT" | "FLOW_NOT_ESTABLISHED" | "ENTRY_POINT_NOT_LOCATED";
export type FlowStepKind = "ROUTE_TO_HANDLER" | "DIRECT_REFERENCE" | "IMPORT_REFERENCE";

export interface FlowEntry {
  /** "PATCH /user" as registered. */
  route: string;
  /** The file that registers it. */
  file: string;
  /** Handler/middleware names on the registration that resolve to a declaration (same file or imported). */
  handlers: string[];
  /** How the entry was located: named in the item text, or inferred from the item's subject words. */
  located: "named_in_item" | "inferred_from_subject";
}

export interface FlowStep {
  kind: FlowStepKind;
  symbol: string;
  file: string;
}

export interface FlowTrace {
  status: FlowStatus;
  entries: FlowEntry[];
  /** The first path found from an entry to the mechanism (empty unless FLOW_REFERENCE_PRESENT). */
  path: FlowStep[];
  /** The entry the path starts from. */
  via: FlowEntry | null;
}

const MAX_DEPTH = 6;
const MAX_ENTRIES = 5;
/** Verbs that describe the ACTION, not the subject: alone they must not pick an entry point. */
const ACTION_WORDS = new Set(["delete", "deleting", "remove", "update", "create", "change", "edit", "add", "save", "send", "show", "get", "set", "open", "list", "login", "request"]);
const ROUTE_IN_TEXT = /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:\/[\w:.{}-]+)+)/gi;

const segs = (p: string): string[] => p.toLowerCase().split("/").filter(Boolean);
const isParam = (s: string) => s.startsWith(":") || (s.startsWith("{") && s.endsWith("}"));
const words = (s: string): Set<string> => new Set(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/** Routes the item text names ("PATCH /api/v1/user"). Pure. */
export function routesNamedIn(text: string): Array<{ method: string; path: string }> {
  return [...text.matchAll(ROUTE_IN_TEXT)].map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]! })).slice(0, 4);
}

/** Does a REGISTERED route (relative to wherever its router is mounted) plausibly correspond to a full path? Method must match; the registered path must be a suffix of it, or `/` in a module named by it. */
function routeMatches(registered: string, file: string, wanted: { method: string; path: string }): boolean {
  const [method, ...rest] = registered.split(" ");
  const path = rest.join(" ");
  if (method !== wanted.method && method !== "ALL") return false;
  const reg = segs(path);
  const full = segs(wanted.path);
  if (reg.length === 0) {
    // "/" is relative to its mount: accept it when the file lives in a module/dir named by a segment of the wanted path.
    const dirs = new Set(file.toLowerCase().split("/").flatMap((d) => [d, d.replace(/\.[^.]+$/, "").replace(/[._-]?routes?$/, "")]));
    return full.some((s) => !isParam(s) && !/^v\d+$/.test(s) && s !== "api" && dirs.has(s));
  }
  if (reg.length > full.length) return false;
  const tail = full.slice(full.length - reg.length);
  // A literal segment must equal the wanted one; a registered parameter can only stand for a parameter in the wanted path.
  return reg.every((s, i) => (isParam(s) ? isParam(tail[i]!) : s === tail[i]));
}

export function locateEntries(index: RepositoryIndex, input: { text: string; subjectTerms: string[]; mechanismNames: string[]; centralTerms?: string[] }): FlowEntry[] {
  const out: FlowEntry[] = [];
  const named = routesNamedIn(input.text);
  const mech = new Set(input.mechanismNames);
  const central = new Set(input.centralTerms ?? []);
  for (const file of index.files) {
    if (isNoisePath(file.path) || !file.routeBindings) continue;
    for (const b of file.routeBindings) {
      if (b.route.startsWith("USE ")) continue; // a mount, not an endpoint
      const wanted = named.find((n) => routeMatches(b.route, file.path, n));
      if (wanted) {
        out.push({ route: b.route, file: file.path, handlers: b.handlers, located: "named_in_item" });
        continue;
      }
      if (named.length > 0) continue; // the item named its entry point: only those count
      const hw = new Set<string>();
      for (const h of b.handlers) for (const w of words(h)) hw.add(w);
      for (const w of words(b.route)) hw.add(w);
      const hits = input.subjectTerms.filter((t) => [...hw].some((w) => w === t || (t.length >= 4 && w.startsWith(t.replace(/(ing|ed|es|s)$/, "")))) && !mech.has(t));
      // An inferred entry needs ≥ 2 distinct subject words on the registration (route path + handler names), or the item's central noun —
      // one action word ("delete") must not pick `adminDeletePlanHandler` for a profile item.
      if (hits.length >= 2 || hits.some((h) => central.has(h) && !ACTION_WORDS.has(h))) out.push({ route: b.route, file: file.path, handlers: b.handlers, located: "inferred_from_subject" });
    }
  }
  const strength = (e: FlowEntry) => (e.located === "named_in_item" ? 100 : 0) + input.subjectTerms.filter((t) => { const w = new Set([...e.handlers.flatMap((h) => [...words(h)]), ...words(e.route), ...words(e.file)]); return [...w].some((x) => x === t); }).length;
  out.sort((a, b) => strength(b) - strength(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.route < b.route ? -1 : 1));
  return out.slice(0, MAX_ENTRIES);
}

/** Node key for BFS. */
const key = (file: string, symbol: string) => `${file}#${symbol}`;

/** The file (this one, or one it imports) that declares `name`, with how it is reached. */
function resolve(index: Map<string, IndexedFile>, from: IndexedFile, name: string): { file: IndexedFile; kind: FlowStepKind } | null {
  if (from.symbols.includes(name)) return { file: from, kind: "DIRECT_REFERENCE" };
  for (const imp of from.imports) {
    const f = index.get(imp);
    if (f?.symbols.includes(name)) return { file: f, kind: "IMPORT_REFERENCE" };
  }
  return null;
}

/**
 * Looks for a static name-reference path from `entries` to the mechanism (`target.file`, and `target.symbol` when the mechanism is a
 * declared name; a file-level mechanism matches any symbol declared in that file). Breadth-first, depth ≤ 6, deterministic.
 */
export function traceFlow(index: RepositoryIndex, entries: FlowEntry[], targets: Array<{ file: string; symbol: string | null }>): FlowTrace {
  if (entries.length === 0) return { status: "ENTRY_POINT_NOT_LOCATED", entries, path: [], via: null };
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const hit = (file: string, symbol: string) => targets.some((t) => t.file === file && (t.symbol === null || t.symbol === symbol));
  for (const entry of entries) {
    const routeFile = byPath.get(entry.file);
    if (!routeFile) continue;
    const seen = new Set<string>();
    let frontier: Array<{ file: IndexedFile; symbol: string; path: FlowStep[] }> = [];
    for (const h of entry.handlers) {
      const r = resolve(byPath, routeFile, h);
      if (r) frontier.push({ file: r.file, symbol: h, path: [{ kind: "ROUTE_TO_HANDLER", symbol: h, file: r.file.path }] });
    }
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        const k = key(node.file.path, node.symbol);
        if (seen.has(k)) continue;
        seen.add(k);
        if (hit(node.file.path, node.symbol)) return { status: "FLOW_REFERENCE_PRESENT", entries, path: node.path, via: entry };
        for (const ref of node.file.refs?.[node.symbol] ?? []) {
          const r = resolve(byPath, node.file, ref);
          if (r) next.push({ file: r.file, symbol: ref, path: [...node.path, { kind: r.kind, symbol: ref, file: r.file.path }] });
        }
      }
      frontier = next;
    }
  }
  return { status: "FLOW_NOT_ESTABLISHED", entries, path: [], via: null };
}
