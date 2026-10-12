import type { TaskUsageRollup, UsageNumbers } from "../../api/index.js";
import { USAGE_STATUS_LABELS } from "../../lib/backlogLabels.js";
import { Section } from "../common/Section.js";

const ROWS: Array<[keyof UsageNumbers, string]> = [
  ["inputTokens", "Input tokens"],
  ["outputTokens", "Output tokens"],
  ["reasoningTokens", "Reasoning tokens"],
  ["cacheReadTokens", "Cache read tokens"],
  ["cacheWriteTokens", "Cache write tokens"],
];

const PHASE_LABEL = { implementation: "Implementation", fix: "Fixes", review: "Review", verification: "Review follow-up (after a check)" } as const;

function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * Task-level usage from the AgentRuns the platform recorded, each counted once. Shows ONLY what engines
 * reported: a field nobody reported is omitted (never "0"), and the cost is labelled as the engine's own
 * estimate — CodeForge calculates no cost itself. Renders nothing when no run reported any usage.
 */
export function UsageSummary({ usage }: { usage: TaskUsageRollup | undefined }) {
  if (!usage || usage.runsWithUsage === 0) return null;
  const est = usage.providerReportedEstimate;
  const shown = ROWS.filter(([key]) => usage.totals[key] !== null);
  return (
    <Section
      title="Usage"
      description={
        <>
          Reported by the coding engine for {usage.runsWithUsage} of {usage.runsCounted} agent run{usage.runsCounted === 1 ? "" : "s"}.
        </>
      }
    >
      <div className="space-y-3 text-sm">
      {usage.usageStatus && usage.usageStatus !== "complete" && (
        <p className="text-sm text-muted-foreground" role="status">
          Usage status: {USAGE_STATUS_LABELS[usage.usageStatus]}.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map(([key, label]) => (
          <div key={key} className="rounded-2xl bg-muted/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{usage.totals[key]!.toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
      {est ? (
        <p>
          Estimated cost: {formatCost(est.amount, est.currency)} — estimate reported by {est.sources.join(", ")} (not provider-billed)
          {est.runsWithoutEstimate > 0 ? `; ${est.runsWithoutEstimate} run${est.runsWithoutEstimate === 1 ? "" : "s"} reported no estimate` : ""}
        </p>
      ) : (
        <p className="text-muted-foreground">No cost estimate was reported.</p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">Per run</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs">
          {usage.runs
            .filter((r) => r.usage !== null)
            .map((r) => (
              <li key={r.runId}>
                {PHASE_LABEL[r.phase]} · {r.role} attempt {r.attemptNumber}
                {r.usageStatus === "partial" ? " · partial (run did not finish)" : ""}
                {r.modelId ? ` · ${r.providerId ?? "unknown"}/${r.modelId}` : ""}
                <span className="text-muted-foreground">
                  {" "}
                  {ROWS.filter(([key]) => r.usage![key] !== null)
                    .map(([key, label]) => `${label.replace(" tokens", "")} ${r.usage![key]!.toLocaleString("en-US")}`)
                    .join(" · ")}
                  {r.providerReportedEstimate ? ` · ${formatCost(r.providerReportedEstimate.amount, r.providerReportedEstimate.currency)}` : ""}
                </span>
              </li>
            ))}
        </ul>
      </details>
      </div>
    </Section>
  );
}
