import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UsageSummary } from "./UsageSummary.js";
import type { TaskUsageRollup } from "../../api/index.js";

const NULLS = { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

function rollup(over: Partial<TaskUsageRollup> = {}): TaskUsageRollup {
  return {
    runsCounted: 3,
    runsWithUsage: 2,
    totals: { ...NULLS, inputTokens: 7499, outputTokens: 519, reasoningTokens: 1507, cacheReadTokens: 8157 },
    providerReportedEstimate: { amount: 0.005163, currency: "USD", runsCovered: 1, runsWithoutEstimate: 1, sources: ["opencode-reported"] },
    codeforgeCalculatedCost: null,
    byPhase: {
      implementation: { runs: 1, totals: NULLS, providerReportedEstimate: null },
      fix: { runs: 0, totals: NULLS, providerReportedEstimate: null },
      review: { runs: 1, totals: NULLS, providerReportedEstimate: null },
      verification: { runs: 0, totals: NULLS, providerReportedEstimate: null },
    },
    runs: [
      { runId: "r1", role: "implementer", phase: "implementation", attemptNumber: 1, providerId: "google", modelId: "gemini-3.1-flash-lite", usage: { ...NULLS, inputTokens: 5000, outputTokens: 400 }, providerReportedEstimate: { amount: 0.005163, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null } },
      { runId: "r2", role: "reviewer", phase: "review", attemptNumber: 1, providerId: "google", modelId: "gemini-3.1-flash-lite", usage: { ...NULLS, inputTokens: 2499, outputTokens: 119 }, providerReportedEstimate: null },
      { runId: "r3", role: "implementer", phase: "fix", attemptNumber: 2, providerId: null, modelId: null, usage: null, providerReportedEstimate: null },
    ],
    ...over,
  };
}

describe("UsageSummary", () => {
  it("shows only the reported token fields (never 0 for unreported) and labels the cost as the engine's own estimate", () => {
    render(<UsageSummary usage={rollup()} />);
    expect(screen.getByText("7,499")).toBeInTheDocument();
    expect(screen.getByText("Reasoning tokens")).toBeInTheDocument();
    expect(screen.queryByText("Cache write tokens")).not.toBeInTheDocument();
    expect(screen.getByText(/Estimated cost: US\$0\.005163 — estimate reported by opencode-reported \(not provider-billed\); 1 run reported no estimate/)).toBeInTheDocument();
    expect(screen.getByText(/Reported by the coding engine for 2 of 3 agent runs/)).toBeInTheDocument();
  });

  it("lists per-run usage with role, phase, provider/model; a run without usage is omitted rather than shown as zero", () => {
    render(<UsageSummary usage={rollup()} />);
    const list = screen.getByText("Per run").closest("details")!;
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText(/Implementation · implementer attempt 1 · google\/gemini-3\.1-flash-lite/)).toBeInTheDocument();
    expect(within(list).getByText(/Review · reviewer attempt 1/)).toBeInTheDocument();
    expect(within(list).queryByText(/Fixes/)).not.toBeInTheDocument();
  });

  it("says no estimate was reported when there is none — it never invents a cost", () => {
    render(<UsageSummary usage={rollup({ providerReportedEstimate: null })} />);
    expect(screen.getByText("No cost estimate was reported.")).toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost/)).not.toBeInTheDocument();
  });

  it("renders nothing when no run reported usage (or the backend predates the roll-up)", () => {
    const { container, rerender } = render(<UsageSummary usage={rollup({ runsWithUsage: 0 })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UsageSummary usage={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels partial usage as partial (lower bounds) and marks a partial run — never as complete", () => {
    const r = rollup({ usageStatus: "partial", runs: rollup().runs.map((x, i) => (i === 0 ? { ...x, usageStatus: "partial" as const } : { ...x, usageStatus: "complete" as const })) });
    render(<UsageSummary usage={r} />);
    expect(screen.getByText(/Usage status: partial — at least one run failed or reported nothing, so totals are lower bounds/)).toBeInTheDocument();
    expect(screen.getByText(/partial \(run did not finish\)/)).toBeInTheDocument();
  });

  it("says nothing extra for complete usage, and renders nothing when usage is unavailable (never zero)", () => {
    const { rerender, container } = render(<UsageSummary usage={rollup({ usageStatus: "complete" })} />);
    expect(screen.queryByText(/Usage status/)).not.toBeInTheDocument();
    rerender(<UsageSummary usage={rollup({ usageStatus: "unavailable", runsWithUsage: 0 })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
