import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../domain/types.js";
import type { SourceControlProviderRegistry } from "../source-control/source-control-provider.js";
import { gitCredentialEnv } from "../source-control/git-credential-env.js";

const execFileAsync = promisify(execFile);

/**
 * The seam future repository indexing plugs into (see /docs/BACKLOG_INTELLIGENCE.md "Repository
 * awareness"): today a deterministic file listing, tomorrow possibly a maintained index — the
 * context builder only ever consumes `RepositoryStructure`, so swapping the provider needs no
 * change anywhere downstream. Deliberately NOT a vector store / RAG layer (out of scope for 4A).
 */
export interface RepositoryStructure {
  /** Repo-relative file paths (forward slashes), sorted. Possibly capped — see `truncated`. */
  paths: string[];
  /** The real number of files in the listing, before any cap. */
  totalFiles: number;
  /** True when `paths` is a capped prefix of the real listing (so "not in `paths`" is NOT proof a file is absent). */
  truncated: boolean;
}

/** One tree entry: git's own file mode (`100644`/`100755` regular, `120000` symlink, `160000` submodule) and blob size in bytes. */
export interface RepositoryEntry {
  path: string;
  mode: string;
  /** Blob size, or `null` when the source cannot say (then the inspector enforces the byte limit while reading). */
  size: number | null;
}

/**
 * A short-lived, read-only view of ONE repository revision, opened for the duration of one analysis
 * attempt: the file listing plus the ability to read individual file contents on request. Contents are
 * addressed ONLY by an exact path from the listing and read from the repository's object store — nothing
 * is ever checked out to a working directory, so there is no filesystem path to traverse and no symlink
 * to follow (a symlink is just an entry of mode 120000 that the inspector refuses to read). Callers go
 * through `RepositoryInspector`, which adds the size/count/byte/time limits and the secret rules.
 */
export interface RepositorySession {
  /** The exact commit SHA this session views (`null` only for a source that cannot say — such a session can never be indexed, since an index must bind to a revision). */
  readonly revision: string | null;
  readonly structure: RepositoryStructure;
  readonly entries: ReadonlyMap<string, RepositoryEntry>;
  /** Reads one blob by exact listed path. Rejects if it cannot be read or exceeds `maxBytes`. */
  readBlob(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
  /** Releases everything (temp directory). Always called, even after a failure. */
  dispose(): Promise<void>;
}

export interface RepositoryStructureProvider {
  /** Throws if the repository cannot be opened — the executor degrades to "unavailable" rather than failing the analysis. */
  open(project: Project, signal: AbortSignal): Promise<RepositorySession>;
}

// ---------------------------------------------------------------------------
// Deterministic, bounded selection
// ---------------------------------------------------------------------------

export interface StructureLimits {
  /** Max lines in the directory outline. */
  maxOutlineLines: number;
  /** Max individual file paths handed to the model. */
  maxRelevantPaths: number;
}

export const DEFAULT_STRUCTURE_LIMITS: StructureLimits = { maxOutlineLines: 60, maxRelevantPaths: 60 };

const NOISE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "vendor", "target", ".gradle", "pods", "__pycache__",
  ".venv", "venv", "coverage", ".idea", ".vscode", "bower_components", ".dart_tool", ".pub-cache", "deriveddata",
]);
const NOISE_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "gemfile.lock", "pubspec.lock", ".ds_store"]);
const NOISE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "mp4", "mov", "mp3", "wav", "woff", "woff2", "ttf", "eot", "otf",
  "pdf", "zip", "gz", "tar", "jar", "apk", "aab", "ipa", "map", "class", "so", "dylib", "exe", "dll",
]);
const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "when", "then", "not", "are", "was", "but", "have", "has", "can", "does", "doesn", "should", "shows", "show", "user", "users", "into", "after", "before", "still"]);

export function isNoisePath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  if (segments.slice(0, -1).some((s) => NOISE_DIRS.has(s))) return true;
  const file = segments[segments.length - 1] ?? "";
  if (NOISE_FILES.has(file)) return true;
  if (!file.includes(".")) return false;
  const ext = file.slice(file.lastIndexOf(".") + 1);
  return NOISE_EXTENSIONS.has(ext) || file.endsWith(".min.js");
}

/** Lowercase alphanumeric tokens (length >= 3), camelCase split, stopwords removed, unique, in first-seen order. */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export interface SelectedStructure {
  /** "dir/ (N files)" lines, largest first (ties alphabetical), bounded by `maxOutlineLines`. */
  outline: string[];
  /** Paths whose names best match the backlog item's own words, best first (ties alphabetical). */
  relevantPaths: string[];
  totalFiles: number;
  /** Files remaining after noise filtering. */
  consideredFiles: number;
  truncated: boolean;
}

/**
 * Pure and deterministic: the same (structure, query, limits) always yields the same selection —
 * no clock, no randomness, no I/O. This is what keeps "repository-aware" analysis bounded: the model
 * sees a directory outline plus the top-N name-matching paths, never the repository.
 */
export function selectRelevantStructure(structure: RepositoryStructure, queryText: string, limits: StructureLimits = DEFAULT_STRUCTURE_LIMITS): SelectedStructure {
  const considered = structure.paths.filter((p) => !isNoisePath(p));

  // Outline: top-level and second-level directories with file counts.
  const counts = new Map<string, number>();
  let rootFiles = 0;
  for (const path of considered) {
    const segments = path.split("/");
    if (segments.length === 1) {
      rootFiles++;
      continue;
    }
    counts.set(`${segments[0]}/`, (counts.get(`${segments[0]}/`) ?? 0) + 1);
    if (segments.length > 2) {
      const key = `${segments[0]}/${segments[1]}/`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const outlineEntries = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const outline = outlineEntries.slice(0, limits.maxOutlineLines).map(([dir, n]) => `${dir} (${n} file${n === 1 ? "" : "s"})`);
  if (rootFiles > 0 && outline.length < limits.maxOutlineLines) outline.push(`(repository root) (${rootFiles} file${rootFiles === 1 ? "" : "s"})`);

  // Relevance: filename hits outweigh directory hits.
  const tokens = tokenize(queryText);
  const scored: Array<{ path: string; score: number }> = [];
  if (tokens.length > 0) {
    for (const path of considered) {
      const lower = path.toLowerCase();
      const segments = lower.split("/");
      const file = segments[segments.length - 1] ?? "";
      let score = 0;
      for (const token of tokens) {
        if (file.includes(token)) score += 3;
        else if (segments.slice(0, -1).some((s) => s.includes(token))) score += 1;
      }
      if (score > 0) scored.push({ path, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    outline,
    relevantPaths: scored.slice(0, limits.maxRelevantPaths).map((s) => s.path),
    totalFiles: structure.totalFiles,
    consideredFiles: considered.length,
    truncated: structure.truncated,
  };
}

// ---------------------------------------------------------------------------
// Real provider: a tree-only shallow clone
// ---------------------------------------------------------------------------

export interface GitStructureProviderOptions {
  timeoutMs?: number;
  /** Hard cap on how many listed paths are kept, so a monorepo cannot balloon memory. */
  maxPaths?: number;
}

/**
 * Opens a repository revision without ever checking out (or even downloading) file contents up front: a
 * blobless, depth-1, `--no-checkout` clone into a throwaway temp directory, then `git ls-tree -r --long`
 * for the listing (with sizes). File contents are fetched lazily, one blob at a time, by
 * `git cat-file blob HEAD:<exact listed path>` — only when the inspector asks. Reuses the project's own
 * `SourceControlProvider.resolveCloneCredential` and the env-only credential mechanism
 * (`gitCredentialEnv`) — the credential never appears on a command line, in `.git/config`, or anywhere a
 * model can read. The temp directory is always removed by `dispose()`.
 */
export class GitRepositoryStructureProvider implements RepositoryStructureProvider {
  private readonly timeoutMs: number;
  private readonly maxPaths: number;

  constructor(
    private readonly sourceControlProviders: SourceControlProviderRegistry,
    options: GitStructureProviderOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxPaths = options.maxPaths ?? 50_000;
  }

  async open(project: Project, signal: AbortSignal): Promise<RepositorySession> {
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
    const credential = await scProvider.resolveCloneCredential(project, signal);
    const dir = await mkdtemp(join(tmpdir(), "codeforge-structure-"));
    const env = { ...process.env, ...gitCredentialEnv(credential), GIT_TERMINAL_PROMPT: "0" };
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", project.defaultBranch, "--", project.repoUrl, dir],
        { signal, env, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );
      // NOTE: deliberately NOT `--long`. In a blobless partial clone the object sizes are not local, so
      // `ls-tree --long` makes git lazily fetch EVERY blob (one round trip each — ~1,000 for a mid-size
      // repository) and hit the timeout. Names and modes come from the tree alone; sizes are enforced
      // while reading (RepositoryInspector) instead. Found by the Phase 4A.2 real-provider run: local test
      // repositories are not partial clones, so no automated test could have shown it.
      const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "-z", "HEAD"], {
        cwd: dir,
        signal,
        env,
        timeout: this.timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
      });
      const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, signal, env, timeout: 15_000 });
      const revision = /^[0-9a-f]{40,64}$/.test(head.trim()) ? head.trim() : null;
      const all = parseLsTree(stdout).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const kept = all.slice(0, this.maxPaths);
      const entries = new Map(kept.map((e) => [e.path, e]));
      const timeoutMs = this.timeoutMs;
      return {
        revision,
        structure: { paths: kept.map((e) => e.path), totalFiles: all.length, truncated: all.length > this.maxPaths },
        entries,
        readBlob: async (path, maxBytes, sig) => {
          // Defense in depth: only an exact path from the listing ever reaches git, as `HEAD:<path>` (never an option).
          if (!entries.has(path)) throw new Error("path is not in the repository listing");
          try {
            const { stdout: buf } = await execFileAsync("git", ["cat-file", "blob", `HEAD:${path}`], {
              cwd: dir,
              signal: sig,
              env,
              timeout: Math.min(timeoutMs, 20_000),
              maxBuffer: maxBytes + 1024,
              encoding: "buffer",
            });
            return buf as Buffer;
          } catch (err) {
            // execFile kills the child once the output exceeds maxBuffer, so a huge blob is never fully read.
            if ((err as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new BlobTooLargeError();
            throw err;
          }
        },
        dispose: async () => {
          await rm(dir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }
}

/** Thrown by `readBlob` when a blob exceeds the byte limit while being read (its size was not known from the listing). */
export class BlobTooLargeError extends Error {
  constructor() {
    super("blob exceeds the read limit");
    this.name = "BlobTooLargeError";
  }
}

/**
 * Parses `git ls-tree -r -z` (`<mode> <type> <sha>\t<path>\0`); also accepts the `--long` form
 * (`<mode> <type> <sha> <size>\t<path>\0`) when a caller has sizes. Without a size the entry's `size` is
 * `null` and the inspector enforces the byte limit on the bytes actually read.
 */
export function parseLsTree(stdout: string): RepositoryEntry[] {
  const out: RepositoryEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (meta.length < 3 || !path) continue;
    const size = meta[3] === undefined || meta[3] === "-" ? null : Number(meta[3]);
    out.push({ path, mode: meta[0]!, size: size !== null && Number.isFinite(size) ? size : null });
  }
  return out;
}
