/**
 * Phase 4B.1 — human ground-truth adjudication for bulk backlog intelligence. Pure, deterministic types and the sampling
 * algorithm; no I/O, no model. AI output is never overwritten: a human judgment is a SEPARATE, append-only record bound to
 * the exact (analysis, revision) it was made against — see backlog-adjudication-repository.ts / backlog-adjudication-service.ts.
 */

export const RELATIONSHIP_JUDGMENT_LABELS = ["CONFIRMED_DUPLICATE", "RELATED_NOT_DUPLICATE", "REJECTED"] as const;
export type RelationshipJudgmentLabel = (typeof RELATIONSHIP_JUDGMENT_LABELS)[number];

export const CLARIFICATION_LABELS = ["CORRECT_CLARIFICATION", "SHOULD_BE_PROPOSAL_READY", "INSUFFICIENT_ANALYSIS", "OTHER"] as const;
export type ClarificationLabel = (typeof CLARIFICATION_LABELS)[number];

export const PROPOSAL_READINESS_LABELS = ["CORRECT_PROPOSAL_READY", "NEEDS_CLARIFICATION", "INSUFFICIENT_ANALYSIS", "OTHER"] as const;
export type ProposalReadinessLabel = (typeof PROPOSAL_READINESS_LABELS)[number];

export type ReviewJudgmentCategory = "CLARIFICATION" | "PROPOSAL_READINESS";
export type ReviewJudgmentLabel = ClarificationLabel | ProposalReadinessLabel;

export function labelsFor(category: ReviewJudgmentCategory): readonly string[] {
  return category === "CLARIFICATION" ? CLARIFICATION_LABELS : PROPOSAL_READINESS_LABELS;
}

/** cyrb53 string hash → a 32-bit seed. Deterministic across processes/platforms (no Math.random, no Date). */
function hashSeed(seed: string): number {
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)) % 4294967296;
}

/** mulberry32 — a small, fast, deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic, reproducible sample: the same (items, seed, size) always returns the same subset — a seeded
 * Fisher–Yates shuffle of the items sorted by `keyOf` first (so insertion/DB order never leaks in), then the first `size`.
 * Recording the seed alongside the result is what makes "a representative sample" reproducible rather than a one-off guess.
 */
export function deterministicSample<T>(items: T[], seed: string, size: number, keyOf: (item: T) => string): T[] {
  const sorted = [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const rand = mulberry32(hashSeed(seed));
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  return sorted.slice(0, Math.max(0, Math.min(size, sorted.length)));
}

// ---------------------------------------------------------------------------
// Phase 4B.2 — importing a human-filled adjudication template. Pure parsing/validation; no I/O, no server-side lookups
// (those happen in BacklogAdjudicationService, which is the only place a target is actually resolved — never trusting
// this file's `targetId`/`category` for anything but "which row to look up").
// ---------------------------------------------------------------------------

import { parseCsv } from "./import-csv.js";

export type ImportRowOutcome = "IMPORTED" | "BLANK" | "INVALID_LABEL" | "MALFORMED_ROW" | "UNKNOWN_KIND";

export interface ParsedAdjudicationRow {
  rowNumber: number;
  kind: "relationship" | "item" | null;
  targetId: string | null;
  category: ReviewJudgmentCategory | null;
  label: string | null;
  note: string | null;
  outcome: ImportRowOutcome;
  detail: string | null;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const COLUMNS = ["kind", "targetid", "category", "label", "note"];

/**
 * Parses a human-filled adjudication template (the exact shape `validate:adjudication --out-csv` and the CSV export
 * produce: `kind,targetId,category,context,aiConfidenceOrState,label,note` — `context`/`aiConfidenceOrState` are AI
 * reference columns and are READ ONLY for display, never trusted for anything). A BLANK label is not an error — it means
 * the human has not reviewed that row yet, and it creates no judgment. An unrecognised label is REJECTED, never guessed
 * or normalised into a nearby one.
 */
export function parseAdjudicationImport(text: string, maxBytes: number, maxRows: number): { rows: ParsedAdjudicationRow[]; errors: string[] } {
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { rows: [], errors: [`The file is larger than ${maxBytes} bytes.`] };
  const parsed = parseCsv(text);
  if (parsed.errors.length > 0) return { rows: [], errors: parsed.errors };
  if (parsed.rows.length > maxRows) return { rows: [], errors: [`More than ${maxRows} rows.`] };
  const idx = (name: string) => parsed.headers.findIndex((h) => norm(h) === name);
  const col = { kind: idx("kind"), targetId: idx("targetid"), category: idx("category"), label: idx("label"), note: idx("note") };
  const missing = COLUMNS.filter((c) => idx(c) < 0);
  if (missing.length > 0) return { rows: [], errors: [`Missing required column(s): ${missing.join(", ")}.`] };

  const rows: ParsedAdjudicationRow[] = parsed.rows.map((r) => {
    const cell = (i: number) => (i >= 0 ? (r.cells[i] ?? "").trim() : "");
    const kindRaw = cell(col.kind);
    const targetId = cell(col.targetId) || null;
    const categoryRaw = cell(col.category);
    const label = cell(col.label) || null;
    const note = cell(col.note) || null;
    const base = { rowNumber: r.rowNumber, targetId, note };

    if (kindRaw !== "relationship" && kindRaw !== "item") return { ...base, kind: null, category: null, label, outcome: "UNKNOWN_KIND" as const, detail: `"${kindRaw}" is not "relationship" or "item".` };
    if (!targetId) return { ...base, kind: kindRaw, category: null, label, outcome: "MALFORMED_ROW" as const, detail: "targetId is required." };
    const category: ReviewJudgmentCategory | null = categoryRaw === "CLARIFICATION" || categoryRaw === "PROPOSAL_READINESS" ? categoryRaw : null;
    if (kindRaw === "item" && !category) return { ...base, kind: kindRaw, category: null, label, outcome: "MALFORMED_ROW" as const, detail: `category must be CLARIFICATION or PROPOSAL_READINESS for an item row (got "${categoryRaw}").` };
    if (!label) return { ...base, kind: kindRaw, category, label: null, outcome: "BLANK" as const, detail: "No label — not yet reviewed." };
    const allowed: readonly string[] = kindRaw === "relationship" ? RELATIONSHIP_JUDGMENT_LABELS : labelsFor(category!);
    if (!allowed.includes(label)) return { ...base, kind: kindRaw, category, label, outcome: "INVALID_LABEL" as const, detail: `"${label}" is not a valid label for ${kindRaw === "relationship" ? "a relationship" : category}.` };
    return { ...base, kind: kindRaw, category, label, outcome: "IMPORTED" as const, detail: null };
  });
  return { rows, errors: [] };
}
