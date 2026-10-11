/**
 * Manual REAL validation of claim-bound verification (Phase 4A.5, GAP-033) — `npm run validate:claim-verification`.
 * See /docs/BACKLOG_INTELLIGENCE.md §4i.
 *
 * It runs the whole chain with NO fixture engine and NO test doubles:
 *
 *   backlog item ─► real worker path ─► real model ─► AI claims ─► platform evidence + investigation
 *   AI claim ─► approved check (declared by YOU in --check-file; the model can only be matched to it) ─► binding
 *   binding ─► ClaimVerifier ─► a fresh workspace checked out at the EXACT analysed commit ─► the check's real command
 *   result ─► claim-verification record ─► CHECK_RESULT evidence ─► reconciliation ─► review state
 *
 * SAFE BY DEFAULT: it works on a COPY of the database, against a LOCAL git clone you point it at (`--repo-dir`, checked out at
 * the revision you want analysed, default branch `main`) — nothing is pushed, your real database is untouched, and the only
 * code that runs is the command your own approved check declares (it will typically `npm ci` and run a test).
 *
 * Usage:
 *   npm run validate:claim-verification -- --source-project <id> --repo-dir <path> --check-file <check.json> \
 *        --title "..." --description "..." [--ref BUG-1] [--json-out report.json]
 * `--check-file` holds one ApprovedClaimCheck (see domain/types.ts) or an array of them.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const sourceProject = arg("--source-project");
  const repoDir = arg("--repo-dir");
  const checkFile = arg("--check-file");
  const title = arg("--title");
  const description = arg("--description");
  if (!sourceProject || !repoDir || !checkFile || !title || !description) {
    console.error('usage: npm run validate:claim-verification -- --source-project <id> --repo-dir <path> --check-file <file.json> --title "…" --description "…" [--ref X] [--json-out f]');
    process.exit(2);
  }
  if ((process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim() === "fixture") {
    console.error("REFUSING: CODING_ENGINE=fixture is a scripted engine, so this would not be a real-provider validation.");
    process.exit(2);
  }

  const scratch = mkdtempSync(join(tmpdir(), "codeforge-validate-claim-"));
  execFileSync("sqlite3", [process.env.DB_PATH ?? "./.data/platform.sqlite", `.backup '${join(scratch, "platform.sqlite")}'`]);
  process.env.DB_PATH = join(scratch, "platform.sqlite");
  process.env.WORKSPACES_ROOT = join(scratch, "workspaces");
  process.env.PROJECT_WORKSPACE_ROOT = join(scratch, "project-workspaces");
  console.log(`[validate] working on a COPY of the database in ${scratch}`);

  const { buildPlatformFromEnv } = await import("../env-platform.js");
  const { buildApplicationServices } = await import("../application/index.js");
  const platform = buildPlatformFromEnv("validate-claim-verification");
  const services = buildApplicationServices(platform);
  const source = platform.projects.findById(sourceProject);
  if (!source) {
    console.error(`No project ${sourceProject}.`);
    process.exit(2);
  }
  const owner = source.ownerId;
  const parsed = JSON.parse(readFileSync(checkFile, "utf8")) as unknown;
  const claimChecks = (Array.isArray(parsed) ? parsed : [parsed]) as NonNullable<NonNullable<typeof source.commands>["claimChecks"]>;

  const revision = execFileSync("git", ["-C", resolve(repoDir), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const project = await services.projects.create(
    { name: `claim-verification validation @ ${revision.slice(0, 7)}`, sourceControlProvider: "local-git", repoUrl: resolve(repoDir), codingEngine: source.codingEngine, commands: { claimChecks } },
    owner,
  );
  console.log(`[validate] project=${project.id} engine=${project.codingEngine} repo=${resolve(repoDir)} revision=${revision}`);

  const item = services.backlog.createItem(project.id, { title, description, externalRef: arg("--ref") }, owner);
  const t0 = Date.now();
  services.backlog.requestAnalysis(item.id, owner);
  await platform.backlogRunner.drain();
  console.log(`[validate] real analysis finished after ${Math.round((Date.now() - t0) / 1000)}s`);

  const before = services.backlog.getItem(item.id, owner);
  const a0 = before.latestAnalysis;
  if (!a0?.result) {
    console.log(JSON.stringify({ item: before.item.status, analysis: a0?.status ?? null, failure: a0?.failureReason ?? null }, null, 2));
    console.error("[validate] the analysis did not produce a result; nothing to verify");
    process.exit(1);
  }
  const asm0 = a0.platformChecks!.assessment!;
  const beforeSummary = {
    modelClaims: a0.result.claims.map((c, i) => ({ index: i, kind: c.kind, confidence: c.confidence, statement: c.statement, searchTerms: c.searchTerms })),
    investigation: asm0.investigation && { signal: asm0.investigation.signal, premise: asm0.investigation.premise && { kind: asm0.investigation.premise.kind, mechanism: asm0.investigation.premise.mechanism }, candidates: asm0.investigation.candidates.map((c) => ({ path: c.path, symbol: c.symbol, wiredIn: c.wiredIn })) },
    reconciliationBefore: asm0.reconciliation?.findings.map((f) => ({ claim: f.claimIndex, outcome: f.outcome, availableChecks: f.availableChecks })),
    boundRequirements: asm0.verification,
    reviewBefore: before.review,
    analysedRevision: asm0.reconciliation?.revision,
  };
  console.log(JSON.stringify(beforeSummary, null, 2));

  let verification: unknown = null;
  if ((asm0.verification ?? []).length === 0) {
    console.log("[validate] the model produced no behaviour claim bound to the approved check — nothing to verify (GAP-033 stays open for this run)");
  } else {
    console.log("[validate] running the approved check in a workspace at the analysed revision (this executes the check's command)…");
    const started = Date.now();
    // The SAME production path as the API: enqueue a durable job, then drive the existing worker's runner (no direct execution).
    const out = services.claimVerifier.request(item.id, owner);
    console.log(`[validate] queued ${out.jobs.length} verification job(s): ${out.jobs.map((j) => `${j.id} (claim ${j.claimId.slice(0, 8)}, check ${j.checkId}, revision ${j.revision.slice(0, 12)})`).join("; ")}`);
    await platform.claimVerificationRunner.drain();
    const finished = services.claimVerifier.list(item.id, owner);
    console.log(`[validate] verification finished after ${Math.round((Date.now() - started) / 1000)}s: ${finished.map((j) => `${j.id}=${j.status}`).join(", ")}`);
    verification = { jobs: finished.map((j) => ({ id: j.id, status: j.status, claimId: j.claimId, checkId: j.checkId, revision: j.revision, attempts: j.attemptCount, failureReason: j.failureReason, startedAt: j.startedAt, completedAt: j.completedAt })) };
  }

  const after = services.backlog.getItem(item.id, owner);
  const asm = after.latestAnalysis!.platformChecks!.assessment!;
  const report = {
    ...beforeSummary,
    verificationJobs: (verification as { jobs?: unknown } | null)?.jobs ?? null,
    verificationRecords: after.claimVerifications.map((v) => ({ id: v.id, jobId: v.jobId, executor: v.executor, workspaceId: v.workspaceId, startedAt: v.startedAt, completedAt: v.completedAt, timedOut: v.timedOut, headBefore: v.headBefore, headAfter: v.headAfter, claimId: v.claimId, checkId: v.checkId, revision: v.revision, state: v.state, exitCode: v.exitCode, durationMs: v.durationMs, command: v.command, logTail: (v.logExcerpt ?? "").slice(-300) })),
    checkResultEvidence: asm.evidence.filter((e) => e.type === "CHECK_RESULT"),
    reconciliationAfter: asm.reconciliation?.findings.map((f) => ({ claim: f.claimIndex, claimId: f.claimId, outcome: f.outcome, behaviorVerified: f.behaviorVerified, verificationId: f.verificationId, explanation: f.explanation })),
    reviewAfter: after.review,
    itemStatusAfter: after.item.status,
    tasksCreated: (platform.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?").get(project.id) as { n: number }).n,
    verificationRun: verification === null ? "not run" : "run",
  };
  console.log(JSON.stringify(report, null, 2));
  const outPath = arg("--json-out");
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  await platform.backgroundRunner.stop();
  platform.db.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error("[validate] failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
