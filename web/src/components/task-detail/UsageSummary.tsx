import type { TaskUsageRollup, UsageNumbers } from "../../api/index.js";
import { USAGE_STATUS_LABELS } from "../../lib/backlogLabels.js";

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
    <div className="section">
      <h2>Usage</h2>
      <p className="text-muted">
        Reported by the coding engine for {usage.runsWithUsage} of {usage.runsCounted} agent run{usage.runsCounted === 1 ? "" : "s"}.
      </p>
      {usage.usageStatus && usage.usageStatus !== "complete" && (
        <p className="field-hint" role="status">
          Usage status: {USAGE_STATUS_LABELS[usage.usageStatus]}.
        </p>
      )}
      <dl className="backlog-facts">
        {shown.map(([key, label]) => (
          <div key={key} className="usage-row">
            <dt>{label}</dt>
            <dd>{usage.totals[key]!.toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
      {est ? (
        <p>
          Estimated cost: {formatCost(est.amount, est.currency)} — estimate reported by {est.sources.join(", ")} (not provider-billed)
          {est.runsWithoutEstimate > 0 ? `; ${est.runsWithoutEstimate} run${est.runsWithoutEstimate === 1 ? "" : "s"} reported no estimate` : ""}
        </p>
      ) : (
        <p className="text-muted">No cost estimate was reported.</p>
      )}
      <details>
        <summary>Per run</summary>
        <ul className="backlog-file-list">
          {usage.runs
            .filter((r) => r.usage !== null)
            .map((r) => (
              <li key={r.runId}>
                {PHASE_LABEL[r.phase]} · {r.role} attempt {r.attemptNumber}
                {r.usageStatus === "partial" ? " · partial (run did not finish)" : ""}
                {r.modelId ? ` · ${r.providerId ?? "unknown"}/${r.modelId}` : ""}
                <span className="field-hint">
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
  );
}
