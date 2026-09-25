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

export interface GroundTruthItem {
  id: string;
  title: string;
  /** The QA-style description handed to the analysis — symptom/requirement only. */
  description: string;
  /** The exact repository revision to replay the item against (the state the item was raised on). */
  revision: string;
  /** GROUND TRUTH: repository-relative files that are relevant to the item. Human-maintained; never from system output. */
  expectedFiles: string[];
  expectedSymbols?: string[];
  expectedApplication?: string;
  /** Free labels for sub-reporting (e.g. "symptom_mentions_path"). */
  tags?: string[];
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
  groundTruth: { expectedFiles: string[] };
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

export interface BenchmarkReport {
  groundTruth: { name: string; provenance: string; sampleSize: number };
  subject: string;
  topN: number[];
  perItem: ItemResult[];
  aggregate: Aggregate;
  /** Aggregates for tagged subsets (e.g. items whose symptom text names no file). */
  byTag: Record<string, Aggregate>;
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
    if (!item.expectedFiles.length) throw new Error(`ground-truth item ${item.id} has no expected files`);
    if (new Set(item.expectedFiles).size !== item.expectedFiles.length) throw new Error(`ground-truth item ${item.id} lists a file twice`);
    if (!/^[0-9a-f]{7,64}$/.test(item.revision)) throw new Error(`ground-truth item ${item.id} has no valid revision`);
    if (!item.description.trim()) throw new Error(`ground-truth item ${item.id} has no description`);
  }
  if (set.items.length === 0) throw new Error("ground-truth set has no items");
}

export function scoreItem(item: GroundTruthItem, out: SelectionOutput): ItemResult {
  const expected = new Set(item.expectedFiles);
  const rankOf = new Map(out.candidates.map((p, i) => [p, i + 1]));
  const excerpted = new Set(out.excerpts);
  const ranks = item.expectedFiles.map((file) => ({ file, rank: rankOf.get(file) ?? null, inExcerpts: excerpted.has(file) }));
  const found = ranks.filter((r) => r.rank !== null).length;
  const excerptHits = ranks.filter((r) => r.inExcerpts).length;
  const candNot = out.candidates.filter((p) => !expected.has(p)).length;
  const excNot = out.excerpts.filter((p) => !expected.has(p)).length;
  return {
    id: item.id,
    title: item.title,
    tags: item.tags ?? [],
    groundTruth: { expectedFiles: item.expectedFiles },
    systemOutput: { candidateCount: out.candidates.length, excerptCount: out.excerpts.length, method: out.method },
    ranks,
    candidateRecall: round(found / item.expectedFiles.length),
    excerptRecall: round(excerptHits / item.expectedFiles.length),
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

export async function runRetrievalBenchmark(set: GroundTruthSet, subject: SelectionSubject, topN: number[] = [5, 10, 20]): Promise<BenchmarkReport> {
  validateGroundTruth(set);
  const perItem: ItemResult[] = [];
  for (const item of set.items) perItem.push(scoreItem(item, await subject.select(item)));
  const tags = [...new Set(perItem.flatMap((r) => r.tags))].sort();
  return {
    groundTruth: { name: set.name, provenance: set.provenance, sampleSize: set.items.length },
    subject: subject.name,
    topN,
    perItem,
    aggregate: aggregate(perItem, topN),
    byTag: Object.fromEntries(tags.map((t) => [t, aggregate(perItem.filter((r) => r.tags.includes(t)), topN)])),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Human-readable comparison of one or more subjects over the same ground truth. */
export function renderMarkdown(reports: BenchmarkReport[]): string {
  const first = reports[0]!;
  const lines: string[] = [];
  lines.push(`# Retrieval benchmark — ${first.groundTruth.name}`);
  lines.push("");
  lines.push(`**Sample size: ${first.groundTruth.sampleSize} items.** Ground truth: ${first.groundTruth.provenance}`);
  lines.push("");
  lines.push("GROUND TRUTH is human/independent (never CodeForge's own selection). SYSTEM OUTPUT is what each subject showed the model. No model scored anything.");
  lines.push("");
  lines.push(`| Metric | ${reports.map((r) => r.subject).join(" | ")} |`);
  lines.push(`|---|${reports.map(() => "---").join("|")}|`);
  const row = (label: string, pick: (a: Aggregate) => string) => lines.push(`| ${label} | ${reports.map((r) => pick(r.aggregate)).join(" | ")} |`);
  row("Expected files (total)", (a) => String(a.expectedFilesTotal));
  row("Candidate recall (macro)", (a) => pct(a.candidateRecallMacro));
  row("Candidate recall (micro)", (a) => `${pct(a.candidateRecallMicro)} (${a.expectedFilesFound}/${a.expectedFilesTotal})`);
  for (const n of first.topN) row(`Recall in top ${n}`, (a) => pct(a.recallAtN[`@${n}`]!));
  row("Excerpt recall (macro)", (a) => pct(a.excerptRecallMacro));
  row("Excerpt recall (micro)", (a) => pct(a.excerptRecallMicro));
  row("Items with ≥1 expected file in candidates", (a) => pct(a.itemHitRateCandidates));
  row("Items with ≥1 expected file EXCERPTED", (a) => pct(a.itemHitRateExcerpts));
  row("Mean / median rank of found expected files", (a) => (a.meanRankFound === null ? "n/a" : `${a.meanRankFound} / ${a.medianRankFound}`));
  row("Candidates not in ground truth (upper bound on irrelevant)", (a) => pct(a.notInGroundTruthRateCandidates));
  row("Excerpts not in ground truth (upper bound on irrelevant)", (a) => pct(a.notInGroundTruthRateExcerpts));
  row("Mean candidates / excerpts per item", (a) => `${a.meanCandidateCount} / ${a.meanExcerptCount}`);
  for (const tag of Object.keys(first.byTag)) {
    lines.push("");
    lines.push(`### Subset \`${tag}\` (${first.byTag[tag]!.items} items)`);
    lines.push(`| Metric | ${reports.map((r) => r.subject).join(" | ")} |`);
    lines.push(`|---|${reports.map(() => "---").join("|")}|`);
    const sub = (label: string, pick: (a: Aggregate) => string) => lines.push(`| ${label} | ${reports.map((r) => (r.byTag[tag] ? pick(r.byTag[tag]!) : "n/a")).join(" | ")} |`);
    sub("Candidate recall (macro)", (a) => pct(a.candidateRecallMacro));
    sub("Excerpt recall (macro)", (a) => pct(a.excerptRecallMacro));
    sub("Items with ≥1 expected file EXCERPTED", (a) => pct(a.itemHitRateExcerpts));
  }
  lines.push("");
  lines.push("## Per item");
  lines.push(`| Item | Expected | ${reports.map((r) => `${r.subject}: ranks (✂ = excerpted)`).join(" | ")} |`);
  lines.push(`|---|---|${reports.map(() => "---").join("|")}|`);
  first.perItem.forEach((it, i) => {
    const cell = (r: BenchmarkReport) => r.perItem[i]!.ranks.map((x) => `${x.rank ?? "–"}${x.inExcerpts ? "✂" : ""}`).join(", ");
    lines.push(`| ${it.id} | ${it.groundTruth.expectedFiles.length} | ${reports.map(cell).join(" | ")} |`);
  });
  return lines.join("\n") + "\n";
}
