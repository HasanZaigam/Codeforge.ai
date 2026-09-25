/**
 * Manual REAL-PROVIDER validation of task usage capture and roll-up (GAP-031, Phase 4A.3) —
 * `npm run validate:task-usage`. See /docs/BACKLOG_INTELLIGENCE.md "Usage and cost".
 *
 * It runs ONE real CodeForge task through the production execution path — orchestrator, real OpenCode
 * engine, real model, validation, independent review — with NO fixture engine, and then reconciles three
 * independent sources of the same numbers:
 *
 *   1. RAW OPENCODE USAGE      the `step_finish` events OpenCode itself wrote to stdout, captured by a thin
 *                              `tee` wrapper around the real binary (so the raw source does not pass through
 *                              CodeForge's own parser) and re-summed here by an independent minimal parser.
 *   2. PERSISTED AGENTRUN      `agent_runs.cost_json` as CodeForge stored it, read straight from SQLite.
 *   3. TASK REPORT ROLL-UP     `TaskService.getReport(...).usage`, the figures the API/UI show.
 *
 * SAFE BY DEFAULT: everything happens in a temporary directory — a throwaway database, a throwaway local git
 * repository (a two-line `add()` bug fixture) and workspaces. Nothing is pushed anywhere, no Pull Request is
 * opened, and your real database is not touched. The only outward call is to the model provider OpenCode is
 * configured with, so it costs a few cents.
 *
 * Required: CODING_ENGINE=opencode (default), OPENCODE_MODEL, and a provider credential OpenCode holds
 * (`opencode auth list`). Refuses CODING_ENGINE=fixture — a fixture run is not a real-provider validation.
 *
 * With `--failure-scenario` it ALSO runs a second real task whose engine invocation is given a deliberately short
 * timeout, so OpenCode is killed after (usually) emitting usage — GAP-034 — and reconciles the same three sources
 * for the FAILED run: raw events emitted before the kill vs the persisted failed AgentRun vs the task report (which
 * must show the usage as `partial`, or `unavailable` — never zero — if the kill came before any step finished).
 *
 * Usage: npm run validate:task-usage -- [--json-out path] [--failure-scenario]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface RawUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
  steps: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

/** Independent of CodeForge's UsageAccumulator on purpose: a second, minimal reading of OpenCode's own events. */
function parseRawSegment(text: string): RawUsage {
  const out: RawUsage = { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null, steps: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; part?: { tokens?: Record<string, unknown> & { cache?: Record<string, unknown> }; cost?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "step_finish") continue;
    const t = event.part?.tokens ?? {};
    out.steps++;
    out.inputTokens = add(out.inputTokens, num(t.input));
    out.outputTokens = add(out.outputTokens, num(t.output));
    out.reasoningTokens = add(out.reasoningTokens, num(t.reasoning));
    out.cacheReadTokens = add(out.cacheReadTokens, num(t.cache?.read));
    out.cacheWriteTokens = add(out.cacheWriteTokens, num(t.cache?.write));
    out.cost = add(out.cost, num(event.part?.cost));
  }
  return out;
}

/**
 * GAP-034 against the REAL engine: an invocation killed by its timeout after emitting usage. Tries increasing
 * timeouts until the kill lands after at least one `step_finish` (the model's first step takes a few seconds).
 */
async function failureScenario(ctx: { scratch: string; rawLog: string; jsonOut: string | null; parseRawSegment: (t: string) => RawUsage }): Promise<boolean> {
  const { buildPlatform } = await import("../platform.js");
  const { buildApplicationServices } = await import("../application/index.js");
  const { OpenCodeAdapter } = await import("../coding-engine/opencode-adapter.js");
  const { createFixtureRepo } = await import("./fixture-repo.js");
  const { createTask } = await import("../orchestrator/task-factory.js");
  const attempts: unknown[] = [];
  for (const timeoutMs of [15_000, 30_000]) {
    const dir = join(ctx.scratch, `failure-${timeoutMs}`);
    mkdirSync(dir, { recursive: true });
    const before = readFileSync(ctx.rawLog, "utf8").length;
    const engine = new OpenCodeAdapter({ maxRetries: 0 });
    const platform = buildPlatform({
      dbPath: join(dir, "platform.sqlite"),
      workspacesRoot: join(dir, "workspaces"),
      engine,
      ownerId: "validate-failure",
      // No infrastructure retry: the first timeout fails the task, so exactly one failed AgentRun exists to reconcile.
      orchestratorConfig: { agentInvocationTimeoutMs: timeoutMs, maxInfrastructureRetries: 0 },
    });
    const services = buildApplicationServices(platform);
    const repoPath = await createFixtureRepo(dir);
    const user = { id: randomUUID(), tenantId: "default", email: `f-${randomUUID().slice(0, 6)}@example.com`, name: "V", passwordHash: "", createdAt: new Date().toISOString() };
    platform.users.insert(user);
    const project = await services.projects.create({ name: "Failure usage fixture", sourceControlProvider: "local-git", repoUrl: repoPath, codingEngine: engine.key, commands: { test: "node test.js" } }, user.id);
    const task = createTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Fix add()", goal: "add(2, 3) returns -1 instead of 5 in add.js. Fix the function so `node test.js` passes. Change nothing else.", createdBy: user.id });
    platform.tasks.releaseFromBacklog(task.id, new Date().toISOString());
    console.log(`[validate] failure scenario: real task with a ${timeoutMs}ms invocation timeout…`);
    const finished = await platform.orchestrator.executeTask(task.id);

    const segments = readFileSync(ctx.rawLog, "utf8").slice(before).split(/^##INVOCATION .*$/m).slice(1).map(ctx.parseRawSegment);
    const rows = platform.db.prepare("SELECT id, role, status, error, cost_json FROM agent_runs WHERE task_id = ? ORDER BY started_at ASC").all(task.id) as Array<{ id: string; role: string; status: string; error: string | null; cost_json: string | null }>;
    const report = services.tasks.getReport(task.id, user.id);
    const failed = rows.find((r) => r.status === "failed");
    const persisted = failed?.cost_json ? (JSON.parse(failed.cost_json) as Record<string, unknown>) : null;
    const raw = segments[0] ?? null;
    const rawHasUsage = !!raw && raw.steps > 0;
    const fields = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
    const comparison = fields.map((f) => ({ field: f, raw: raw?.[f] ?? null, persisted: (persisted?.[f] as number | undefined) ?? null, report: report.usage.totals[f] }));
    const rawCost = raw?.cost ?? null;
    const persistedCost = (persisted?.estimatedCost as { amount: number } | undefined)?.amount ?? null;
    const reconciledFields = comparison.every((c) => c.raw === c.persisted && c.persisted === c.report);
    const costOk = rawCost === persistedCost || (rawCost === 0 && persistedCost === null);
    const statusOk = rawHasUsage ? persisted?.usageStatus === "partial" && report.usage.usageStatus !== "complete" : persisted === null && report.usage.usageStatus === "unavailable";
    const result = {
      timeoutMs,
      taskStatus: finished.status,
      agentRuns: rows.map((r) => ({ role: r.role, status: r.status, error: (r.error ?? "").slice(0, 120) })),
      rawStepFinishEventsBeforeKill: raw?.steps ?? 0,
      persistedFailedRunCost: persisted,
      reportUsageStatus: report.usage.usageStatus,
      comparison,
      cost: { raw: rawCost, persisted: persistedCost, providerReportedEstimateInReport: report.usage.providerReportedEstimate },
      reconciled: reconciledFields && costOk && statusOk && !!failed,
      outcome: !failed ? "no failed run (the model finished inside the timeout)" : rawHasUsage ? "usage emitted before the kill was persisted as partial" : "killed before any usage: recorded as unavailable (null), not zero",
    };
    attempts.push(result);
    console.log(JSON.stringify(result, null, 2));
    platform.db.close();
    if (failed) {
      if (ctx.jsonOut) writeFileSync(ctx.jsonOut, JSON.stringify({ attempts }, null, 2));
      console.log(result.reconciled ? "[validate] FAILURE SCENARIO RESULT: failed-run usage reconciles (raw == persisted == report), labelled correctly" : "[validate] FAILURE SCENARIO RESULT: MISMATCH — see above");
      if (rawHasUsage || timeoutMs === 30_000) return result.reconciled;
    }
  }
  if (ctx.jsonOut) writeFileSync(ctx.jsonOut, JSON.stringify({ attempts }, null, 2));
  console.log("[validate] FAILURE SCENARIO RESULT: could not induce a failed run with usage in the attempted timeouts");
  return false;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json-out") ? argv[argv.indexOf("--json-out") + 1] : null;

  if ((process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim() === "fixture") {
    console.error("REFUSING: CODING_ENGINE=fixture is a scripted engine, so this would not be a real-provider validation.");
    process.exit(2);
  }

  const scratch = mkdtempSync(join(tmpdir(), "codeforge-validate-usage-"));
  process.env.DB_PATH = join(scratch, "platform.sqlite");
  process.env.WORKSPACES_ROOT = join(scratch, "workspaces");
  process.env.PROJECT_WORKSPACE_ROOT = join(scratch, "project-workspaces");

  // A pass-through wrapper: one marker line per invocation, then the real binary's stdout, tee'd to a file.
  // (The adapter sanitizes the environment, so the log path is written into the script, not passed as a variable.)
  const realBinary = process.env.OPENCODE_BIN_PATH ?? execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
  const rawLog = join(scratch, "opencode-raw.log");
  const wrapper = join(scratch, "opencode-tee.sh");
  writeFileSync(rawLog, "");
  // `exec` (not a pipeline) so a timeout/cancel kill signal reaches OpenCode itself, never an orphaned grandchild.
  writeFileSync(wrapper, `#!/bin/bash\necho "##INVOCATION $(date +%s)" >> "${rawLog}"\nexec "${realBinary}" "$@" > >(tee -a "${rawLog}")\n`);
  chmodSync(wrapper, 0o755);
  process.env.OPENCODE_BIN_PATH = wrapper;

  const { buildPlatformFromEnv } = await import("../env-platform.js");
  const { buildApplicationServices } = await import("../application/index.js");
  const { createFixtureRepo } = await import("./fixture-repo.js");
  const { createTask } = await import("../orchestrator/task-factory.js");
  const platform = buildPlatformFromEnv("validate-task-usage");
  const services = buildApplicationServices(platform);

  const repoPath = await createFixtureRepo(scratch);
  const user = { id: randomUUID(), tenantId: "default", email: `validate-${randomUUID().slice(0, 6)}@example.com`, name: "Validator", passwordHash: "", createdAt: new Date().toISOString() };
  platform.users.insert(user);
  const project = await services.projects.create(
    { name: "Usage validation fixture", sourceControlProvider: "local-git", repoUrl: repoPath, codingEngine: (process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim(), commands: { test: "node test.js" } },
    user.id,
  );
  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add(2, 3) returns -1 instead of 5 in add.js. Fix the function so `node test.js` passes. Change nothing else.",
    createdBy: user.id,
  });
  if (!platform.tasks.releaseFromBacklog(task.id, new Date().toISOString())) throw new Error("could not release the task from BACKLOG");

  console.log(`[validate] engine=${project.codingEngine} task=${task.id}; running for real (this calls the model)…`);
  const started = Date.now();
  const finished = await platform.orchestrator.executeTask(task.id);
  console.log(`[validate] task finished as ${finished.status} after ${Math.round((Date.now() - started) / 1000)}s`);

  // 1. raw
  const rawSegments = readFileSync(rawLog, "utf8").split(/^##INVOCATION .*$/m).slice(1).map(parseRawSegment);
  // 2. persisted
  const rows = platform.db.prepare("SELECT id, role, attempt_number, status, model_id, provider_id, cost_json, started_at FROM agent_runs WHERE task_id = ? ORDER BY started_at ASC").all(task.id) as Array<{ id: string; role: string; attempt_number: number; status: string; model_id: string | null; provider_id: string | null; cost_json: string | null }>;
  const persisted = rows.map((r) => ({ ...r, cost: r.cost_json ? (JSON.parse(r.cost_json) as Record<string, unknown> & { estimatedCost?: { amount: number; currency: string; pricingSource: string } }) : null }));
  // 3. report
  const report = services.tasks.getReport(task.id, user.id);

  const FIELDS = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  const perRun = persisted.map((p, i) => {
    const raw = rawSegments[i] ?? null;
    const fields = FIELDS.map((f) => ({ field: f, raw: raw?.[f] ?? null, persisted: (p.cost?.[f] as number | undefined) ?? null, match: (raw?.[f] ?? null) === ((p.cost?.[f] as number | undefined) ?? null) }));
    const rawCost = raw?.cost ?? null;
    const persistedCost = p.cost?.estimatedCost?.amount ?? null;
    // OpenCode reports `cost: 0` for a model it has no price for; CodeForge deliberately records that as "no estimate".
    const costMatch = rawCost === persistedCost || (rawCost === 0 && persistedCost === null);
    return { runId: p.id, role: p.role, attempt: p.attempt_number, status: p.status, providerId: p.provider_id, modelId: p.model_id, rawSteps: raw?.steps ?? null, fields, rawCost, persistedCost, persistedEstimateSource: p.cost?.estimatedCost?.pricingSource ?? null, costMatch };
  });
  const sum = (pick: (r: (typeof perRun)[number]) => number | null): number | null => perRun.reduce<number | null>((t, r) => add(t, pick(r)), null);
  const totals = FIELDS.map((f) => {
    const raw = rawSegments.reduce<number | null>((t, s) => add(t, s[f]), null);
    const persistedSum = sum((r) => r.fields.find((x) => x.field === f)!.persisted);
    const rolled = report.usage.totals[f];
    return { field: f, raw, persisted: persistedSum, report: rolled, reconciled: raw === persistedSum && persistedSum === rolled };
  });
  const rawCostTotal = rawSegments.reduce<number | null>((t, s) => add(t, s.cost), null);
  const reportCost = report.usage.providerReportedEstimate?.amount ?? null;
  const costReconciled = (rawCostTotal === reportCost || (rawCostTotal === 0 && reportCost === null)) && Math.abs((sum((r) => r.persistedCost) ?? 0) - (reportCost ?? 0)) < 1e-12;

  const result = {
    engine: project.codingEngine,
    taskStatus: finished.status,
    invocations: { rawSegments: rawSegments.length, agentRuns: rows.length, reportRunsCounted: report.usage.runsCounted },
    perRun,
    totals,
    cost: { rawOpenCodeSum: rawCostTotal, persistedSum: sum((r) => r.persistedCost), reportProviderReportedEstimate: report.usage.providerReportedEstimate, codeforgeCalculatedCost: report.usage.codeforgeCalculatedCost, reconciled: costReconciled },
    reportByPhase: report.usage.byPhase,
    reportRuns: report.usage.runs.map((r) => ({ role: r.role, phase: r.phase, provider: r.providerId, model: r.modelId })),
  };
  const reconciled = rows.length === rawSegments.length && report.usage.runsCounted === rows.length && perRun.every((r) => r.fields.every((f) => f.match) && r.costMatch) && totals.every((t) => t.reconciled) && costReconciled;
  console.log(JSON.stringify(result, null, 2));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  console.log(reconciled ? "[validate] RESULT: raw OpenCode usage == persisted AgentRun usage == task report totals" : "[validate] RESULT: MISMATCH — see above (an unreconciled figure is a finding, not to be papered over)");

  platform.db.close();

  let failureOk = true;
  if (argv.includes("--failure-scenario")) {
    failureOk = await failureScenario({ scratch, rawLog, jsonOut: jsonOut ? `${jsonOut}.failure.json` : null, parseRawSegment });
  }
  rmSync(scratch, { recursive: true, force: true });
  process.exit(reconciled && failureOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[validate] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
