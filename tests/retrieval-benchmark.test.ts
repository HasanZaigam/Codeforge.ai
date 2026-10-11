import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, deriveTags, splitOf, renderMarkdown, runRetrievalBenchmark, scoreItem, validateGroundTruth, type GroundTruthSet, type SelectionSubject } from "../src/benchmark/retrieval-benchmark.js";
import { createPipelineSubject } from "../src/benchmark/pipeline-subject.js";
import { openLocalGitSession } from "../src/benchmark/local-git-session.js";
import { RepositoryInspector } from "../src/backlog/repository-inspector.js";

/**
 * Phase 4A.4 — the retrieval benchmark FRAMEWORK. It scores what a selection subject returns against explicit
 * ground truth; it never derives expectations from the system output, never calls a model, and is deterministic.
 * (The real Jinvani ground truth is project data and lives outside this repository; these tests use a synthetic set.)
 */

const run = promisify(execFile);
const REV = "a".repeat(40);
const item = (over: Record<string, unknown> = {}) => ({ id: "I-1", title: "t", description: "d", revision: REV, fixTouchedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"], ...over });

test("scoreItem: ranks, recall, excerpt recall and not-in-ground-truth rates are exact (hand-computed)", () => {
  const out = { candidates: ["x.ts", "a.ts", "y.ts", "b.ts", "z.ts"], excerpts: ["a.ts", "x.ts"], method: "index" as const };
  const r = scoreItem(item(), out);
  assert.deepEqual(r.ranks, [
    { file: "a.ts", rank: 2, inExcerpts: true },
    { file: "b.ts", rank: 4, inExcerpts: false },
    { file: "c.ts", rank: null, inExcerpts: false },
    { file: "d.ts", rank: null, inExcerpts: false },
  ]);
  assert.equal(r.candidateRecall, 0.5); // 2 of 4
  assert.equal(r.excerptRecall, 0.25); // 1 of 4
  assert.equal(r.itemHitInExcerpts, true);
  assert.equal(r.candidatesNotInGroundTruth, 3);
  assert.equal(r.notInGroundTruthRateCandidates, 0.6);
  assert.equal(r.notInGroundTruthRateExcerpts, 0.5);
  assert.deepEqual(r.systemOutput, { candidateCount: 5, excerptCount: 2, method: "index" });
  assert.deepEqual(r.groundTruth, { basis: "fixTouched", expectedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"] }, "ground truth and system output are separate fields");
});

test("aggregate: macro vs micro recall, recall@N, mean/median rank over FOUND files only, empty outputs are 0 (not NaN)", () => {
  const a = scoreItem(item({ id: "A", fixTouchedFiles: ["a.ts", "b.ts"] }), { candidates: ["a.ts", "q", "b.ts"], excerpts: ["a.ts"], method: "name" });
  const b = scoreItem(item({ id: "B", fixTouchedFiles: ["c.ts"] }), { candidates: [], excerpts: [], method: "name" });
  const g = aggregate([a, b], [1, 3]);
  assert.equal(g.items, 2);
  assert.equal(g.candidateRecallMacro, 0.5); // (1 + 0) / 2
  assert.equal(g.candidateRecallMicro, 0.6667); // 2 of 3 files
  assert.equal(g.recallAtN["@1"], 0.25); // A: 1/2, B: 0 ⇒ 0.25
  assert.equal(g.recallAtN["@3"], 0.5);
  assert.equal(g.meanRankFound, 2);
  assert.equal(g.medianRankFound, 2);
  assert.equal(g.itemHitRateCandidates, 0.5);
  assert.equal(g.itemHitRateExcerpts, 0.5);
  assert.equal(g.notInGroundTruthRateCandidates, 0.1667, "B has no candidates ⇒ rate 0, not NaN");
  assert.equal(aggregate([], [5]).candidateRecallMacro, 0);
  assert.equal(aggregate([b], [5]).meanRankFound, null);
});

test("validateGroundTruth rejects empty, duplicated, revision-less or description-less items — ground truth must be explicit", () => {
  const ok: GroundTruthSet = { name: "n", provenance: "p", items: [item()] };
  assert.doesNotThrow(() => validateGroundTruth(ok));
  assert.throws(() => validateGroundTruth({ ...ok, items: [] }), /no items/);
  assert.throws(() => validateGroundTruth({ ...ok, items: [item({ fixTouchedFiles: [] })] }), /no fix-touched files/);
  assert.throws(() => validateGroundTruth({ ...ok, items: [item({ fixTouchedFiles: ["a.ts", "a.ts"] })] }), /twice/);
  assert.throws(() => validateGroundTruth({ ...ok, items: [item(), item()] }), /duplicate/);
  assert.throws(() => validateGroundTruth({ ...ok, items: [item({ revision: "main" })] }), /revision/);
  assert.throws(() => validateGroundTruth({ ...ok, items: [item({ description: "  " })] }), /description/);
});

test("a subject cannot influence its own expectations: expected files come only from ground truth, and a subject echoing them scores 100% while an empty one scores 0%", async () => {
  const set: GroundTruthSet = { name: "n", provenance: "p", items: [item({ id: "A", fixTouchedFiles: ["a.ts", "b.ts"], tags: ["t1"] }), item({ id: "B", fixTouchedFiles: ["c.ts"], tags: ["t2"] })] };
  const oracle: SelectionSubject = { name: "oracle", select: async (i) => ({ candidates: [...i.fixTouchedFiles], excerpts: [...i.fixTouchedFiles], method: "index" }) };
  const empty: SelectionSubject = { name: "empty", select: async () => ({ candidates: [], excerpts: [], method: "name" }) };
  const good = await runRetrievalBenchmark(set, oracle);
  const bad = await runRetrievalBenchmark(set, empty);
  assert.equal(good.fixTouched.aggregate.candidateRecallMacro, 1);
  assert.equal(good.fixTouched.aggregate.notInGroundTruthRateCandidates, 0);
  assert.equal(bad.fixTouched.aggregate.candidateRecallMacro, 0);
  assert.equal(bad.fixTouched.aggregate.itemHitRateExcerpts, 0);
  assert.deepEqual(Object.keys(good.fixTouched.byTag).sort(), ["t1", "t2"]);
  assert.equal(good.fixTouched.byTag["t1"]!.items, 1);
  assert.equal(good.groundTruth.sampleSize, 2, "the REAL sample size is what is reported");
  // Deterministic and machine-readable.
  assert.deepEqual(await runRetrievalBenchmark(set, oracle), good);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(good)));
  // Human-readable.
  const md = renderMarkdown([bad, good]);
  assert.match(md, /Sample: 2 items; 0 manually adjudicated/);
  assert.match(md, /\| Candidate recall \(macro\) \| 0\.0% \| 100\.0% \|/);
  assert.match(md, /Items with ZERO expected files among candidates \| 2\/2 \| 0\/2/);
  assert.match(md, /GROUND TRUTH is historical\/human/);
});

// ---------------------------------------------------------------------------
// The real pipeline over a real git repository at an exact revision
// ---------------------------------------------------------------------------

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "bench-repo-"));
  const git = (...a: string[]) => run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  await git("init", "-b", "main");
  await mkdir(join(dir, "src", "accounts"), { recursive: true });
  await writeFile(join(dir, "src", "accounts", "manager.ts"), "export function deleteProfile(id: string) {}\n");
  await writeFile(join(dir, "src", "profile-avatar.ts"), "export const avatar = 1;\n");
  await writeFile(join(dir, ".env"), "SECRET=abcdefgh12345678\n");
  await git("add", "-A");
  await git("commit", "-m", "one");
  const rev1 = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(dir, "src", "accounts", "manager.ts"), "export function deleteProfile(id: string) { /* now guarded */ }\nexport function guard() {}\n");
  await git("add", "-A");
  await git("commit", "-m", "two");
  const rev2 = (await git("rev-parse", "HEAD")).stdout.trim();
  return { dir, rev1, rev2 };
}

test("REAL git replay: items are scored at their exact revision, the index beats name-only where a name shares nothing with the item, and results are byte-identical across runs", async () => {
  const { dir, rev1, rev2 } = await makeRepo();
  const set: GroundTruthSet = {
    name: "synthetic",
    provenance: "hand-written for the test",
    items: [
      { id: "S-1", title: "Profile removal is unguarded", description: "Deleting the main profile is possible and breaks the session", revision: rev1, fixTouchedFiles: ["src/accounts/manager.ts"] },
      { id: "S-2", title: "Same item at the later revision", description: "Deleting the main profile is possible and breaks the session", revision: rev2, fixTouchedFiles: ["src/accounts/manager.ts"] },
    ],
  };
  const withIndex = await runRetrievalBenchmark(set, createPipelineSubject(dir, { useIndex: true }));
  const nameOnly = await runRetrievalBenchmark(set, createPipelineSubject(dir, { useIndex: false }));
  for (const r of withIndex.fixTouched.perItem) assert.equal(r.systemOutput.method, "index");
  for (const r of nameOnly.fixTouched.perItem) assert.equal(r.systemOutput.method, "name");
  // `manager.ts` has no word from the item in its name — only its declared symbol does.
  assert.equal(withIndex.fixTouched.aggregate.candidateRecallMacro, 1);
  assert.equal(nameOnly.fixTouched.aggregate.candidateRecallMacro, 0);
  assert.equal(withIndex.fixTouched.aggregate.itemHitRateExcerpts, 1, "and it was excerpted");
  assert.deepEqual(await runRetrievalBenchmark(set, createPipelineSubject(dir, { useIndex: true })), withIndex);
  // No secret ever appears as a candidate or excerpt.
  for (const r of [...withIndex.fixTouched.perItem, ...nameOnly.fixTouched.perItem]) assert.ok(r.ranks.every((x) => x.file !== ".env"));
});

test("local session: exact revision, refuses non-hex revisions, reads by exact listed path only, never sees the moved-on HEAD", async () => {
  const { dir, rev1, rev2 } = await makeRepo();
  const s1 = await openLocalGitSession(dir, rev1);
  const s2 = await openLocalGitSession(dir, rev2);
  assert.equal(s1.revision, rev1);
  assert.notEqual(s1.revision, s2.revision);
  assert.match((await s1.readBlob("src/accounts/manager.ts", 10_000, new AbortController().signal)).toString(), /^export function deleteProfile\(id: string\) \{\}\n$/, "rev1 shows the OLD content");
  assert.match((await s2.readBlob("src/accounts/manager.ts", 10_000, new AbortController().signal)).toString(), /now guarded/);
  await assert.rejects(() => openLocalGitSession(dir, "main; rm -rf /"), /hex commit id/);
  await assert.rejects(() => openLocalGitSession(dir, "--upload-pack=x"), /hex commit id/);
  await assert.rejects(() => s1.readBlob("../../etc/passwd", 100, new AbortController().signal), /not in the repository listing/);
  // The inspector's secret rule still applies over this session.
  assert.deepEqual(await new RepositoryInspector(s1).read(".env", new AbortController().signal), { ok: false, reason: "secret_path" });
});


test("two ground truths stay distinct: fix-touched is scored for every item, ADJUDICATED relevance only for its subset — and can differ from the fix files", async () => {
  const set: GroundTruthSet = {
    name: "n",
    provenance: "p",
    items: [
      item({ id: "A", fixTouchedFiles: ["a.ts"], adjudicated: { relevantFiles: ["a.ts", "caller.ts", "model.ts"], adjudicatedBy: "reviewer", method: "read callers" } }),
      item({ id: "B", fixTouchedFiles: ["b.ts"] }),
    ],
  };
  const subject: SelectionSubject = { name: "s", select: async () => ({ candidates: ["a.ts", "caller.ts", "b.ts", "zzz.ts"], excerpts: ["caller.ts"], method: "index" }) };
  const r = await runRetrievalBenchmark(set, subject);
  assert.equal(r.groundTruth.sampleSize, 2);
  assert.equal(r.groundTruth.adjudicatedSampleSize, 1);
  assert.equal(r.fixTouched.perItem.length, 2);
  assert.equal(r.adjudicated!.perItem.length, 1, "only the adjudicated item is in the relevance view");
  assert.equal(r.fixTouched.perItem[0]!.excerptRecall, 0, "the excerpt (caller.ts) is not a fix-touched file…");
  assert.equal(r.adjudicated!.perItem[0]!.excerptRecall, 0.3333, "…but it IS a relevant one (1 of 3)");
  assert.equal(r.adjudicated!.perItem[0]!.candidateRecall, 0.6667);
  assert.equal(r.adjudicated!.perItem[0]!.groundTruth.basis, "relevant");
  assert.equal(r.adjudicated!.aggregate.notInGroundTruthRateCandidates, 0.5, "irrelevant-file rate is against adjudicated relevance (2 of 4 candidates)");
  assert.equal(r.fixTouched.aggregate.itemsZeroExcerptHits, 2);
  assert.match(renderMarkdown([r]), /## B\. Against manually ADJUDICATED relevance/);
  // An adjudication must say who judged it and how.
  assert.throws(() => validateGroundTruth({ ...set, items: [item({ adjudicated: { relevantFiles: ["a.ts"], adjudicatedBy: " ", method: "m" } })] }), /who judged/);
  assert.throws(() => validateGroundTruth({ ...set, items: [item({ adjudicated: { relevantFiles: [], adjudicatedBy: "x", method: "m" } })] }), /no relevant files/);
  assert.throws(() => scoreItem(item(), { candidates: [], excerpts: [], method: "name" }, "relevant"), /no relevant ground truth/);
});

test("deriveTags: categories come from the description and the FIX files only", () => {
  const t = (description: string, files: string[], src?: "task_goal") => deriveTags({ id: "X", description, fixTouchedFiles: files, descriptionSource: src });
  assert.deepEqual(t("Tapping a banner does nothing.", ["frontend/mobile/lib/a.dart"], "task_goal").filter((x) => !x.startsWith("split_")), ["symptom_only", "frontend", "source_task_goal"]);
  assert.match(t("x", ["a"]).find((x) => x.startsWith("split_"))!, /^split_(tune|holdout)$/);
  assert.deepEqual(splitOf("PR71"), splitOf("PR71"), "the split is a pure function of the id");
  assert.ok(t("The bug is in frontend/mobile/lib/features/a.dart", ["backend/x.ts"]).includes("names_file"));
  assert.ok(t("see profile_page.dart", ["backend/x.ts"]).includes("names_file"));
  assert.ok(t("the getProfileDeleteBlocker helper is unused", ["backend/x.ts"]).includes("names_symbol"));
  assert.ok(t("call `deleteProfile` twice", ["backend/x.ts"]).includes("names_symbol"));
  assert.ok(!t("Tapping a banner does nothing (BUG-074).", ["backend/x.ts"]).includes("names_symbol"), "a QA ticket id is not a symbol");
  assert.deepEqual(t("x", ["backend/a.ts", "frontend/mobile/b.dart"]).filter((x) => x === "monorepo_crossing" || x === "backend" || x === "frontend"), ["monorepo_crossing"]);
});


test("the tune / hold-out split is content-independent, deterministic, and roughly balanced — both halves exist", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `PR${i + 60}`);
  const halves = ids.map(splitOf);
  const tune = halves.filter((h) => h === "split_tune").length;
  assert.ok(tune >= 12 && tune <= 28, `tune=${tune}`);
  assert.ok(halves.includes("split_holdout"), "a hold-out half exists");
  assert.deepEqual(ids.map(splitOf), halves);
});
