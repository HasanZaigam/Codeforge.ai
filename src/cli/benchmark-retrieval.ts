/**
 * `npm run benchmark:retrieval -- --ground-truth <file.json> --repo <local git dir> [--out-json f] [--out-md f]`
 *
 * Measures repository file selection (Phase 4A.4, GAP-032) against HUMAN-MAINTAINED ground truth: for each item, the
 * ranked candidates and the excerpted files the production pipeline would show a model — with the repository index and
 * as the file-name-only baseline — scored deterministically (no model, no network, the repository is only READ at each
 * item's exact revision). The ground-truth file is project data and is deliberately NOT part of this repository; see
 * docs/BACKLOG_INTELLIGENCE.md §4e for its format and provenance rules.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPipelineSubject } from "../benchmark/pipeline-subject.js";
import { renderMarkdown, runRetrievalBenchmark, type GroundTruthSet } from "../benchmark/retrieval-benchmark.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const gtPath = arg("--ground-truth");
  const repo = arg("--repo");
  if (!gtPath || !repo) {
    console.error("usage: npm run benchmark:retrieval -- --ground-truth <file.json> --repo <local git dir> [--out-json f] [--out-md f]");
    process.exit(2);
  }
  const set = JSON.parse(readFileSync(gtPath, "utf8")) as GroundTruthSet;
  const reports = [];
  for (const subject of [createPipelineSubject(repo, { useIndex: false }), createPipelineSubject(repo, { useIndex: true })]) {
    console.error(`[benchmark] running ${subject.name} over ${set.items.length} items…`);
    reports.push(await runRetrievalBenchmark(set, subject));
  }
  const md = renderMarkdown(reports);
  console.log(md);
  const outJson = arg("--out-json");
  const outMd = arg("--out-md");
  if (outJson) writeFileSync(outJson, JSON.stringify({ reports }, null, 2));
  if (outMd) writeFileSync(outMd, md);
}

main().catch((err) => {
  console.error("[benchmark] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
