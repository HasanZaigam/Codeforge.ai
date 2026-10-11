/**
 * Manual REAL validation of bulk backlog intelligence (Phase 4B) — `npm run validate:bulk-backlog`. See /docs/BACKLOG_INTELLIGENCE.md §4l.
 *
 * Import ─► (preview, confirm) ─► BacklogItems ─► ONE explicit bulk-analysis start ─► the EXISTING per-item analysis jobs ─► the existing
 * worker runner under the existing global cap ─► real model ─► evidence/reconciliation ─► review rows. It stops THERE: it approves nothing,
 * converts nothing and starts nothing. The report contains counts and per-item review facts — never an "accuracy score" (there is no
 * independent ground truth for a QA sheet).
 *
 * SAFE BY DEFAULT: works on a COPY of the database against a LOCAL clone (`--repo-dir`); refuses CODING_ENGINE=fixture.
 *
 *   npm run validate:bulk-backlog -- --source-project <id> --repo-dir <path> --csv <file.csv> --source-name "<name>" \
 *        [--check-file <check.json>] [--limit N] [--json-out report.json] [--md-out report.md]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { csvEscape } from "../backlog/import-csv.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const sourceProject = arg("--source-project");
  const repoDir = arg("--repo-dir");
  const csvFile = arg("--csv");
  const sourceName = arg("--source-name");
  if (!sourceProject || !repoDir || !csvFile || !sourceName) {
    console.error('usage: npm run validate:bulk-backlog -- --source-project <id> --repo-dir <path> --csv <file> --source-name "…" [--check-file f] [--limit N] [--json-out f] [--md-out f]');
    process.exit(2);
  }
  if ((process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim() === "fixture") {
    console.error("REFUSING: CODING_ENGINE=fixture is a scripted engine, so this would not be a real-provider validation.");
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "codeforge-validate-bulk-"));
  execFileSync("sqlite3", [process.env.DB_PATH ?? "./.data/platform.sqlite", `.backup '${join(scratch, "platform.sqlite")}'`]);
  process.env.DB_PATH = join(scratch, "platform.sqlite");
  process.env.WORKSPACES_ROOT = join(scratch, "workspaces");
  process.env.PROJECT_WORKSPACE_ROOT = join(scratch, "project-workspaces");
  console.log(`[validate] working on a COPY of the database in ${scratch}`);

  const { buildPlatformFromEnv } = await import("../env-platform.js");
  const { buildApplicationServices } = await import("../application/index.js");
  const platform = buildPlatformFromEnv("validate-bulk-backlog");
  const services = buildApplicationServices(platform);
  const source = platform.projects.findById(sourceProject);
  if (!source) {
    console.error(`No project ${sourceProject}.`);
    process.exit(2);
  }
  const owner = source.ownerId;
  const checkFile = arg("--check-file");
  const claimChecks = checkFile ? ((): unknown[] => { const p = JSON.parse(readFileSync(checkFile, "utf8")) as unknown; return Array.isArray(p) ? p : [p]; })() : [];
  const revision = execFileSync("git", ["-C", resolve(repoDir), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const project = await services.projects.create(
    { name: `bulk validation @ ${revision.slice(0, 7)}`, sourceControlProvider: "local-git", repoUrl: resolve(repoDir), codingEngine: source.codingEngine, commands: claimChecks.length ? { claimChecks: claimChecks as never } : undefined },
    owner,
  );
  console.log(`[validate] project=${project.id} engine=${project.codingEngine} revision=${revision}`);

  let csv = readFileSync(csvFile, "utf8");
  const limit = arg("--limit") ? Number(arg("--limit")) : null;
  if (limit) csv = csv.split("\n").slice(0, 1 + limit).join("\n"); // only for smoke runs; the real run imports the whole sheet
  const preview = services.bulk.preview(project.id, csv, { sourceName }, owner);
  console.log(`[validate] PREVIEW: ${preview.totalRows} rows, ${preview.accepted} valid, ${preview.rejected} rejected, ${preview.alreadyImported} already imported`);
  const { import: imp, rows } = services.bulk.confirmImport(project.id, csv, { sourceName }, owner);
  const replay = services.bulk.confirmImport(project.id, csv, { sourceName }, owner); // idempotency, demonstrated on real data
  console.log(`[validate] IMPORT ${imp.id}: accepted=${imp.acceptedRows} rejected=${imp.rejectedRows}; REPLAY: already_imported=${replay.import.alreadyImportedRows}, new=${replay.import.acceptedRows}`);
  const engineCallsAfterImport = 0; // the importer holds no engine; asserted structurally (BacklogBulkService has no analyzer dependency)

  const t0 = Date.now();
  const { bulk } = services.bulk.startAnalysis(project.id, { importId: imp.id }, owner);
  console.log(`[validate] bulk analysis ${bulk.job.id} queued: ${bulk.counts.queued} jobs (global cap ${platform.backlogOptions.maxAnalysisConcurrency})`);
  const progress = setInterval(() => {
    const v = services.bulk.getBulk(bulk.job.id, owner);
    console.log(`[validate] … ${v.status} completed=${v.counts.completed} failed=${v.counts.failed} running=${v.counts.running} queued=${v.counts.queued} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }, 60_000);
  await platform.backlogRunner.drain();
  clearInterval(progress);
  const wall = Date.now() - t0;
  const finalBulk = services.bulk.getBulk(bulk.job.id, owner);

  const review = services.bulk.reviewRows(project.id, { filter: "all", importId: imp.id }, owner);
  const groups = services.bulk.groups(project.id, owner);
  const usage = services.bulk.usageAggregate(review.rows);
  const analyses = review.rows.map((r) => platform.backlogAnalyses.findLatestForItem(r.itemId)).filter((a): a is NonNullable<typeof a> => !!a);
  const durations = analyses.map((a) => a.durationMs);
  const models = new Map<string, number>();
  for (const a of analyses) models.set(`${a.providerId ?? "?"}/${a.modelId ?? "?"}`, (models.get(`${a.providerId ?? "?"}/${a.modelId ?? "?"}`) ?? 0) + 1);
  const failures = new Map<string, number>();
  for (const r of review.rows) if (r.analysis.state === "FAILED") failures.set(r.analysis.failureCategory ?? "unknown", (failures.get(r.analysis.failureCategory ?? "unknown") ?? 0) + 1);
  const count = (f: (r: (typeof review.rows)[number]) => boolean) => review.rows.filter(f).length;
  const rejectedBy = new Map<string, number>();
  for (const r of rows) if (r.status === "REJECTED") rejectedBy.set(r.reason ?? "?", (rejectedBy.get(r.reason ?? "?") ?? 0) + 1);

  const report = {
    generatedAt: new Date().toISOString(),
    repositoryRevision: revision,
    source: { sourceName, csvFile: csvFile.split("/").pop(), engine: project.codingEngine },
    IMPORT: { rows: imp.totalRows, valid: imp.acceptedRows, invalid: imp.rejectedRows, rejectedByReason: Object.fromEntries(rejectedBy), replay: { alreadyImported: replay.import.alreadyImportedRows, newItems: replay.import.acceptedRows }, itemsCreated: review.total, engineCallsDuringImport: engineCallsAfterImport },
    ANALYSIS: {
      bulkStatus: finalBulk.status, counts: finalBulk.counts, wallClockMs: wall, globalCap: platform.backlogOptions.maxAnalysisConcurrency,
      averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      models: Object.fromEntries(models), failuresByCategory: Object.fromEntries(failures), usage,
    },
    INTELLIGENCE: {
      duplicateGroups: groups.duplicateGroups.length, duplicateEdges: groups.duplicateGroups.reduce((n, g) => n + g.edges.length, 0), dependencyProposals: groups.dependencies.length,
      implementationPresent: count((r) => r.review.implementation === "present"), implementationPossible: count((r) => r.review.implementation === "possible"),
      flowReferencePresent: count((r) => r.flow === "FLOW_REFERENCE_PRESENT"), possiblyAlreadyImplemented: count((r) => r.review.state === "POSSIBLY_ALREADY_IMPLEMENTED"),
      needsClarification: count((r) => r.review.state === "NEEDS_CLARIFICATION"), readyForProposal: count((r) => r.review.state === "READY_FOR_PROPOSAL"), noReviewState: count((r) => r.analysis.state === "SUCCEEDED" && r.review.state === null),
    },
    VERIFICATION: {
      approvedChecksDeclared: claimChecks.length, itemsWithRelevantCheck: count((r) => r.verification.checksAvailable > 0), itemsWithSufficientCheck: count((r) => r.verification.sufficientChecks > 0),
      verificationJobsExecuted: (platform.db.prepare("SELECT COUNT(*) AS n FROM claim_verification_jobs WHERE project_id = ?").get(project.id) as { n: number }).n,
      checkVerified: count((r) => r.verification.verified), behaviorUnverified: count((r) => r.analysis.state === "SUCCEEDED" && !r.verification.verified),
    },
    TASKS: { proposalsGenerated: (platform.db.prepare("SELECT COUNT(*) AS n FROM task_proposals WHERE project_id = ?").get(project.id) as { n: number }).n, proposalsApproved: 0, tasksCreated: (platform.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?").get(project.id) as { n: number }).n, note: "This validation stops at review by design: nothing is approved, converted or started." },
    items: review.rows.map((r) => ({ ref: r.ref, title: r.title, module: r.module, priority: r.priority, analysis: r.analysis.state, failure: r.analysis.failureCategory, reviewState: r.review.state, implementation: r.review.implementation, flow: r.flow, behavior: r.review.behavior, evidence: r.evidenceCount, duplicates: r.duplicates, dependencies: r.dependencies, usage: r.usage.status })),
  };
  console.log(JSON.stringify({ ...report, items: undefined }, null, 2));
  const jsonOut = arg("--json-out");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  const mdOut = arg("--md-out");
  if (mdOut) {
    const head = "Bug,Module,Priority,Analysis,Review state,Implementation,Flow,Behavior,Evidence,Duplicates,Dependencies";
    const body = report.items.map((i) => [i.ref ?? "", i.module ?? "", i.priority ?? "", i.analysis, i.reviewState ?? "", i.implementation, i.flow ?? "", i.behavior, String(i.evidence), `${i.duplicates.proposed + i.duplicates.confirmed}`, `${i.dependencies.proposed + i.dependencies.confirmed}`].map(csvEscape).join(","));
    writeFileSync(mdOut, [head, ...body].join("\n"));
  }
  await platform.backgroundRunner.stop();
  platform.db.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error("[validate] failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
