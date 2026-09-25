import type { AgentRun, CostMetadata, EstimatedCost } from "../domain/types.js";
import { deriveTrigger, type AgentRunTrigger } from "./execution-history.js";

/**
 * Task-level usage roll-up (GAP-031, Phase 4A.3): Task -> AgentRuns -> normalized usage -> totals.
 *
 * Three concepts are kept apart on purpose (they will differ under BYOK / other providers):
 *  1. RAW USAGE — token counts exactly as the engine reported them (`CostMetadata`).
 *  2. PROVIDER-REPORTED ESTIMATE — a cost figure the engine/provider supplied. Preserved and labelled with
 *     its source; never presented as a billed amount.
 *  3. CODEFORGE-CALCULATED COST — would require an explicit pricing source + version. CodeForge has no price
 *     table today, so this is ALWAYS `null` (never a computed guess, never 0).
 *
 * Honesty rules (all covered by tests/usage-rollup.test.ts):
 *  - `null` means "no run reported this" — never `0`. A total is the sum over ONLY the runs that reported
 *    that field, and `runsReporting` says how many that was, so a partial total is never mistaken for a
 *    complete one.
 *  - Each AgentRun is counted EXACTLY ONCE (one row = one engine invocation), so retries and fallbacks are
 *    included once each and never double-counted.
 *  - No rounding: counts are integers; cost amounts are summed as reported.
 *  - Estimates in different currencies are never added together (the total is then `null`).
 */

export type UsageField = "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens";
const FIELDS: UsageField[] = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"];

export type UsageNumbers = Record<UsageField, number | null>;

/** Which stage of the task a run belongs to — so review, fix and first-pass model calls can be told apart. */
export type UsagePhase = "implementation" | "fix" | "review" | "verification";

const PHASE_BY_TRIGGER: Record<AgentRunTrigger, UsagePhase> = {
  initial: "implementation",
  self_fix_retry: "fix",
  ai_review_fix: "fix",
  human_review_fix: "fix",
  review: "review",
  review_verification: "verification",
};

/**
 * How much of a run's / task's real consumption the recorded usage represents (GAP-034):
 * `complete` — the invocation finished and all emitted usage was captured; `partial` — usage was captured but the
 * invocation ended abnormally (or some run has none), so the figure is a LOWER BOUND; `unavailable` — nothing was
 * captured (never shown as zero).
 */
export type UsageStatus = "complete" | "partial" | "unavailable";

export interface RunUsage {
  runId: string;
  role: AgentRun["role"];
  trigger: AgentRunTrigger;
  phase: UsagePhase;
  attemptNumber: number;
  status: AgentRun["status"];
  providerId: string | null;
  modelId: string | null;
  /** `null` when the engine reported no token usage for this run at all. */
  usage: UsageNumbers | null;
  usageStatus: UsageStatus;
  providerReportedEstimate: EstimatedCost | null;
}

export interface ProviderReportedEstimateTotal {
  amount: number;
  currency: string;
  /** Runs that contributed an estimate / runs that did not — so a partial total is visible as partial. */
  runsCovered: number;
  runsWithoutEstimate: number;
  /** Who computed the figures (e.g. "opencode-reported") — an engine estimate, NOT a provider invoice. */
  sources: string[];
}

export interface PhaseUsage {
  runs: number;
  totals: UsageNumbers;
  providerReportedEstimate: ProviderReportedEstimateTotal | null;
}

export interface TaskUsageRollup {
  /** `complete` only if EVERY run's usage is complete; `unavailable` if no run has any; otherwise `partial` (totals are lower bounds). */
  usageStatus: UsageStatus;
  /** Every AgentRun of the task, counted exactly once. */
  runsCounted: number;
  /** Runs that reported at least one token field. */
  runsWithUsage: number;
  totals: UsageNumbers;
  /** How many runs reported each field (a total over 2 of 5 runs is a partial total). */
  runsReporting: Record<UsageField, number>;
  providerReportedEstimate: ProviderReportedEstimateTotal | null;
  /** Always `null` until CodeForge has an explicit, versioned pricing source (see the file header). */
  codeforgeCalculatedCost: null;
  byPhase: Record<UsagePhase, PhaseUsage>;
  runs: RunUsage[];
}

const nullTotals = (): UsageNumbers => ({ inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null });

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The provider-reported estimate for one run: the normalized field, or the legacy Claude Code `costUsd` (engine-reported, positive only). */
export function estimateOf(cost: CostMetadata | null): EstimatedCost | null {
  if (!cost) return null;
  if (cost.estimatedCost && isCount(cost.estimatedCost.amount)) return cost.estimatedCost;
  if (isCount(cost.costUsd) && cost.costUsd > 0) return { amount: cost.costUsd, currency: "USD", pricingSource: "engine-reported", pricingVersion: null };
  return null;
}

function usageOf(cost: CostMetadata | null): UsageNumbers | null {
  if (!cost) return null;
  const out = nullTotals();
  let any = false;
  for (const f of FIELDS) {
    const v = cost[f];
    if (isCount(v)) {
      out[f] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function statusOf(run: AgentRun): UsageStatus {
  if (!usageOf(run.cost)) return "unavailable";
  // Rows written before `usageStatus` existed: a completed run's figures were the finished run's; anything else is a lower bound.
  return run.cost?.usageStatus ?? (run.status === "completed" ? "complete" : "partial");
}

function sumUsage(runs: RunUsage[]): { totals: UsageNumbers; reporting: Record<UsageField, number> } {
  const totals = nullTotals();
  const reporting: Record<UsageField, number> = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const r of runs) {
    if (!r.usage) continue;
    for (const f of FIELDS) {
      const v = r.usage[f];
      if (v === null) continue;
      totals[f] = (totals[f] ?? 0) + v;
      reporting[f]++;
    }
  }
  return { totals, reporting };
}

function sumEstimates(runs: RunUsage[]): ProviderReportedEstimateTotal | null {
  const withEstimate = runs.filter((r) => r.providerReportedEstimate !== null);
  if (withEstimate.length === 0) return null;
  const currencies = new Set(withEstimate.map((r) => r.providerReportedEstimate!.currency));
  if (currencies.size > 1) return null; // never add across currencies
  return {
    amount: withEstimate.reduce((total, r) => total + r.providerReportedEstimate!.amount, 0),
    currency: [...currencies][0]!,
    runsCovered: withEstimate.length,
    runsWithoutEstimate: runs.length - withEstimate.length,
    sources: [...new Set(withEstimate.map((r) => r.providerReportedEstimate!.pricingSource))].sort(),
  };
}

export function rollupUsage(agentRuns: AgentRun[]): TaskUsageRollup {
  // One AgentRun row is one engine invocation: iterate the rows once and never merge or re-add them.
  const runs: RunUsage[] = agentRuns.map((run) => {
    const trigger = deriveTrigger(run);
    return {
      runId: run.id,
      role: run.role,
      trigger,
      phase: PHASE_BY_TRIGGER[trigger],
      attemptNumber: run.attemptNumber,
      status: run.status,
      providerId: run.providerId,
      modelId: run.modelId,
      usage: usageOf(run.cost),
      usageStatus: statusOf(run),
      providerReportedEstimate: estimateOf(run.cost),
    };
  });
  const { totals, reporting } = sumUsage(runs);
  const phase = (p: UsagePhase): PhaseUsage => {
    const inPhase = runs.filter((r) => r.phase === p);
    return { runs: inPhase.length, totals: sumUsage(inPhase).totals, providerReportedEstimate: sumEstimates(inPhase) };
  };
  const taskStatus: UsageStatus =
    runs.length === 0 || runs.every((r) => r.usageStatus === "unavailable") ? "unavailable" : runs.every((r) => r.usageStatus === "complete") ? "complete" : "partial";
  return {
    usageStatus: taskStatus,
    runsCounted: runs.length,
    runsWithUsage: runs.filter((r) => r.usage !== null).length,
    totals,
    runsReporting: reporting,
    providerReportedEstimate: sumEstimates(runs),
    codeforgeCalculatedCost: null,
    byPhase: { implementation: phase("implementation"), fix: phase("fix"), review: phase("review"), verification: phase("verification") },
    runs,
  };
}
