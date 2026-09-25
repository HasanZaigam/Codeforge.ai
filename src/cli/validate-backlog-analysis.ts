/**
 * Manual REAL-PROVIDER validation of backlog analysis (Phase 4A.1) — `npm run validate:backlog`.
 * See /docs/BACKLOG_INTELLIGENCE.md "Manual real-model validation".
 *
 * It exercises the production path end to end with NO fixture engine and NO test doubles:
 *   backlog item -> enqueue (API-side service) -> DB job -> worker-side runner claims it ->
 *   ModelRegistry/selectModel -> the configured coding engine (real OpenCode) -> real model ->
 *   strict schema validation -> persisted analysis -> job SUCCEEDED/FAILED.
 * and then checks the safety invariants: no Task, no task event, no agent run, no proposal, no
 * workspace was created, and nothing was pushed or opened on GitHub (analysis has no code path to
 * either; the only network touch is a read-only tree-only clone used to list file names).
 *
 * SAFE BY DEFAULT: it works on a COPY of the database and the project-workspaces directory in a
 * temporary directory, so your real data is never modified. `--in-place` opts out (it then creates
 * the items in the real database — only do that deliberately).
 *
 * Required: a real engine/provider configuration in the environment (`.env` is loaded by the npm
 * script): CODING_ENGINE=opencode (default), OPENCODE_MODEL, and the provider credential OpenCode
 * itself holds (`opencode auth list`). Refuses to run against CODING_ENGINE=fixture — a fixture run
 * is not a real-provider validation.
 *
 * Usage:
 *   npm run validate:backlog -- --project <projectId> --title "..." --description "..." [--ref BUG-1]
 *        [--sibling "REF|Title|Description"]... [--in-place] [--json-out path]
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Args {
  project: string;
  title: string;
  description: string;
  ref: string | null;
  siblings: Array<{ ref: string; title: string; description: string }>;
  inPlace: boolean;
  jsonOut: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const siblings: Args["siblings"] = [];
  argv.forEach((a, i) => {
    if (a !== "--sibling") return;
    const [ref, title, ...rest] = (argv[i + 1] ?? "").split("|");
    if (ref && title) siblings.push({ ref, title, description: rest.join("|") || title });
  });
  const project = get("--project");
  const title = get("--title");
  const description = get("--description");
  if (!project || !title || !description) {
    console.error('usage: npm run validate:backlog -- --project <projectId> --title "..." --description "..." [--ref BUG-1] [--sibling "REF|Title|Description"] [--in-place] [--json-out file]');
    process.exit(2);
  }
  return { project, title, description, ref: get("--ref"), siblings, inPlace: argv.includes("--in-place"), jsonOut: get("--json-out") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ((process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim() === "fixture") {
    console.error("REFUSING: CODING_ENGINE=fixture is a scripted engine, so this would not be a real-provider validation. Configure a real engine (CODING_ENGINE=opencode, OPENCODE_MODEL, provider credential).");
    process.exit(2);
  }

  const srcDb = process.env.DB_PATH ?? "./.data/platform.sqlite";
  const srcProjectWorkspaces = process.env.PROJECT_WORKSPACE_ROOT ?? "./.data/project-workspaces";
  let scratch: string | null = null;
  if (!args.inPlace) {
    scratch = mkdtempSync(join(tmpdir(), "codeforge-validate-backlog-"));
    execFileSync("sqlite3", [srcDb, `.backup '${join(scratch, "platform.sqlite")}'`]);
    try {
      cpSync(srcProjectWorkspaces, join(scratch, "project-workspaces"), { recursive: true });
    } catch {
      mkdirSync(join(scratch, "project-workspaces"), { recursive: true });
    }
    process.env.DB_PATH = join(scratch, "platform.sqlite");
    process.env.WORKSPACES_ROOT = join(scratch, "workspaces");
    process.env.PROJECT_WORKSPACE_ROOT = join(scratch, "project-workspaces");
    console.log(`[validate] working on a COPY of the database in ${scratch} (your real data is untouched)`);
  } else {
    console.log("[validate] --in-place: items and analysis WILL be written to the real database");
  }

  const { buildPlatformFromEnv } = await import("../env-platform.js");
  const { buildApplicationServices } = await import("../application/index.js");
  const { toUsageDTO } = await import("../api/backlog-dto.js");
  const platform = buildPlatformFromEnv("validate-backlog");
  const services = buildApplicationServices(platform);
  const project = platform.projects.findById(args.project);
  if (!project) {
    console.error(`No project ${args.project}.`);
    process.exit(2);
  }
  const owner = project.ownerId;
  const count = (t: string) => (platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const tables = ["tasks", "task_events", "agent_runs", "workspaces", "task_proposals", "projects"] as const;
  const snapshot = () => Object.fromEntries(tables.map((t) => [t, count(t)])) as Record<(typeof tables)[number], number>;
  const before = snapshot();

  for (const s of args.siblings) services.backlog.createItem(project.id, { title: s.title, description: s.description, externalRef: s.ref }, owner);
  const item = services.backlog.createItem(project.id, { title: args.title, description: args.description, externalRef: args.ref }, owner);
  console.log(`[validate] engine=${project.codingEngine} project="${project.name}" item=${item.id}`);

  const t0 = Date.now();
  const enqueued = services.backlog.requestAnalysis(item.id, owner);
  console.log(`[validate] enqueued: job ${enqueued.job.id} ${enqueued.job.status}; API-side call took ${Date.now() - t0}ms and called no model`);
  await platform.backlogRunner.drain(); // this process plays the WORKER for the validation
  console.log(`[validate] worker finished after ${Date.now() - t0}ms`);

  const detail = services.backlog.getItem(item.id, owner);
  const a = detail.latestAnalysis;
  const j = detail.analysisJob!;
  const after = snapshot();
  const invariants = {
    "job reached a terminal state": j.status === "SUCCEEDED" || j.status === "FAILED",
    "no Task created": after.tasks === before.tasks,
    "no task events": after.task_events === before.task_events,
    "no agent runs": after.agent_runs === before.agent_runs,
    "no workspace provisioned": after.workspaces === before.workspaces,
    "no task proposal created/approved": after.task_proposals === before.task_proposals,
    "item not converted": detail.item.status !== "CONVERTED",
  };
  const report = {
    engine: project.codingEngine,
    itemStatus: detail.item.status,
    job: { status: j.status, attempts: `${j.attemptCount}/${j.maxAttempts}`, failureCategory: j.failureCategory, failureReason: j.failureReason, modelId: j.modelId, providerId: j.providerId },
    analysis: a && {
      status: a.status,
      failureCategory: a.failureCategory,
      modelId: a.modelId,
      providerId: a.providerId,
      routingReason: a.routingReason,
      durationMs: a.durationMs,
      // Reported usage and the (separate) estimated cost — null means the engine did not report it, never zero.
      ...toUsageDTO(a.cost),
      diagnostics: a.diagnostics,
      result: a.result,
      platformChecks: a.platformChecks,
    },
    relationships: detail.relationships.map((r) => ({ kind: r.relationship.kind, direction: r.direction, other: r.other.ref ?? r.other.id, confidence: r.relationship.confidence, rationale: r.relationship.rationale })),
    invariants,
    countsBefore: before,
    countsAfter: after,
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.jsonOut) writeFileSync(args.jsonOut, JSON.stringify(report, null, 2));

  const ok = Object.values(invariants).every(Boolean);
  console.log(ok ? "[validate] RESULT: safety invariants hold" : "[validate] RESULT: an invariant FAILED — see above");
  await platform.backlogRunner.stop();
  platform.db.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[validate] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
