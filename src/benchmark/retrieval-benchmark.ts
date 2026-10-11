import { createHash } from "node:crypto";
/**
 * Deterministic retrieval / file-selection benchmark (Phase 4A.4, GAP-032).
 *
 * MEASUREMENT, not tuning. It replays backlog items against a repository at a fixed revision and scores WHAT
 * CODEFORGE SHOWS THE MODEL (the ranked candidate list and the excerpted files) against HUMAN-MAINTAINED GROUND
 * TRUTH. No model is called and none scores anything: same inputs ⇒ same numbers.
 *
 * TWO KINDS OF DATA, kept apart by type and by name:
 *   GROUND TRUTH  (`GroundTruthItem.expectedFiles`) — written by people (or taken from independent git history:
 *                 the files a real, merged fix modified). It is never derived from CodeForge's own selection.
 *   SYSTEM OUTPUT (`SelectionOutput`) — what a `SelectionSubject` returned. Scored, never trusted as expectation.
 *
 * Metric definitions (all per item, then aggregated; an item with no expected files is rejected as invalid):
 *   candidateRecall / excerptRecall   fraction of an item's expected files that appear in the candidate list / excerpt set
 *   ranks                             1-based rank of each expected file in the candidate list (null = absent)
 *   recallAtN                         fraction of expected files within the first N candidates
 *   itemHit@excerpts                  1 if AT LEAST ONE expected file was excerpted (the model saw the right place)
 *   notInGroundTruthRate              fraction of candidates (excerpts) that are not expected files. This is an UPPER
 *                                     BOUND on "irrelevant": a file can be genuinely relevant without being one a fix
 *                                     modified, so the label is deliberately not "precision".
 * Aggregates are the macro-average over items (each item counts once) plus micro totals for recall.
 */

/**
 * Where an item's description came from — it matters, because a description written AFTER the fix (a commit message)
 * can name the very files the fix touched, which makes retrieval look easier than for a real QA symptom.
 */
export type DescriptionSource = "qa_symptom" | "task_goal" | "commit_message";

/**
 * A human adjudication of RELEVANCE: files a person judged worth reading when investigating the item, which is a
 * different (and usually larger) set than the files the historical fix happened to change.
 */
export interface Adjudication {
  /** Every file judged relevant (normally a superset of the relevant fix-touched files). Must exist at `revision`. */
  relevantFiles: string[];
  adjudicatedBy: string;
  /** How relevance was decided — reported verbatim, including any limits of the method. */
  method: string;
}

export interface GroundTruthItem {
  id: string;
  title: string;
  /** The description handed to the analysis — symptom/requirement text (see `descriptionSource`). */
  description: string;
  descriptionSource?: DescriptionSource;
  /** The exact repository revision to replay the item against (the state the item was raised on). */
  revision: string;
  /** The revision right AFTER the historical fix merged — lets the investigation benchmark ask "does the platform notice the fix once it exists?". Optional. */
  postFixRevision?: string | null;
  /**
   * GROUND TRUTH (objective lower bound): repository files the historical fix MODIFIED, taken from git history.
   * NOT necessarily the complete set of relevant files — see `adjudicated`.
   */
  fixTouchedFiles: string[];
  /** GROUND TRUTH (judged relevance) — present only for the manually adjudicated subset. */
  adjudicated?: Adjudication;
  expectedSymbols?: string[];
  expectedApplication?: string;
  /** Free labels for sub-reporting; derived by `deriveTags` when absent. */
  tags?: string[];
}

/** Which ground-truth set a view scores against. */
export type Basis = "fixTouched" | "relevant";

export function expectedFor(item: GroundTruthItem, basis: Basis): string[] | null {
  return basis === "fixTouched" ? item.fixTouchedFiles : (item.adjudicated?.relevantFiles ?? null);
}

export interface GroundTruthSet {
  name: string;
  /** Where the expectations came from and what they do NOT claim. Reported verbatim. */
  provenance: string;
  items: GroundTruthItem[];
}

/** SYSTEM OUTPUT for one item. */
export interface SelectionOutput {
  /** The ranked candidate paths shown to the model, best first. */
  candidates: string[];
  /** The files whose content was excerpted into the prompt. */
  excerpts: string[];
  method: "index" | "name";
}

export interface SelectionSubject {
  name: string;
  select(item: GroundTruthItem): Promise<SelectionOutput>;
}

export interface ItemResult {
  id: string;
  title: string;
  tags: string[];
  // --- copied from ground truth (labelled) ---
  groundTruth: { basis: Basis; expectedFiles: string[] };
  // --- system output ---
  systemOutput: { candidateCount: number; excerptCount: number; method: "index" | "name" };
  // --- scores ---
  ranks: Array<{ file: string; rank: number | null; inExcerpts: boolean }>;
  candidateRecall: number;
  excerptRecall: number;
  itemHitInExcerpts: boolean;
  itemHitInCandidates: boolean;
  candidatesNotInGroundTruth: number;
  excerptsNotInGroundTruth: number;
  notInGroundTruthRateCandidates: number;
  notInGroundTruthRateExcerpts: number;
}

export interface Aggregate {
  items: number;
  /** Items for which NONE of the expected files was among the candidates / among the excerpts (the model saw nothing from the truth). */
  itemsZeroCandidateHits: number;
  itemsZeroExcerptHits: number;
  expectedFilesTotal: number;
  candidateRecallMacro: number;
  candidateRecallMicro: number;
  excerptRecallMacro: number;
  excerptRecallMicro: number;
  recallAtN: Record<string, number>;
  itemHitRateCandidates: number;
  itemHitRateExcerpts: number;
  /** Mean / median rank over the expected files that WERE found in the candidates (absent files are not ranked). */
  meanRankFound: number | null;
  medianRankFound: number | null;
  expectedFilesFound: number;
  notInGroundTruthRateCandidates: number;
  notInGroundTruthRateExcerpts: number;
  meanCandidateCount: number;
  meanExcerptCount: number;
}

/** All scores for ONE ground-truth basis. */
export interface ViewReport {
  basis: Basis;
  perItem: ItemResult[];
  aggregate: Aggregate;
  /** Aggregates for tagged subsets (e.g. items whose symptom text names no file). Never blended into the headline number. */
  byTag: Record<string, Aggregate>;
}

export interface BenchmarkReport {
  groundTruth: { name: string; provenance: string; sampleSize: number; adjudicatedSampleSize: number };
  subject: string;
  topN: number[];
  /** Against the files the historical fix touched (every item). */
  fixTouched: ViewReport;
  /** Against manually adjudicated relevance (only the adjudicated subset); `null` if there is none. */
  adjudicated: ViewReport | null;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function validateGroundTruth(set: GroundTruthSet): void {
  const ids = new Set<string>();
  for (const item of set.items) {
    if (ids.has(item.id)) throw new Error(`duplicate ground-truth item id ${item.id}`);
    ids.add(item.id);
    if (!item.fixTouchedFiles?.length) throw new Error(`ground-truth item ${item.id} has no fix-touched files`);
    if (new Set(item.fixTouchedFiles).size !== item.fixTouchedFiles.length) throw new Error(`ground-truth item ${item.id} lists a file twice`);
    if (item.adjudicated) {
      if (!item.adjudicated.relevantFiles.length) throw new Error(`ground-truth item ${item.id} has an adjudication with no relevant files`);
      if (new Set(item.adjudicated.relevantFiles).size !== item.adjudicated.relevantFiles.length) throw new Error(`ground-truth item ${item.id} adjudication lists a file twice`);
      if (!item.adjudicated.adjudicatedBy.trim() || !item.adjudicated.method.trim()) throw new Error(`ground-truth item ${item.id} adjudication must say who judged it and how`);
    }
    if (!/^[0-9a-f]{7,64}$/.test(item.revision)) throw new Error(`ground-truth item ${item.id} has no valid revision`);
    if (!item.description.trim()) throw new Error(`ground-truth item ${item.id} has no description`);
  }
  if (set.items.length === 0) throw new Error("ground-truth set has no items");
}

export function scoreItem(item: GroundTruthItem, out: SelectionOutput, basis: Basis = "fixTouched"): ItemResult {
  const expectedFiles = expectedFor(item, basis);
  if (!expectedFiles) throw new Error(`item ${item.id} has no ${basis} ground truth`);
  const expected = new Set(expectedFiles);
  const rankOf = new Map(out.candidates.map((p, i) => [p, i + 1]));
  const excerpted = new Set(out.excerpts);
  const ranks = expectedFiles.map((file) => ({ file, rank: rankOf.get(file) ?? null, inExcerpts: excerpted.has(file) }));
  const found = ranks.filter((r) => r.rank !== null).length;
  const excerptHits = ranks.filter((r) => r.inExcerpts).length;
  const candNot = out.candidates.filter((p) => !expected.has(p)).length;
  const excNot = out.excerpts.filter((p) => !expected.has(p)).length;
  return {
    id: item.id,
    title: item.title,
    tags: item.tags ?? [],
    groundTruth: { basis, expectedFiles },
    systemOutput: { candidateCount: out.candidates.length, excerptCount: out.excerpts.length, method: out.method },
    ranks,
    candidateRecall: round(found / expectedFiles.length),
    excerptRecall: round(excerptHits / expectedFiles.length),
    itemHitInCandidates: found > 0,
    itemHitInExcerpts: excerptHits > 0,
    candidatesNotInGroundTruth: candNot,
    excerptsNotInGroundTruth: excNot,
    notInGroundTruthRateCandidates: out.candidates.length ? round(candNot / out.candidates.length) : 0,
    notInGroundTruthRateExcerpts: out.excerpts.length ? round(excNot / out.excerpts.length) : 0,
  };
}

export function aggregate(results: ItemResult[], topN: number[]): Aggregate {
  const expectedTotal = results.reduce((n, r) => n + r.ranks.length, 0);
  const foundRanks = results.flatMap((r) => r.ranks.filter((x) => x.rank !== null).map((x) => x.rank!));
  const excerptFound = results.reduce((n, r) => n + r.ranks.filter((x) => x.inExcerpts).length, 0);
  const recallAtN: Record<string, number> = {};
  for (const n of topN) recallAtN[`@${n}`] = round(mean(results.map((r) => r.ranks.filter((x) => x.rank !== null && x.rank <= n).length / r.ranks.length)));
  return {
    items: results.length,
    itemsZeroCandidateHits: results.filter((r) => !r.itemHitInCandidates).length,
    itemsZeroExcerptHits: results.filter((r) => !r.itemHitInExcerpts).length,
    expectedFilesTotal: expectedTotal,
    candidateRecallMacro: round(mean(results.map((r) => r.candidateRecall))),
    candidateRecallMicro: expectedTotal ? round(foundRanks.length / expectedTotal) : 0,
    excerptRecallMacro: round(mean(results.map((r) => r.excerptRecall))),
    excerptRecallMicro: expectedTotal ? round(excerptFound / expectedTotal) : 0,
    recallAtN,
    itemHitRateCandidates: round(mean(results.map((r) => (r.itemHitInCandidates ? 1 : 0)))),
    itemHitRateExcerpts: round(mean(results.map((r) => (r.itemHitInExcerpts ? 1 : 0)))),
    meanRankFound: foundRanks.length ? round(mean(foundRanks), 2) : null,
    medianRankFound: median(foundRanks),
    expectedFilesFound: foundRanks.length,
    notInGroundTruthRateCandidates: round(mean(results.map((r) => r.notInGroundTruthRateCandidates))),
    notInGroundTruthRateExcerpts: round(mean(results.map((r) => r.notInGroundTruthRateExcerpts))),
    meanCandidateCount: round(mean(results.map((r) => r.systemOutput.candidateCount)), 1),
    meanExcerptCount: round(mean(results.map((r) => r.systemOutput.excerptCount)), 1),
  };
}

function view(items: GroundTruthItem[], outputs: Map<string, SelectionOutput>, basis: Basis, topN: number[]): ViewReport | null {
  const scoped = items.filter((i) => expectedFor(i, basis) !== null);
  if (scoped.length === 0) return null;
  const perItem = scoped.map((i) => scoreItem(i, outputs.get(i.id)!, basis));
  const tags = [...new Set(perItem.flatMap((r) => r.tags))].sort();
  return { basis, perItem, aggregate: aggregate(perItem, topN), byTag: Object.fromEntries(tags.map((t) => [t, aggregate(perItem.filter((r) => r.tags.includes(t)), topN)])) };
}

export async function runRetrievalBenchmark(set: GroundTruthSet, subject: SelectionSubject, topN: number[] = [5, 10, 20]): Promise<BenchmarkReport> {
  validateGroundTruth(set);
  const items = set.items.map((i) => ({ ...i, tags: i.tags ?? deriveTags(i) }));
  const outputs = new Map<string, SelectionOutput>();
  for (const item of items) outputs.set(item.id, await subject.select(item));
  return {
    groundTruth: { name: set.name, provenance: set.provenance, sampleSize: items.length, adjudicatedSampleSize: items.filter((i) => i.adjudicated).length },
    subject: subject.name,
    topN,
    fixTouched: view(items, outputs, "fixTouched", topN)!,
    adjudicated: view(items, outputs, "relevant", topN),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function table(reports: BenchmarkReport[], pick: (r: BenchmarkReport) => Aggregate | null, topN: number[]): string[] {
  const lines = [`| Metric | ${reports.map((r) => r.subject).join(" | ")} |`, `|---|${reports.map(() => "---").join("|")}|`];
  const row = (label: string, f: (a: Aggregate) => string) => lines.push(`| ${label} | ${reports.map((r) => { const a = pick(r); return a ? f(a) : "n/a"; }).join(" | ")} |`);
  row("Items / expected files", (a) => `${a.items} / ${a.expectedFilesTotal}`);
  row("Candidate recall (macro)", (a) => pct(a.candidateRecallMacro));
  row("Candidate recall (micro)", (a) => `${pct(a.candidateRecallMicro)} (${a.expectedFilesFound}/${a.expectedFilesTotal})`);
  for (const n of topN) row(`Recall in top ${n}`, (a) => pct(a.recallAtN[`@${n}`]!));
  row("Excerpt recall (macro)", (a) => pct(a.excerptRecallMacro));
  row("Excerpt recall (micro)", (a) => pct(a.excerptRecallMicro));
  row("Items with ZERO expected files among candidates", (a) => `${a.itemsZeroCandidateHits}/${a.items}`);
  row("Items with ZERO expected files EXCERPTED", (a) => `${a.itemsZeroExcerptHits}/${a.items}`);
  row("Mean / median rank of found files", (a) => (a.meanRankFound === null ? "n/a" : `${a.meanRankFound} / ${a.medianRankFound}`));
  row("Irrelevant candidate rate*", (a) => pct(a.notInGroundTruthRateCandidates));
  row("Irrelevant excerpt rate*", (a) => pct(a.notInGroundTruthRateExcerpts));
  return lines;
}

/** Human-readable comparison of one or more subjects over the same ground truth, segmented by category. */
export function renderMarkdown(reports: BenchmarkReport[]): string {
  const first = reports[0]!;
  const L: string[] = [];
  L.push(`# Retrieval benchmark — ${first.groundTruth.name}`, "");
  L.push(`**Sample: ${first.groundTruth.sampleSize} items; ${first.groundTruth.adjudicatedSampleSize} manually adjudicated.** ${first.groundTruth.provenance}`, "");
  L.push("GROUND TRUTH is historical/human (never CodeForge's own selection); SYSTEM OUTPUT is what each subject showed the model. No model scored anything.", "");
  L.push("## A. Against files the historical FIX touched (objective lower bound on relevance)", "", ...table(reports, (r) => r.fixTouched.aggregate, first.topN), "");
  L.push("\\* against fix-touched files, \"irrelevant\" is an UPPER BOUND: a file can be relevant without having been modified by the fix.", "");
  if (first.adjudicated) {
    L.push("## B. Against manually ADJUDICATED relevance (subset)", "", ...table(reports, (r) => r.adjudicated?.aggregate ?? null, first.topN), "");
  }
  const tags = Object.keys(first.fixTouched.byTag);
  L.push("## C. Category breakdown (fix-touched basis) — never blended", "");
  L.push(`| Category | Items | ${reports.map((r) => `${r.subject}: cand. recall / excerpt recall / zero-excerpt items`).join(" | ")} |`, `|---|---|${reports.map(() => "---").join("|")}|`);
  for (const t of tags) {
    const cells = reports.map((r) => { const a = r.fixTouched.byTag[t]!; return `${pct(a.candidateRecallMacro)} / ${pct(a.excerptRecallMacro)} / ${a.itemsZeroExcerptHits}`; });
    L.push(`| ${t} | ${first.fixTouched.byTag[t]!.items} | ${cells.join(" | ")} |`);
  }
  L.push("", "## Per item (fix-touched basis; ranks of each expected file, ✂ = excerpted, – = absent)", "");
  L.push(`| Item | Tags | ${reports.map((r) => r.subject).join(" | ")} |`, `|---|---|${reports.map(() => "---").join("|")}|`);
  first.fixTouched.perItem.forEach((it, i) => {
    const cell = (r: BenchmarkReport) => r.fixTouched.perItem[i]!.ranks.map((x) => `${x.rank ?? "–"}${x.inExcerpts ? "✂" : ""}`).join(", ");
    L.push(`| ${it.id} | ${it.tags.join(" ")} | ${reports.map(cell).join(" | ")} |`);
  });
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Item categories (deterministic, derived from the item text and the FIX files only — never from system output)
// ---------------------------------------------------------------------------

/**
 * Deterministic, content-independent split (parity of the first hex digit of sha256(id)). Ranking changes are
 * developed by looking at `split_tune` items only; `split_holdout` items are reported but never inspected while
 * tuning, so an improvement that shows up there was not fitted to it.
 */
export function splitOf(id: string): "split_tune" | "split_holdout" {
  return parseInt(createHash("sha256").update(id).digest("hex")[0]!, 16) % 2 === 0 ? "split_tune" : "split_holdout";
}

const FILE_NAMED = /\b[\w./-]+\.(?:dart|tsx?|jsx?|kt|gradle|json|ya?ml|sql)\b|\b(?:frontend|backend|lib)\/[\w./-]+/;
const SYMBOL_NAMED = /`[^`\n]{3,80}`|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b\w+\(\)/;

/**
 * Categories for segmenting results (a single blended score hides where retrieval works):
 *  symptom_only | names_file | names_symbol            what the description itself gives away
 *  backend | frontend | monorepo_crossing               which application(s) the FIX touched
 *  source_<descriptionSource>                           where the description text came from
 *  split_tune | split_holdout                           a fixed, id-derived half of the items (see `splitOf`)
 */
export function deriveTags(item: Pick<GroundTruthItem, "id" | "description" | "fixTouchedFiles" | "descriptionSource">): string[] {
  const tags: string[] = [];
  tags.push(splitOf(item.id));
  const names = FILE_NAMED.test(item.description);
  const symbols = SYMBOL_NAMED.test(item.description.replace(FILE_NAMED, " "));
  if (names) tags.push("names_file");
  if (symbols) tags.push("names_symbol");
  if (!names && !symbols) tags.push("symptom_only");
  const backend = item.fixTouchedFiles.some((f) => f.startsWith("backend/"));
  const frontend = item.fixTouchedFiles.some((f) => f.startsWith("frontend/"));
  if (backend && frontend) tags.push("monorepo_crossing");
  else if (backend) tags.push("backend");
  else if (frontend) tags.push("frontend");
  if (item.descriptionSource) tags.push(`source_${item.descriptionSource}`);
  return tags;
}
