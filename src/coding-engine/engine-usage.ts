import type { CostMetadata } from "../domain/types.js";

/**
 * Normalizes per-step usage reported by a coding engine into `CostMetadata` (see domain/types.ts) —
 * the ONE place raw provider usage becomes the platform's provider-agnostic shape. An engine adapter
 * (today OpenCode) parses its own event format and feeds each step's raw numbers here; nothing
 * downstream ever sees a vendor field name.
 *
 * Honesty rules (GAP-031, Phase 4A.2):
 *  - a field the engine did not report stays ABSENT — never `0`;
 *  - a value that is not a finite, non-negative number is ignored (never coerced);
 *  - counts are summed across steps only over the steps that reported them;
 *  - an estimated cost is recorded only when the engine reported a POSITIVE figure. A reported cost of
 *    `0` next to non-zero token counts means "no price known for this model" (engines report 0 for a
 *    model they have no price for), not "this was free" — recording it as a real $0 would be a
 *    fabricated fact, so it is treated as unavailable.
 */
export interface StepUsageInput {
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown } | null;
  } | null;
  cost?: unknown;
}

const asCount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isInteger(v) ? v : null);
const asAmount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export class UsageAccumulator {
  private input: number | null = null;
  private output: number | null = null;
  private reasoning: number | null = null;
  private cacheRead: number | null = null;
  private cacheWrite: number | null = null;
  private cost: number | null = null;

  constructor(private readonly costSource: { currency: string; pricingSource: string; pricingVersion: string | null }) {}

  addStep(step: StepUsageInput): void {
    const t = step.tokens ?? {};
    this.input = addIf(this.input, asCount(t.input));
    this.output = addIf(this.output, asCount(t.output));
    this.reasoning = addIf(this.reasoning, asCount(t.reasoning));
    this.cacheRead = addIf(this.cacheRead, asCount(t.cache?.read));
    this.cacheWrite = addIf(this.cacheWrite, asCount(t.cache?.write));
    this.cost = addIf(this.cost, asAmount(step.cost));
  }

  /**
   * Adds every `step_finish` event found in raw OpenCode NDJSON output — used for an invocation that did NOT
   * complete normally (timeout, cancellation, non-zero exit), whose output is never parsed as a result but whose
   * usage events were really emitted (and billed).
   */
  addStdout(stdout: string): void {
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{") || !t.endsWith("}")) continue;
      try {
        const rec = JSON.parse(t) as { type?: string; part?: { type?: string; tokens?: StepUsageInput["tokens"]; cost?: unknown } };
        if ((rec.type === "step_finish" || rec.type === "step-finish") && rec.part?.type === "step-finish") this.addStep({ tokens: rec.part.tokens, cost: rec.part.cost });
      } catch {
        // a truncated final line (process killed mid-write) is simply not usage
      }
    }
  }

  /** `null` when nothing at all was reported (so callers can tell "no usage data" from "zero usage"). `status` labels the result — see CostMetadata.usageStatus. */
  toCostMetadata(status?: "complete" | "partial"): CostMetadata | null {
    const out: CostMetadata = {};
    if (this.input !== null) out.inputTokens = this.input;
    if (this.output !== null) out.outputTokens = this.output;
    if (this.reasoning !== null) out.reasoningTokens = this.reasoning;
    if (this.cacheRead !== null) out.cacheReadTokens = this.cacheRead;
    if (this.cacheWrite !== null) out.cacheWriteTokens = this.cacheWrite;
    if (this.cost !== null && this.cost > 0) {
      out.estimatedCost = { amount: this.cost, currency: this.costSource.currency, pricingSource: this.costSource.pricingSource, pricingVersion: this.costSource.pricingVersion };
    }
    if (Object.keys(out).length === 0) return null; // nothing reported ⇒ unavailable, never a zero-filled record
    return status ? { usageStatus: status, ...out } : out;
  }
}

/** Sums two usage records field by field (only fields either reported); the result is `partial` unless both are complete. `null` + `null` = `null`. */
export function mergeCostMetadata(a: CostMetadata | null, b: CostMetadata | null): CostMetadata | null {
  if (!a) return b;
  if (!b) return a;
  const out: CostMetadata = {};
  for (const f of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (a[f] !== undefined || b[f] !== undefined) out[f] = (a[f] ?? 0) + (b[f] ?? 0);
  }
  if (a.estimatedCost && b.estimatedCost && a.estimatedCost.currency === b.estimatedCost.currency && a.estimatedCost.pricingSource === b.estimatedCost.pricingSource) {
    out.estimatedCost = { ...a.estimatedCost, amount: a.estimatedCost.amount + b.estimatedCost.amount };
  }
  // (If only one side has a price, or they differ in currency/source, NO estimate is carried: a sum would be a fabricated total.)
  out.usageStatus = a.usageStatus === "complete" && b.usageStatus === "complete" ? "complete" : "partial";
  return { usageStatus: out.usageStatus, ...out };
}

function addIf(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}
