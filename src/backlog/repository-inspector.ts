import type { InspectionSummary } from "./backlog-types.js";
import { BlobTooLargeError, type RepositorySession } from "./repository-structure.js";

/**
 * Bounded, safe content inspection for backlog analysis (Phase 4A.2 — see /docs/BACKLOG_INTELLIGENCE.md
 * "Evidence"). This is the ONLY way analysis reads repository file content, and the platform — never the
 * model — decides what is read. It adds a policy layer on top of `RepositorySession` (which already makes
 * traversal/symlink escape structurally impossible by addressing blobs by exact listed path in the object
 * store, with no checkout): hard limits, secret rejection, binary rejection, and a deadline. There is no
 * shell, no network access beyond the session's own read-only git fetch of a single blob, and no way for a
 * model-supplied string to become anything but a lookup key into the listing.
 */
export interface InspectionLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Wall-clock budget for the whole inspection of one analysis attempt. */
  deadlineMs: number;
}

export const DEFAULT_INSPECTION_LIMITS: InspectionLimits = {
  // 4A.5: room for the excerpt set (8) + claim evidence + the platform's own premise investigation, each drawing on the same pool.
  maxFiles: 24,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 384 * 1024,
  deadlineMs: 30_000,
};

export type SkipReason =
  | "invalid_path"
  | "not_in_listing"
  | "secret_path"
  | "symlink"
  | "submodule"
  | "too_large"
  | "binary"
  | "contains_private_key"
  | "file_limit"
  | "byte_limit"
  | "deadline"
  | "unreadable";

export interface InspectedFile {
  path: string;
  /** Decoded UTF-8 content (already verified non-binary and free of private-key material). */
  text: string;
  bytes: number;
}

export type ReadOutcome = { ok: true; file: InspectedFile } | { ok: false; reason: SkipReason };

// ---------------------------------------------------------------------------
// Secret-bearing paths and content
// ---------------------------------------------------------------------------

const SECRET_BASENAME = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production …
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^\.?(npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^service[-_]?account.*\.json$/i,
  /\.(secret|secrets)$/i,
  /^google-services\.json$/i,
  /^kubeconfig$/i,
];
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", "secrets", ".secrets"]);

/** True for paths that conventionally hold credentials/keys. Such files are never read, never excerpted, never sent to a model. */
export function isSecretPath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => SECRET_DIRS.has(s.toLowerCase()))) return true;
  return SECRET_BASENAME.some((re) => re.test(base));
}

const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

const SECRET_ASSIGNMENT = /((?:api[_-]?key|secret|token|passw(?:or)?d|passwd|authorization|bearer|private[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{8,})/gi;
const SECRET_LITERALS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /sk-[A-Za-z0-9_-]{20,}/g, // generic "sk-" provider keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

/** Masks likely credentials in a line of text before it is stored or shown to a model. Best-effort by design — the filename/private-key rules are the primary protection. */
export function maskSecrets(text: string): string {
  let out = text.replace(SECRET_ASSIGNMENT, (_m, prefix: string) => `${prefix}[REDACTED]`);
  for (const re of SECRET_LITERALS) out = out.replace(re, "[REDACTED]");
  return out;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** Normalizes a model- or platform-supplied path to a listing key, or `null` if it could not possibly be one. Pure; never touches a filesystem. */
export function normalizeRepoPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) return null;
  if (raw.includes("\0") || raw.includes("\\")) return null;
  let p = raw.trim();
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return null;
  const segments = p.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return null;
  return p;
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

/**
 * Reads files from a `RepositorySession` under a shared budget. One instance per analysis attempt: the
 * budget (files, bytes, deadline) is for the attempt as a whole, so pre-model excerpt selection and
 * post-model evidence gathering draw from the same pool. Reads are cached, so re-reading a file costs
 * nothing and cannot exhaust the budget.
 */
export class RepositoryInspector {
  private readonly cache = new Map<string, ReadOutcome>();
  private filesRead = 0;
  private bytesRead = 0;
  private readonly skipped = new Map<string, SkipReason>();
  private readonly deadlineAt: number;

  constructor(
    private readonly session: RepositorySession,
    readonly limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
    private readonly clock: () => number = Date.now,
  ) {
    this.deadlineAt = clock() + limits.deadlineMs;
  }

  /** True if `path` (already normalized) could be read at all, judged from the listing alone — used to choose what to try. */
  isReadableCandidate(path: string): boolean {
    const entry = this.session.entries.get(path);
    if (!entry || isSecretPath(path)) return false;
    if (entry.mode !== "100644" && entry.mode !== "100755") return false;
    return entry.size === null || entry.size <= this.limits.maxFileBytes;
  }

  async read(rawPath: string, signal: AbortSignal): Promise<ReadOutcome> {
    const path = normalizeRepoPath(rawPath);
    if (path === null) return this.skip(rawPath.slice(0, 200), "invalid_path");
    const cached = this.cache.get(path);
    if (cached) return cached;

    const entry = this.session.entries.get(path);
    if (!entry) return this.remember(path, this.skip(path, "not_in_listing"));
    if (isSecretPath(path)) return this.remember(path, this.skip(path, "secret_path"));
    if (entry.mode === "120000") return this.remember(path, this.skip(path, "symlink"));
    if (entry.mode === "160000") return this.remember(path, this.skip(path, "submodule"));
    if (entry.size !== null && entry.size > this.limits.maxFileBytes) return this.remember(path, this.skip(path, "too_large"));
    // Budget checks are deliberately NOT cached: a later read with budget left (it can't be — budgets only shrink) would be identical, but a `deadline`/limit skip must not poison a path forever within this attempt if limits were ever extended.
    if (this.filesRead >= this.limits.maxFiles) return this.skip(path, "file_limit");
    if (this.clock() > this.deadlineAt) return this.skip(path, "deadline");
    if (entry.size !== null && this.bytesRead + entry.size > this.limits.maxTotalBytes) return this.skip(path, "byte_limit");

    let buf: Buffer;
    try {
      buf = await this.session.readBlob(path, this.limits.maxFileBytes, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return this.remember(path, this.skip(path, err instanceof BlobTooLargeError ? "too_large" : "unreadable"));
    }
    if (buf.length > this.limits.maxFileBytes) return this.remember(path, this.skip(path, "too_large"));
    if (this.bytesRead + buf.length > this.limits.maxTotalBytes) return this.skip(path, "byte_limit");
    if (buf.subarray(0, 8000).includes(0)) return this.remember(path, this.skip(path, "binary"));
    const text = buf.toString("utf8");
    if (PRIVATE_KEY_MARKER.test(text)) return this.remember(path, this.skip(path, "contains_private_key"));

    this.filesRead++;
    this.bytesRead += buf.length;
    return this.remember(path, { ok: true, file: { path, text, bytes: buf.length } });
  }

  summary(listing: InspectionSummary["listing"]): InspectionSummary {
    return {
      listing,
      filesRead: this.filesRead,
      bytesRead: this.bytesRead,
      filesSkipped: [...this.skipped.entries()].slice(0, 30).map(([path, reason]) => ({ path, reason })),
      limits: { maxFiles: this.limits.maxFiles, maxFileBytes: this.limits.maxFileBytes, maxTotalBytes: this.limits.maxTotalBytes },
    };
  }

  private skip(path: string, reason: SkipReason): ReadOutcome {
    if (!this.skipped.has(path)) this.skipped.set(path, reason);
    return { ok: false, reason };
  }

  private remember(path: string, outcome: ReadOutcome): ReadOutcome {
    this.cache.set(path, outcome);
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Text helpers (pure)
// ---------------------------------------------------------------------------

/** Lines shown before / after each hit in an excerpt window (a declaration's body follows it, so more after than before). */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 7;
const MAX_WINDOWS = 5;

/**
 * A bounded, secret-masked, line-numbered excerpt built from SEVERAL windows around the lines that best
 * match the terms (most distinct terms first, ties by position), else the head of the file. Phase 4A.3:
 * the earlier version showed only the region after the FIRST hit, so in a long file the model saw a helper's
 * definition at the top but never its call site 100 lines down — and drew a wrong conclusion from the gap
 * (found in a real Jinvani run). Same `maxChars` budget as before; windows are separated by a `…` line so a
 * gap is visible, never silent. Pure and deterministic.
 */
export function excerptFor(text: string, terms: string[], maxChars: number): { text: string; truncated: boolean } {
  if (text.length === 0) return { text: "", truncated: false };
  const lines = text.split("\n");
  const lower = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  const scores = lower.length === 0 ? [] : lines.map((l) => {
    const hay = l.toLowerCase();
    return lower.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
  });
  const hits = scores.map((score, i) => ({ score, i })).filter((h) => h.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);

  // Choose window starts greedily by score, never overlapping an already chosen window.
  const chosen: Array<{ from: number; to: number }> = [];
  for (const h of hits) {
    if (chosen.length >= MAX_WINDOWS) break;
    const from = Math.max(0, h.i - WINDOW_BEFORE);
    const to = Math.min(lines.length - 1, h.i + WINDOW_AFTER);
    if (chosen.some((w) => from <= w.to && to >= w.from)) continue;
    chosen.push({ from, to });
  }
  if (chosen.length === 0) chosen.push({ from: 0, to: lines.length - 1 });
  chosen.sort((a, b) => a.from - b.from);

  const out: string[] = [];
  let used = 0;
  let truncated = chosen[0]!.from > 0;
  for (let w = 0; w < chosen.length; w++) {
    if (w > 0) {
      // Only mark a gap that actually exists between two windows.
      if (used + 2 > maxChars) return { text: out.join("\n"), truncated: true };
      out.push("…");
      used += 2;
      truncated = true;
    }
    for (let i = chosen[w]!.from; i <= chosen[w]!.to; i++) {
      const line = `${i + 1}: ${maskSecrets(lines[i]!).slice(0, 200)}`;
      if (used + line.length + 1 > maxChars) return { text: out.join("\n"), truncated: true };
      out.push(line);
      used += line.length + 1;
    }
  }
  if (chosen[chosen.length - 1]!.to < lines.length - 1) truncated = true;
  return { text: out.join("\n"), truncated };
}

/** Lines of `text` containing at least `minTerms` distinct search terms (case-insensitive), as 1-based line numbers with masked, bounded excerpts. */
export function findContentMatches(text: string, terms: string[], minTerms: number, maxMatches: number): Array<{ line: number; excerpt: string; matched: string[] }> {
  const lower = terms.map((t) => t.toLowerCase());
  const out: Array<{ line: number; excerpt: string; matched: string[] }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < maxMatches; i++) {
    const l = lines[i]!.toLowerCase();
    const matched = lower.filter((t) => l.includes(t));
    if (matched.length >= minTerms) out.push({ line: i + 1, excerpt: maskSecrets(lines[i]!.trim()).slice(0, 160), matched });
  }
  return out;
}
