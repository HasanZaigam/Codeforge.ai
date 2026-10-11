import type { CostMetadata } from "../domain/types.js";

export interface ProviderUsageTotals {
  providerId: string;
  /** Runs that reported at least one token field for this provider. */
  runsWithUsage: number;
  runsTotal: number;
  /** `null` means no run under this provider reported this field — never a fabricated `0`, same honesty rule as reporting/usage-rollup.ts. */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * Model Gateway — Settings "AI Usage" (see docs/MODEL_GATEWAY.md). Groups every AgentRun this user's
 * projects have produced by `providerId` and sums reported token fields, following the SAME honesty
 * rules as the existing task-level `reporting/usage-rollup.ts`: a field stays `null` (never `0`) when
 * no run under that provider reported it, and a run with `providerId: null` (no routing was wired for
 * it — pre-Model-Gateway rows, or a `FixtureCodingEngine` test run) is grouped under `"unknown"`
 * rather than silently dropped.
 */
export function buildProviderUsageRollup(rows: Array<{ providerId: string | null; modelId: string | null; cost: CostMetadata | null }>): ProviderUsageTotals[] {
  const byProvider = new Map<string, { runsWithUsage: number; runsTotal: number; input: number | null; output: number | null }>();

  for (const row of rows) {
    const providerId = row.providerId ?? "unknown";
    const entry = byProvider.get(providerId) ?? { runsWithUsage: 0, runsTotal: 0, input: null, output: null };
    entry.runsTotal++;
    const input = row.cost?.inputTokens;
    const output = row.cost?.outputTokens;
    if (typeof input === "number" || typeof output === "number") entry.runsWithUsage++;
    if (typeof input === "number") entry.input = (entry.input ?? 0) + input;
    if (typeof output === "number") entry.output = (entry.output ?? 0) + output;
    byProvider.set(providerId, entry);
  }

  return [...byProvider.entries()]
    .map(([providerId, e]) => ({
      providerId,
      runsWithUsage: e.runsWithUsage,
      runsTotal: e.runsTotal,
      inputTokens: e.input,
      outputTokens: e.output,
      totalTokens: e.input !== null || e.output !== null ? (e.input ?? 0) + (e.output ?? 0) : null,
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}
