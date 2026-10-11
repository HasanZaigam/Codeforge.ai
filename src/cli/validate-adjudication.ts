/**
 * Manual REAL validation / review of Phase 4B human ground-truth adjudication — `npm run validate:adjudication`.
 * See /docs/BACKLOG_INTELLIGENCE.md §4m/§4q.
 *
 * TWO modes:
 *
 *   FRESH RUN  (--source-project, --repo-dir, --csv, --source-name): import ─► REAL bulk analysis (real model, existing
 *     worker) ─► deterministic sampling, scoped to that run ─► an empty, human-fillable ground-truth template.
 *
 *   RESUME     (--resume <dir>, from an earlier run's `--keep-db <dir>`): re-opens that SAME preserved database in place —
 *     no new project, no new analysis, no new model calls — and applies a human-filled `--apply <file>` and/or (re)prints
 *     the sample/report/baseline for that project's most recent run (or `--run-id`).
 *
 * This script does NOT fabricate a single human judgment. Per the Phase 4B.1 brief: "If manual review is required,
 * implement the UI/API and then stop at the point requiring the human to supply the judgment." It stops there — it
 * prints/saves the sampled targets with their AI output and evidence, and a template row per target with an EMPTY label
 * column for a real reviewer to fill in and re-submit (via `--apply <filled.csv>`, which submits EXACTLY the labels a
 * human already wrote into that file — never invented here — or through the API/UI directly against a `--keep-db`'d copy).
 *
 * SAFE BY DEFAULT: a fresh run works on a COPY of the database against a LOCAL clone; refuses CODING_ENGINE=fixture. That
 * copy is a throwaway scratch dir DELETED at the end UNLESS `--keep-db <dir>` is given (Phase 4B.5 fix — see
 * BACKLOG_INTELLIGENCE.md §4q "the run that vanished": without it, the exact run just reported — its bulk job id, its
 * baseline, its sampled targets — is unrecoverable the moment the process exits, so no human can ever attach a real label
 * to it). With `--keep-db`, the working database (and its workspace dirs) are copied there instead of deleted, and either
 * `--resume <dir>` (this script) or `DB_PATH=<dir>/platform.sqlite npm run api`/`worker` (the real UI) can review it later.
 *
 *   npm run validate:adjudication -- --source-project <id> --repo-dir <path> --csv <file> --source-name "…" \
 *        [--seed s] [--dup-size N] [--clarification-size N] [--proposal-size N] [--out-json f] [--out-csv f] \
 *        [--apply <filled.csv>] [--keep-db <dir>]
 *
 *   npm run validate:adjudication -- --resume <dir> [--project-id <id>] [--run-id <id>] [--apply <filled.csv>] \
 *        [--seed s] [--dup-size N] [--clarification-size N] [--proposal-size N] [--out-json f] [--out-csv f]
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { csvEscape } from "../backlog/import-csv.js";
import type { BacklogAdjudicationService } from "../application/backlog-adjudication-service.js";
import type { BacklogBulkService } from "../application/backlog-bulk-service.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** Submits EXACTLY what a human reviewer already wrote into this file's `label`/`note` columns — nothing here invents a judgment. */
function applyFilledCsv(adjudication: BacklogAdjudicationService, applyFile: string, owner: string): Array<{ kind: string; targetId: string; ok: boolean; detail?: string }> {
  const applied: Array<{ kind: string; targetId: string; ok: boolean; detail?: string }> = [];
  const lines = readFileSync(applyFile, "utf8").split("\n").filter((l) => l.trim() !== "");
  const [header, ...body] = lines;
  const cols = header!.split(",");
  for (const line of body) {
    const cells = line.split(","); // the template never contains commas inside a cell — see the writer below
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
    if (!row.label) continue; // an unfilled row is skipped, never defaulted
    try {
      if (row.kind === "relationship") adjudication.judgeRelationship(row.targetId!, owner, row.label as never, row.note || undefined);
      else adjudication.judgeItem(row.targetId!, owner, row.category as never, row.label, row.note || undefined);
      applied.push({ kind: row.kind!, targetId: row.targetId!, ok: true });
    } catch (err) {
      applied.push({ kind: row.kind!, targetId: row.targetId!, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log(`[validate] APPLIED ${applied.filter((a) => a.ok).length}/${applied.length} human-supplied judgments from ${applyFile}`);
  return applied;
}

/** Samples, (optionally) applies a filled CSV, freezes a baseline, and writes the report + a fresh human-fillable template. Shared by both the fresh-run and resume paths so they produce IDENTICAL report shapes. */
async function sampleApplyReport(opts: {
  adjudication: BacklogAdjudicationService;
  bulk: BacklogBulkService;
  projectId: string;
  owner: string;
  runId: string;
  seed: string;
  dupSize: number;
  clarSize: number;
  propSize: number;
  sourceName: string | null;
  revision: string;
  repoLabel: string;
}): Promise<void> {
  const { adjudication, bulk, projectId, owner, runId, seed, dupSize, clarSize, propSize, sourceName, revision, repoLabel } = opts;
  const finalBulk = bulk.getBulk(runId, owner);

  const dup = adjudication.sampleDuplicateGroups(projectId, owner, seed, dupSize, runId);
  const clar = adjudication.sampleClarification(projectId, owner, seed, clarSize, runId);
  const prop = adjudication.sampleProposalReady(projectId, owner, seed, propSize, runId);
  const infrastructureFailures = [...new Map([...dup.infrastructureFailures, ...clar.infrastructureFailures, ...prop.infrastructureFailures].map((f) => [f.itemId, f])).values()];
  console.log("=".repeat(50));
  console.log("CORRECTED REPOSITORY-AWARE RUN");
  console.log(`  run (bulk job) id : ${runId}`);
  console.log(`  project           : ${projectId}`);
  console.log(`  dataset/source    : ${sourceName ?? "(unknown — resumed without --project-id metadata)"}`);
  console.log(`  repository        : ${repoLabel}`);
  console.log(`  revision          : ${revision}`);
  console.log(`  eligible analyzed : ${finalBulk.counts.completed}`);
  console.log(`  infra failures    : ${infrastructureFailures.length} (excluded from every sample below, never treated as an AI-quality outcome)`);
  console.log("=".repeat(50));
  console.log(`[validate] SAMPLED (seed="${seed}"): ${dup.groups.length}/${dup.totalGroups} duplicate groups (${dup.groups.reduce((n, g) => n + g.edges.length, 0)} edges), ${clar.sampled.length}/${clar.totalCandidates} clarification items, ${prop.sampled.length}/${prop.totalCandidates} proposal-ready items`);

  const applyFile = arg("--apply");
  const applied = applyFile ? applyFilledCsv(adjudication, applyFile, owner) : [];

  const metrics = adjudication.metrics(projectId, owner);
  // Freeze a baseline snapshot from EXACTLY this sample, scoped to this run — the frozen, immutable measurement of this
  // experiment. If this run's sample recorded no repository revision at all, createBaseline itself refuses rather than
  // silently freezing a fake "repository-aware" baseline (the exact Phase 4B.3 root cause).
  const baseline = adjudication.createBaseline(projectId, owner, { seed, duplicateSize: dupSize, clarificationSize: clarSize, proposalReadySize: propSize, sourceName: sourceName ?? undefined, runId });
  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    repositoryRevision: revision,
    seed,
    analysis: finalBulk.counts,
    infrastructureFailures,
    sample: {
      duplicateGroups: dup.groups.map((g) => ({ groupKey: g.groupKey, items: g.items, edges: g.edges.map((e) => ({ relationshipId: e.relationshipId, from: e.fromItemId, to: e.toItemId, confidence: e.confidence, rationale: e.rationale })) })),
      clarification: clar.sampled.map((s) => ({ itemId: s.row.itemId, ref: s.row.ref, title: s.row.title, aiReviewState: s.row.review.state })),
      proposalReady: prop.sampled.map((s) => ({ itemId: s.row.itemId, ref: s.row.ref, title: s.row.title, aiReviewState: s.row.review.state })),
    },
    humanLabelsCollected: applied.filter((a) => a.ok).length,
    applyResults: applied,
    metrics,
    baseline: { id: baseline.id, version: baseline.version, established: baseline.established, repositoryRevisions: baseline.repositoryRevisions, models: baseline.models, metrics: baseline.metrics },
    note: baseline.established
      ? `${applied.filter((a) => a.ok).length} human-supplied judgments were applied from ${applyFile}; baseline v${baseline.version} is ESTABLISHED.`
      : "NO HUMAN LABELS AVAILABLE — BASELINE NOT ESTABLISHED. No filled-in ground truth file was supplied in this run. A human reviewer fills in the template CSV's `label` column and re-runs with --apply, or uses the API/UI directly, then a new baseline can be created.",
  };
  console.log(baseline.established ? `[validate] BASELINE v${baseline.version} ESTABLISHED` : "[validate] BASELINE NOT ESTABLISHED — no VALID human labels exist yet for this run");
  console.log(JSON.stringify({ ...report, sample: undefined }, null, 2));
  const outJson = arg("--out-json");
  if (outJson) writeFileSync(outJson, JSON.stringify(report, null, 2));

  // A FRESH human-fillable template for whatever is still unreviewed: one row per sampled target, `label`/`note` blank.
  const outCsv = arg("--out-csv");
  if (outCsv) {
    const head = ["kind", "targetId", "category", "context", "aiConfidenceOrState", "label", "note"];
    const rows: string[][] = [];
    for (const g of dup.groups) for (const e of g.edges) rows.push(["relationship", e.relationshipId, "", `${e.fromItemId} <-> ${e.toItemId}: ${e.rationale}`, e.confidence, "", ""]);
    for (const s of clar.sampled) rows.push(["item", s.row.itemId, "CLARIFICATION", `${s.row.ref ?? ""} ${s.row.title}`, s.row.review.state ?? "", "", ""]);
    for (const s of prop.sampled) rows.push(["item", s.row.itemId, "PROPOSAL_READINESS", `${s.row.ref ?? ""} ${s.row.title}`, s.row.review.state ?? "", "", ""]);
    writeFileSync(outCsv, [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n"));
    console.log(`[validate] wrote a human-fillable template with ${rows.length} rows to ${outCsv}`);
  }
}

async function main(): Promise<void> {
  const resumeDir = arg("--resume");
  const seed = arg("--seed") ?? "baseline-1";
  const dupSize = Number(arg("--dup-size") ?? 8);
  const clarSize = Number(arg("--clarification-size") ?? 15);
  const propSize = Number(arg("--proposal-size") ?? 10);

  if (resumeDir) {
    // RESUME: re-open a database an earlier `--keep-db` run preserved, IN PLACE — no copy, no deletion, no new analysis.
    if (!existsSync(join(resumeDir, "platform.sqlite"))) {
      console.error(`No platform.sqlite in ${resumeDir} — pass the exact directory an earlier --keep-db run wrote.`);
      process.exit(2);
    }
    process.env.DB_PATH = join(resumeDir, "platform.sqlite");
    process.env.WORKSPACES_ROOT = join(resumeDir, "workspaces");
    process.env.PROJECT_WORKSPACE_ROOT = join(resumeDir, "project-workspaces");
    console.log(`[validate] RESUMING the preserved database at ${resumeDir} (in place — nothing copied, nothing will be deleted)`);

    const { buildPlatformFromEnv } = await import("../env-platform.js");
    const { buildApplicationServices } = await import("../application/index.js");
    const platform = buildPlatformFromEnv("validate-adjudication-resume");
    const services = buildApplicationServices(platform);

    const projectId = arg("--project-id") ?? (platform.db.prepare("SELECT id FROM projects ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined)?.id;
    if (!projectId) {
      console.error(`No project found in ${resumeDir}.`);
      process.exit(2);
    }
    const project = platform.projects.findById(projectId);
    if (!project) {
      console.error(`No project ${projectId} in ${resumeDir}.`);
      process.exit(2);
    }
    const owner = project.ownerId;
    const runId = arg("--run-id") ?? (platform.db.prepare("SELECT id FROM backlog_bulk_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string } | undefined)?.id;
    if (!runId) {
      console.error(`No bulk analysis run found for project ${projectId} in ${resumeDir}.`);
      process.exit(2);
    }
    // Best-effort, for the printed banner only — createBaseline (inside sampleApplyReport) is what actually ENFORCES that a
    // repository-aware run has a real, non-empty revision; this is just a friendly label before that check runs.
    let revision = "unknown";
    for (const m of services.bulk.getBulk(runId, owner).members) {
      const a = platform.backlogAnalyses.findLatestSucceededForItem(m.backlogItemId);
      const rev = a?.status === "succeeded" ? a.platformChecks?.assessment?.reconciliation?.revision : null;
      if (rev) {
        revision = rev;
        break;
      }
    }

    await sampleApplyReport({ adjudication: services.adjudication, bulk: services.bulk, projectId, owner, runId, seed, dupSize, clarSize, propSize, sourceName: null, revision, repoLabel: project.repoUrl });

    console.log(`[validate] RESUME done — ${resumeDir} was left exactly as it is; re-run --resume again any time to apply more labels or re-check the baseline.`);
    await platform.backgroundRunner.stop();
    platform.db.close();
    process.exit(0);
  }

  const sourceProject = arg("--source-project");
  const repoDir = arg("--repo-dir");
  const csvFile = arg("--csv");
  const sourceName = arg("--source-name");
  if (!sourceProject || !repoDir || !csvFile || !sourceName) {
    console.error('usage: npm run validate:adjudication -- --source-project <id> --repo-dir <path> --csv <file> --source-name "…" [--seed s] [--dup-size N] [--clarification-size N] [--proposal-size N] [--out-json f] [--out-csv f] [--apply filled.csv] [--keep-db dir]');
    console.error('   or: npm run validate:adjudication -- --resume <dir> [--project-id id] [--run-id id] [--apply filled.csv] [--out-json f] [--out-csv f]');
    process.exit(2);
  }
  if ((process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim() === "fixture") {
    console.error("REFUSING: CODING_ENGINE=fixture is a scripted engine, so this would not be a real-provider validation.");
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "codeforge-validate-adj-"));
  execFileSync("sqlite3", [process.env.DB_PATH ?? "./.data/platform.sqlite", `.backup '${join(scratch, "platform.sqlite")}'`]);
  process.env.DB_PATH = join(scratch, "platform.sqlite");
  process.env.WORKSPACES_ROOT = join(scratch, "workspaces");
  process.env.PROJECT_WORKSPACE_ROOT = join(scratch, "project-workspaces");
  console.log(`[validate] working on a COPY of the database in ${scratch}`);

  const { buildPlatformFromEnv } = await import("../env-platform.js");
  const { buildApplicationServices } = await import("../application/index.js");
  const platform = buildPlatformFromEnv("validate-adjudication");
  const services = buildApplicationServices(platform);
  const source = platform.projects.findById(sourceProject);
  if (!source) {
    console.error(`No project ${sourceProject}.`);
    process.exit(2);
  }
  const owner = source.ownerId;
  const revision = execFileSync("git", ["-C", resolve(repoDir), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const project = await services.projects.create({ name: `adjudication validation @ ${revision.slice(0, 7)}`, sourceControlProvider: "local-git", repoUrl: resolve(repoDir), codingEngine: source.codingEngine }, owner);
  console.log(`[validate] project=${project.id} engine=${project.codingEngine} revision=${revision}`);

  const csv = readFileSync(csvFile, "utf8");
  const { import: imp } = services.bulk.confirmImport(project.id, csv, { sourceName }, owner);
  console.log(`[validate] IMPORT ${imp.id}: accepted=${imp.acceptedRows} rejected=${imp.rejectedRows}`);

  const t0 = Date.now();
  const { bulk } = services.bulk.startAnalysis(project.id, { importId: imp.id }, owner);
  console.log(`[validate] real bulk analysis ${bulk.job.id} queued: ${bulk.counts.queued} jobs (this calls the real model for each — it will take several minutes)`);
  const progress = setInterval(() => {
    const v = services.bulk.getBulk(bulk.job.id, owner);
    console.log(`[validate] … ${v.status} completed=${v.counts.completed} failed=${v.counts.failed} running=${v.counts.running} queued=${v.counts.queued} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }, 60_000);
  await platform.backlogRunner.drain();
  clearInterval(progress);
  console.log(`[validate] analysis done in ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(services.bulk.getBulk(bulk.job.id, owner).counts)}`);

  // Phase 4B.4 — the bulk job id IS the run identity: every sample is scoped to exactly this run's own members, so it can
  // never mix with a different (e.g. earlier text-only) run over the same items.
  await sampleApplyReport({ adjudication: services.adjudication, bulk: services.bulk, projectId: project.id, owner, runId: bulk.job.id, seed, dupSize, clarSize, propSize, sourceName, revision, repoLabel: resolve(repoDir) });

  console.log(existsSync(scratch) ? "[validate] done" : "[validate] done (scratch already gone?)");
  await platform.backgroundRunner.stop();
  platform.db.close();
  const keepDb = arg("--keep-db");
  if (keepDb) {
    cpSync(scratch, keepDb, { recursive: true });
    console.log(`[validate] PRESERVED the working database at ${keepDb} — this run (bulk job ${bulk.job.id}) is now reviewable for real:`);
    console.log(`  npm run validate:adjudication -- --resume ${keepDb} --apply <filled.csv>   (re-applies labels + refreezes a baseline, no new analysis)`);
    console.log(`  DB_PATH=${join(keepDb, "platform.sqlite")} WORKSPACES_ROOT=${join(keepDb, "workspaces")} PROJECT_WORKSPACE_ROOT=${join(keepDb, "project-workspaces")} npm run api   (+ npm run worker) — then log in as the account that owns project ${project.id} and open Backlog → Ground-truth review.`);
  } else {
    console.log("[validate] no --keep-db given: the working database is being DELETED now — this run's bulk job/baseline/sample will be unrecoverable. Pass --keep-db <dir> to let a human actually review it afterward.");
  }
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error("[validate] failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
