import { createHash } from "node:crypto";
import { isSecretPath, RepositoryInspector, type SkipReason } from "./repository-inspector.js";
import { isNoisePath, type RepositorySession } from "./repository-structure.js";

/**
 * The minimal, deterministic, revision-bound repository index (Phase 4A.3 — /docs/BACKLOG_INTELLIGENCE.md
 * "Repository index"). It answers "which files are probably about this?" from repository STRUCTURE — paths,
 * application/feature, roles, declared symbols, route strings, imports — instead of from file names alone.
 *
 * WHAT IT IS NOT: not a vector store, not RAG, no embeddings, no model call. It is a plain, bounded table
 * extracted by line-oriented patterns for the languages actually present in the connected repositories
 * (TypeScript/JavaScript and Dart today; adding one is a `LanguageExtractor` entry — nothing else changes).
 * It is not a parser and does not claim to understand code: a regex-found symbol is "a declaration with this
 * name appears in this file", nothing more.
 *
 * OWNERSHIP: platform-generated from repository contents, never written by a model. A model may CONSUME
 * ranking derived from it (as a list of paths); it cannot add, edit or vouch for an entry.
 *
 * BINDING: an index describes exactly ONE commit (`revision`) of ONE repository source (`sourceKey`). It is
 * only ever looked up by (project, sourceKey, revision, schemaVersion), so a repository that has moved on
 * misses the cache; `assertIndexMatches` is the defence-in-depth check consumers run before trusting one.
 *
 * WHAT IT ESTABLISHES: that a declaration/route/import exists in that file at that revision. It says nothing
 * about whether the code works — the evidence layer keeps that distinction (evidence.ts `SYMBOL_MATCH`).
 */

/** Bump when the extracted shape or extraction rules change: old rows are then never matched (a rebuild happens lazily). */
export const INDEX_SCHEMA_VERSION = 2;

export type IndexLanguage = "typescript" | "javascript" | "dart" | "other";

export type FileRole =
  | "route"
  | "controller"
  | "service"
  | "model"
  | "repository"
  | "middleware"
  | "validator"
  | "provider"
  | "screen"
  | "component"
  | "hook"
  | "test"
  | "config";

export interface IndexedFile {
  path: string;
  language: IndexLanguage;
  /** Top-level application/package the file belongs to ("backend", "frontend/mobile"); "(root)" for files at the repository root. */
  application: string;
  /** The feature/module directory the file sits in ("profiles" for `src/modules/profiles/…`), when the layout names one. */
  feature: string | null;
  roles: FileRole[];
  /** True when the file's CONTENT was read and extracted (else only path-derived fields are populated). */
  contentIndexed: boolean;
  bytes: number | null;
  /** Declared names found in the file (bounded, deduplicated). Existence only. */
  symbols: string[];
  /** Route strings found in the file ("POST /otp/send"). */
  routes: string[];
  /** Imports resolved to OTHER FILES of this repository (paths). Unresolvable/external ones are dropped here. */
  imports: string[];
  /** External package names imported (bounded). */
  packages: string[];
  /**
   * STRUCTURE for flow evidence (Phase 4A.6): for each declared FUNCTION/METHOD, the names its body mentions that are declared in
   * this file or in a file it imports (pruned at build time to those). A static NAME reference — not a call graph: it does not know
   * types, dispatch, conditions or whether the code runs.
   */
  refs?: Record<string, string[]>;
  /** Route registrations with the handler/middleware names on the same call (Express-style, single call), pruned like `refs`. */
  routeBindings?: Array<{ route: string; handlers: string[] }>;
}

export interface IndexCoverage {
  /** Files with a language extractor (candidates for content indexing). */
  eligibleFiles: number;
  contentIndexedFiles: number;
  bytesRead: number;
  /** Eligible files that were not indexed, by reason ("byte_limit", "file_limit", "deadline", "too_large", …). */
  skipped: Record<string, number>;
  /** False when a limit stopped content indexing early or the repository listing itself was capped. */
  complete: boolean;
}

export interface RepositoryIndex {
  schemaVersion: number;
  /** The exact commit SHA this index was built from. */
  revision: string;
  /** Hash of (repository URL, branch) — see `sourceKeyOf`. */
  sourceKey: string;
  generatedAt: string;
  totalFiles: number;
  listingTruncated: boolean;
  files: IndexedFile[];
  coverage: IndexCoverage;
}

/** Limits for ONE index build (once per revision) — deliberately separate from, and never used to raise, the per-analysis inspection limits. */
export interface IndexBuildLimits {
  maxContentFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  deadlineMs: number;
  /** Concurrent blob reads. The byte/file budget can be overrun by at most `concurrency - 1` files' worth (reads in flight when a limit is reached). */
  concurrency: number;
}

export const DEFAULT_INDEX_BUILD_LIMITS: IndexBuildLimits = {
  maxContentFiles: 900,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  deadlineMs: 180_000,
  concurrency: 8,
};

const MAX_SYMBOLS_PER_FILE = 80;
const MAX_REFS_PER_SYMBOL = 25;
const MAX_BODY_LINES = 220;
const MAX_ROUTE_BINDINGS = 40;
const MAX_ROUTES_PER_FILE = 30;
const MAX_IMPORTS_PER_FILE = 30;
const MAX_PACKAGES_PER_FILE = 15;

/** Identifies the repository a project points at, so an index built for one repository can never serve another. */
export function sourceKeyOf(project: { repoUrl: string; defaultBranch: string }): string {
  return createHash("sha256").update(`${project.repoUrl}\n${project.defaultBranch}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Path-derived structure (application / feature / roles)
// ---------------------------------------------------------------------------

/** Directories that only group applications (monorepo containers): the application is then the NEXT segment too. */
const APPLICATION_CONTAINERS = new Set(["apps", "packages", "services", "frontend", "clients", "projects"]);
/** Directories whose child directory names a feature/module. */
const FEATURE_CONTAINERS = new Set(["modules", "features", "feature", "screens", "pages", "domains"]);

export function applicationOf(path: string): string {
  const segments = path.split("/");
  if (segments.length === 1) return "(root)";
  const first = segments[0]!;
  if (APPLICATION_CONTAINERS.has(first.toLowerCase()) && segments.length > 2) return `${first}/${segments[1]}`;
  return first;
}

export function featureOf(path: string): string | null {
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 2; i++) {
    if (FEATURE_CONTAINERS.has(segments[i]!.toLowerCase())) return segments[i + 1]!;
  }
  return null;
}

const ROLE_BY_DIR: Array<[RegExp, FileRole]> = [
  [/^controllers?$/, "controller"],
  [/^services?$/, "service"],
  [/^(routes?|routers?)$/, "route"],
  [/^(models?|schemas?|entities|entity)$/, "model"],
  [/^(repositor(y|ies)|datasources?)$/, "repository"],
  [/^middlewares?$/, "middleware"],
  [/^validators?$/, "validator"],
  [/^(providers?|blocs?|cubits?|stores?|state)$/, "provider"],
  [/^(screens?|pages?|views?)$/, "screen"],
  [/^(widgets?|components?)$/, "component"],
  [/^hooks?$/, "hook"],
  [/^(__tests__|tests?|spec)$/, "test"],
  [/^(config|configs|configuration)$/, "config"],
];

const ROLE_BY_SUFFIX: Array<[RegExp, FileRole]> = [
  [/[._-]controller$/, "controller"],
  [/[._-]service$/, "service"],
  [/[._-]routes?$|[._-]router$/, "route"],
  [/[._-](model|schema|entity)$/, "model"],
  [/[._-](repository|repo|datasource|data_source)$/, "repository"],
  [/[._-]middleware$/, "middleware"],
  [/[._-]validators?$/, "validator"],
  [/[._-](provider|bloc|cubit|store|slice|notifier)$/, "provider"],
  [/[._-](page|screen|view)$/, "screen"],
  [/[._-](widget|component)$/, "component"],
  [/[._-]hook$|^use[A-Z]/, "hook"],
  [/[._-](test|spec)$/, "test"],
  [/[._-]config$/, "config"],
];

/** Roles a path alone suggests. Content can add more (`extractFile`). Pure. */
export function rolesFromPath(path: string): FileRole[] {
  const segments = path.split("/");
  const file = segments[segments.length - 1] ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  const roles = new Set<FileRole>();
  for (const dir of segments.slice(0, -1)) {
    for (const [re, role] of ROLE_BY_DIR) if (re.test(dir.toLowerCase())) roles.add(role);
  }
  for (const [re, role] of ROLE_BY_SUFFIX) {
    // `use[A-Z]` is case-sensitive on the original stem; the rest are matched case-insensitively.
    if (re.test(role === "hook" ? stem : stem.toLowerCase())) roles.add(role);
  }
  if (/\.(test|spec)\.[a-z]+$/i.test(file) || /_test\.dart$/.test(file)) roles.add("test");
  return [...roles];
}

// ---------------------------------------------------------------------------
// Language extractors (line-oriented, bounded; NOT parsers)
// ---------------------------------------------------------------------------

interface Extraction {
  symbols: string[];
  routes: string[];
  refs: Record<string, string[]>;
  routeBindings: Array<{ route: string; handlers: string[] }>;
  /** Raw import specifiers, resolved to repository paths later (needs the whole listing). */
  imports: string[];
  roles: FileRole[];
}

export interface LanguageExtractor {
  language: IndexLanguage;
  /** Lowercase extensions, no dot. */
  extensions: string[];
  /** Whether a path is worth reading at all (skip type declarations, generated code, minified bundles). */
  eligible(path: string): boolean;
  extract(text: string): Extraction;
}

const NOT_A_NAME = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "constructor", "super", "await", "yield", "typeof", "new", "else", "do", "try", "with", "import", "export",
  // Dart framework overrides that carry no meaning about the feature
  "build", "initState", "dispose", "didChangeDependencies", "toString", "hashCode", "createState",
]);

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "await", "async", "this", "new", "null", "undefined", "true", "false", "else", "for", "while", "switch", "case", "break", "continue", "throw", "try", "catch", "finally",
  "typeof", "instanceof", "import", "export", "from", "class", "extends", "super", "void", "default", "static", "final", "String", "Future", "Promise", "Array", "Object", "Error", "Date", "Map", "Set", "JSON", "Math",
  "console", "then", "length", "push", "map", "filter", "forEach", "catch", "toString", "print", "debugPrint", "required", "override", "dynamic", "bool", "double", "List", "int", "num", "when",
]);

class Collector {
  readonly symbols = new Set<string>();
  readonly routes = new Set<string>();
  readonly imports = new Set<string>();
  readonly roles = new Set<FileRole>();
  /** Function-like declarations with their first line, for body extraction. Classes/interfaces are NOT bodies (they'd link everything to everything). */
  private readonly decls: Array<{ name: string; line: number }> = [];
  readonly routeBindings: Array<{ route: string; handlers: string[] }> = [];
  symbol(name: string | undefined, line?: number, functionLike = false): void {
    if (!name || name.length < 2 || name.length > 80 || NOT_A_NAME.has(name)) return;
    if (this.symbols.size < MAX_SYMBOLS_PER_FILE) this.symbols.add(name);
    if (functionLike && line !== undefined && !this.decls.some((d) => d.name === name)) this.decls.push({ name, line });
  }
  route(text: string): void {
    const t = text.replace(/\s+/g, " ").slice(0, 120);
    if (this.routes.size < MAX_ROUTES_PER_FILE) this.routes.add(t);
  }
  bindRoute(route: string, handlerText: string): void {
    const handlers = [...new Set((handlerText.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((h) => !KEYWORDS.has(h) && h.length >= 3))].slice(0, 12);
    if (handlers.length > 0 && this.routeBindings.length < MAX_ROUTE_BINDINGS) this.routeBindings.push({ route: route.replace(/\s+/g, " ").slice(0, 120), handlers });
  }
  imp(spec: string): void {
    if (spec.length <= 200 && this.imports.size < 200) this.imports.add(spec);
  }
  /** Identifier names in each function-like body: from its declaration line to the closing brace (or the end of a one-expression arrow), bounded. */
  private bodyRefs(lines: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const d of this.decls) {
      const ids = new Set<string>();
      let depth = 0;
      let opened = false;
      for (let i = d.line; i < Math.min(lines.length, d.line + MAX_BODY_LINES); i++) {
        const raw = lines[i]!;
        if (raw.length > 400) continue;
        const line = raw.replace(/\/\/.*$/, "");
        for (const id of line.match(/[A-Za-z_$][\w$]{2,}/g) ?? []) if (id !== d.name && !KEYWORDS.has(id)) ids.add(id);
        for (const ch of line) {
          if (ch === "{") {
            depth++;
            opened = true;
          } else if (ch === "}") depth--;
        }
        if (opened && depth <= 0) break;
        if (!opened && i > d.line + 12) break; // an arrow/expression body that never opens a block
        if (!opened && /;\s*$/.test(line)) break;
      }
      out[d.name] = [...ids].slice(0, 200); // pruned to resolvable names once the whole repository is known
    }
    return out;
  }
  done(lines: string[]): Extraction {
    return { symbols: [...this.symbols], routes: [...this.routes], imports: [...this.imports], roles: [...this.roles], refs: this.bodyRefs(lines), routeBindings: this.routeBindings };
  }
}

const TS_DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_TYPE = /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/;
const TS_EXPORT_CONST = /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TS_TOP_CONST = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/;
const TS_EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/;
const TS_CJS_EXPORT = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/;
const TS_METHOD = /^\s{2,}(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^)]*\)?\s*(?::\s*[^={;]+)?\{\s*$/;
/** A method whose parameter list spans several lines: `  async name(` … `): Promise<X> {`. Confirmed by scanning to the closing paren (a call ends `);`, a declaration opens a block). */
const TS_METHOD_START = /^\s{2,}(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "with", "return", "await", "throw", "new", "super", "import", "require"]);
function multiLineMethodName(lines: string[], at: number): string | null {
  const m = TS_METHOD_START.exec(lines[at]!);
  if (!m || NOT_METHODS.has(m[1]!)) return null;
  let depth = 0;
  for (let k = at; k < Math.min(lines.length, at + 25); k++) {
    const line = lines[k]!;
    for (let i = k === at ? line.indexOf("(") : 0; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")" && --depth === 0) return /^\s*(?::\s*[^={;]+)?\{\s*$/.test(line.slice(i + 1)) ? m[1]! : null;
    }
  }
  return null;
}
const TS_ARROW_PROP = /^\s{2,}(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;
const TS_ROUTE_CHAIN = /\.route\(\s*['"`]([^'"`]+)['"`]\s*\)/;
const TS_ROUTE = /\b(?:[A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`](\/[^'"`]*)['"`]/i;
const TS_DECORATOR_ROUTE = /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/;
const TS_JSX_ROUTE = /(?:<Route\b[^>]*\bpath|\bpath)\s*[=:]\s*\{?\s*['"`]([^'"`]+)['"`]/;
const TS_IMPORT_FROM = /^\s*(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/;
const TS_IMPORT_BARE = /^\s*import\s*['"]([^'"]+)['"]/;
const TS_IMPORT_CLOSE = /^\s*\}\s*from\s*['"]([^'"]+)['"]/; // the `} from 'x'` line of a multi-line import
const TS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const tsExtractor = (): LanguageExtractor["extract"] => (text) => {
  const c = new Collector();
  const isJsx = /<\/?[A-Za-z][\w.]*[\s/>]/.test(text) && /\breturn\s*\(?\s*</.test(text);
  const allLines = text.split("\n");
  for (let li = 0; li < allLines.length; li++) {
    const line = allLines[li]!;
    if (line.length > 400) continue; // minified / generated line — not worth pattern-matching
    let m: RegExpExecArray | null;
    if ((m = TS_DECL.exec(line))) c.symbol(m[1], li, /\b(?:function)\b/.test(line));
    else if ((m = TS_TYPE.exec(line))) c.symbol(m[1]);
    else if ((m = TS_EXPORT_CONST.exec(line))) c.symbol(m[1], li, true);
    else if ((m = TS_TOP_CONST.exec(line))) c.symbol(m[1], li, true);
    else if ((m = TS_CJS_EXPORT.exec(line))) c.symbol(m[1], li, true);
    else if ((m = TS_METHOD.exec(line))) c.symbol(m[1], li, true);
    else if ((m = TS_ARROW_PROP.exec(line))) c.symbol(m[1], li, true);
    else if (/^\s{2,}\S/.test(line) && !/;\s*$/.test(line)) {
      const name = multiLineMethodName(allLines, li);
      if (name) c.symbol(name, li, true);
    }
    if ((m = TS_EXPORT_LIST.exec(line))) for (const part of m[1]!.split(",")) c.symbol(part.trim().split(/\s+as\s+/).pop()?.trim());

    if ((m = TS_ROUTE.exec(line))) {
      c.route(`${m[1]!.toUpperCase()} ${m[2]}`);
      // Handler names on the same call: this line after the path, plus following lines until the call's parentheses balance (bounded).
      let tail = line.slice((m.index ?? 0) + m[0].length);
      let open = 1 + (tail.match(/\(/g) ?? []).length - (tail.match(/\)/g) ?? []).length;
      for (let k = li + 1; open > 0 && k < Math.min(allLines.length, li + 7); k++) {
        tail += " " + allLines[k]!;
        open += (allLines[k]!.match(/\(/g) ?? []).length - (allLines[k]!.match(/\)/g) ?? []).length;
      }
      c.bindRoute(`${m[1]!.toUpperCase()} ${m[2]}`, tail.split(/\)\s*;/)[0]!);
    }
    else if ((m = TS_DECORATOR_ROUTE.exec(line))) c.route(`${m[1]!.toUpperCase()} ${m[2] ?? ""}`.trim());
    else if (isJsx && (m = TS_JSX_ROUTE.exec(line))) c.route(`ROUTE ${m[1]}`);
    // Express chains: Router.route("/path").get(a).patch(b, c).delete(d);  — one registration per method.
    if ((m = TS_ROUTE_CHAIN.exec(line))) {
      const path = m[1]!;
      let chain = line.slice((m.index ?? 0) + m[0].length);
      for (let k = li + 1; k < Math.min(allLines.length, li + 14) && !/;\s*$/.test(chain); k++) chain += " " + allLines[k]!;
      for (const call of chain.matchAll(/\.(get|post|put|patch|delete)\s*\(/gi)) {
        let depth = 1;
        let j = (call.index ?? 0) + call[0].length;
        const from = j;
        while (j < chain.length && depth > 0) {
          if (chain[j] === "(") depth++;
          else if (chain[j] === ")") depth--;
          j++;
        }
        const route = `${call[1]!.toUpperCase()} ${path}`;
        c.route(route);
        c.bindRoute(route, chain.slice(from, Math.max(from, j - 1)));
      }
    }

    if ((m = TS_IMPORT_FROM.exec(line) ?? TS_IMPORT_BARE.exec(line) ?? TS_IMPORT_CLOSE.exec(line))) c.imp(m[1]!);
    for (const re of [TS_REQUIRE, TS_DYNAMIC_IMPORT]) {
      re.lastIndex = 0;
      while ((m = re.exec(line))) c.imp(m[1]!);
    }
  }
  if (/\bexpress\.Router\s*\(|\bRouter\s*\(\s*\)/.test(text) || c.routes.size > 0) c.roles.add("route");
  if (/\bnew\s+(?:mongoose\.)?Schema\s*\(|\bmongoose\.model\s*\(|\bsequelize\.define\s*\(|@Entity\s*\(/.test(text)) c.roles.add("model");
  if (isJsx) c.roles.add("component");
  return c.done(allLines);
};

const DART_DECL = /^\s*(?:(?:abstract|sealed|base|final|interface|mixin)\s+)*(?:class|mixin|enum|typedef|extension(?:\s+type)?)\s+([A-Za-z_]\w*)/;
const DART_FUNC = /^\s{0,4}(?:static\s+)?(?:Future(?:<[^;{(=]*>)?|Stream(?:<[^;{(=]*>)?|void|bool|int|double|num|String|dynamic|[A-Z][\w<>?,.\s]*?)\s+([A-Za-z_]\w*)\s*\(/;
const DART_IMPORT = /^\s*(?:import|export)\s+['"]([^'"]+)['"]/;
const DART_ROUTE = /\bpath\s*:\s*['"]([^'"]+)['"]/;
const DART_WIDGET = /\bclass\s+([A-Za-z_]\w*)\s+extends\s+(?:Stateless|Stateful|Consumer|Hook)\w*Widget\b/;
const DART_STATE = /\bclass\s+([A-Za-z_]\w*)\s+(?:extends|with)\s+(?:ChangeNotifier|Bloc|Cubit|StateNotifier|Notifier|AsyncNotifier|GetxController)\b/;

const dartExtract: LanguageExtractor["extract"] = (text) => {
  const c = new Collector();
  const allLines = text.split("\n");
  for (let li = 0; li < allLines.length; li++) {
    const line = allLines[li]!;
    if (line.length > 400) continue;
    let m: RegExpExecArray | null;
    if ((m = DART_DECL.exec(line))) c.symbol(m[1]);
    else if ((m = DART_FUNC.exec(line))) c.symbol(m[1], li, true);
    if ((m = DART_IMPORT.exec(line))) c.imp(m[1]!);
    if ((m = DART_ROUTE.exec(line))) c.route(`ROUTE ${m[1]}`);
    if ((m = DART_WIDGET.exec(line))) c.roles.add(/(?:Screen|Page|View)$/.test(m[1]!) ? "screen" : "component");
    if (DART_STATE.test(line)) c.roles.add("provider");
  }
  return c.done(allLines);
};

const GENERATED = /(?:\.d\.ts|\.min\.js|\.g\.dart|\.freezed\.dart|\.config\.dart|\.gen\.dart|\.generated\.[a-z]+)$/i;

export const LANGUAGE_EXTRACTORS: LanguageExtractor[] = [
  { language: "typescript", extensions: ["ts", "tsx", "mts", "cts"], eligible: (p) => !GENERATED.test(p), extract: tsExtractor() },
  { language: "javascript", extensions: ["js", "jsx", "mjs", "cjs"], eligible: (p) => !GENERATED.test(p), extract: tsExtractor() },
  { language: "dart", extensions: ["dart"], eligible: (p) => !GENERATED.test(p), extract: dartExtract },
];

function extensionOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function extractorFor(path: string): LanguageExtractor | null {
  const ext = extensionOf(path);
  return LANGUAGE_EXTRACTORS.find((e) => e.extensions.includes(ext) && e.eligible(path)) ?? null;
}

/** Content extraction for one already-safely-read file. Exposed for tests; the builder is the only production caller. */
export function extractFile(path: string, text: string): Extraction | null {
  return extractorFor(path)?.extract(text) ?? null;
}

// ---------------------------------------------------------------------------
// Import resolution (needs the whole listing)
// ---------------------------------------------------------------------------

const TS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function normalizeJoin(dir: string, rel: string): string | null {
  const out = dir === "" ? [] : dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

class ImportResolver {
  private readonly paths: Set<string>;
  private readonly dartByLibSuffix = new Map<string, string[]>();

  constructor(paths: string[]) {
    this.paths = new Set(paths);
    for (const p of paths) {
      if (!p.endsWith(".dart")) continue;
      const i = p.startsWith("lib/") ? 0 : p.indexOf("/lib/");
      if (i === -1) continue;
      const key = p.slice(i === 0 ? 4 : i + 5);
      const list = this.dartByLibSuffix.get(key);
      if (list) list.push(p);
      else this.dartByLibSuffix.set(key, [p]);
    }
  }

  /** The repository path a specifier refers to, or `null` if it is external / ambiguous / not in the listing. */
  resolve(fromPath: string, spec: string): string | null {
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
    if (fromPath.endsWith(".dart")) {
      if (spec.startsWith("package:")) {
        const rest = spec.slice(spec.indexOf("/") + 1);
        const hits = this.dartByLibSuffix.get(rest);
        if (!hits) return null;
        if (hits.length === 1) return hits[0]!;
        const app = applicationOf(fromPath);
        const same = hits.filter((h) => applicationOf(h) === app);
        return same.length === 1 ? same[0]! : null;
      }
      if (spec.startsWith("dart:")) return null;
      const joined = normalizeJoin(dir, spec);
      return joined !== null && this.paths.has(joined) ? joined : null;
    }
    let base: string | null = null;
    if (spec.startsWith(".")) base = normalizeJoin(dir, spec);
    else if (spec.startsWith("@/") || spec.startsWith("~/")) {
      // Conventional "src root" alias, resolved inside the importing file's own application only.
      const app = applicationOf(fromPath);
      base = normalizeJoin(app === "(root)" ? "src" : `${app}/src`, spec.slice(2));
    }
    if (base === null) return null;
    for (const ext of TS_EXTENSIONS) if (this.paths.has(base + ext)) return base + ext;
    return null;
  }
}

function packageName(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("dart:")) return null;
  if (spec.startsWith("package:")) return spec.slice(8).split("/")[0] || null;
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? null;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** Priority for content reading when a limit binds: files most likely to define what backlog items are about come first. */
function contentPriority(roles: FileRole[]): number {
  if (roles.includes("test")) return 0;
  if (roles.some((r) => r === "route" || r === "controller" || r === "service" || r === "screen" || r === "provider" || r === "repository")) return 3;
  if (roles.some((r) => r === "model" || r === "component" || r === "hook" || r === "validator" || r === "middleware")) return 2;
  return 1;
}

/**
 * Builds the index for one open repository session (one revision). Content is read ONLY through a
 * `RepositoryInspector`, so every read is subject to the same secret-path / private-key / binary /
 * symlink / submodule / size rules as analysis reads — a secret file is never read, indexed, or listed.
 * Deterministic: the same repository revision always yields the same `files` and `coverage` (except
 * when the time/byte budget cuts it short, which `coverage.complete` then says).
 */
export async function buildRepositoryIndex(
  session: RepositorySession,
  sourceKey: string,
  signal: AbortSignal,
  limits: IndexBuildLimits = DEFAULT_INDEX_BUILD_LIMITS,
  clock: () => number = Date.now,
): Promise<RepositoryIndex> {
  if (!session.revision) throw new Error("cannot index a repository session with no revision");
  const inspector = new RepositoryInspector(
    session,
    { maxFiles: limits.maxContentFiles, maxFileBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes, deadlineMs: limits.deadlineMs },
    clock,
  );

  // 1. Structural pass — every listed, non-noise, non-secret path. Nothing is read.
  const structural = new Map<string, IndexedFile>();
  for (const path of session.structure.paths) {
    if (isNoisePath(path) || isSecretPath(path)) continue;
    const entry = session.entries.get(path);
    if (!entry || (entry.mode !== "100644" && entry.mode !== "100755")) continue; // never index symlinks/submodules
    structural.set(path, {
      path,
      language: extractorFor(path)?.language ?? "other",
      application: applicationOf(path),
      feature: featureOf(path),
      roles: rolesFromPath(path),
      contentIndexed: false,
      bytes: entry.size,
      symbols: [],
      routes: [],
      imports: [],
      packages: [],
    });
  }

  // 2. Content pass — bounded, prioritized, concurrent.
  const eligible = [...structural.values()]
    .filter((f) => f.language !== "other")
    .sort((a, b) => contentPriority(b.roles) - contentPriority(a.roles) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skipped: Record<string, number> = {};
  const skip = (reason: SkipReason | "not_attempted") => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const rawImports = new Map<string, string[]>();
  const rawFlow = new Map<string, { refs: Record<string, string[]>; bindings: Array<{ route: string; handlers: string[] }> }>();
  let stoppedEarly = false;

  for (let i = 0; i < eligible.length; i += limits.concurrency) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("index build aborted");
    if (stoppedEarly) {
      for (const f of eligible.slice(i)) if (!f.contentIndexed) skip("not_attempted");
      break;
    }
    const batch = eligible.slice(i, i + limits.concurrency);
    const outcomes = await Promise.all(batch.map((f) => inspector.read(f.path, signal)));
    outcomes.forEach((outcome, j) => {
      const file = batch[j]!;
      if (!outcome.ok) {
        skip(outcome.reason);
        if (outcome.reason === "file_limit" || outcome.reason === "byte_limit" || outcome.reason === "deadline") stoppedEarly = true;
        return;
      }
      const ex = extractFile(file.path, outcome.file.text);
      if (!ex) return;
      file.contentIndexed = true;
      file.bytes = outcome.file.bytes;
      file.symbols = ex.symbols;
      file.routes = ex.routes;
      file.roles = [...new Set([...file.roles, ...ex.roles])];
      rawImports.set(file.path, ex.imports);
      rawFlow.set(file.path, { refs: ex.refs, bindings: ex.routeBindings });
    });
  }

  // 3. Resolve imports to repository paths now that the whole listing is known.
  const resolver = new ImportResolver([...structural.keys()]);
  for (const [path, specs] of rawImports) {
    const file = structural.get(path)!;
    const resolved = new Set<string>();
    const packages = new Set<string>();
    for (const spec of specs) {
      const target = resolver.resolve(path, spec);
      if (target !== null && target !== path) {
        if (resolved.size < MAX_IMPORTS_PER_FILE) resolved.add(target);
      } else {
        const pkg = packageName(spec);
        if (pkg && packages.size < MAX_PACKAGES_PER_FILE) packages.add(pkg);
      }
    }
    file.imports = [...resolved].sort();
    file.packages = [...packages].sort();
  }

  // 3b. Flow structure: keep only the names a body (or a route call) mentions that RESOLVE — to a declaration in the same file or in
  //     a file it imports — so the stored graph is the small, meaningful part of "every identifier used".
  for (const [path, flow] of rawFlow) {
    const file = structural.get(path)!;
    const allowed = new Set<string>(file.symbols);
    for (const imp of file.imports) for (const sy of structural.get(imp)?.symbols ?? []) allowed.add(sy);
    const refs: Record<string, string[]> = {};
    for (const [sym, ids] of Object.entries(flow.refs)) {
      const kept = ids.filter((id) => allowed.has(id) && id !== sym).slice(0, MAX_REFS_PER_SYMBOL);
      if (kept.length > 0) refs[sym] = kept;
    }
    if (Object.keys(refs).length > 0) file.refs = refs;
    const bindings = flow.bindings.map((b) => ({ route: b.route, handlers: b.handlers.filter((h) => allowed.has(h)) })).filter((b) => b.handlers.length > 0);
    if (bindings.length > 0) file.routeBindings = bindings;
  }

  const files = [...structural.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const summary = inspector.summary(session.structure.truncated ? "truncated" : "complete");
  const indexed = files.filter((f) => f.contentIndexed).length;
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    revision: session.revision,
    sourceKey,
    generatedAt: new Date(clock()).toISOString(),
    totalFiles: session.structure.totalFiles,
    listingTruncated: session.structure.truncated,
    files,
    coverage: {
      eligibleFiles: eligible.length,
      contentIndexedFiles: indexed,
      bytesRead: summary.bytesRead,
      skipped,
      complete: !session.structure.truncated && indexed === eligible.length,
    },
  };
}

/**
 * Defence in depth for every consumer: an index may be used ONLY for the exact repository state it was
 * built from. Returns a reason string when it must NOT be used (stale revision, wrong source, old schema),
 * or `null` when it is current. The store already looks rows up by these same keys — this check exists so
 * a mislabelled row, a bad migration or a future caching bug cannot silently produce stale evidence.
 */
export function indexMismatch(index: RepositoryIndex, expected: { revision: string; sourceKey: string }): string | null {
  if (index.schemaVersion !== INDEX_SCHEMA_VERSION) return `index schema v${index.schemaVersion} is not the current v${INDEX_SCHEMA_VERSION}`;
  if (index.sourceKey !== expected.sourceKey) return "index was built for a different repository source";
  if (index.revision !== expected.revision) return `index is for revision ${index.revision.slice(0, 12)}, the repository is at ${expected.revision.slice(0, 12)}`;
  return null;
}

export function countSymbols(index: RepositoryIndex): number {
  return index.files.reduce((n, f) => n + f.symbols.length, 0);
}
