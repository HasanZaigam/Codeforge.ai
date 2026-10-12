import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportPanel } from "./ReportPanel.js";
import { makeReport, makeTask } from "../../test/fixtures.js";
import type { TaskUsageRollup } from "../../api/index.js";

const usage = (overrides: Partial<TaskUsageRollup>): TaskUsageRollup =>
  ({
    usageStatus: "complete",
    runsCounted: 3,
    runsWithUsage: 3,
    totals: { inputTokens: 9000, outputTokens: 3000, reasoningTokens: 300, cacheReadTokens: null, cacheWriteTokens: null },
    totalTokens: 12_300,
    runsReporting: {},
    providerReportedEstimate: null,
    codeforgeCalculatedCost: null,
    byPhase: {},
    runs: [],
    ...overrides,
  }) as unknown as TaskUsageRollup;

describe("ReportPanel — tokens on task completion and failure", () => {
  test("a completed task says how many tokens it used", () => {
    render(<ReportPanel task={makeTask({ status: "DONE" })} report={makeReport({ usage: usage({}) })} />);
    expect(screen.getByText("12.3K tokens")).toBeInTheDocument();
    expect(screen.getByText(/across 3 AI runs/)).toBeInTheDocument();
  });

  test("a failed task says it too, and admits when some runs reported nothing", () => {
    render(<ReportPanel task={makeTask({ status: "FAILED" })} report={makeReport({ usage: usage({ runsWithUsage: 2, totalTokens: 8000 }) })} />);
    expect(screen.getByText("8.0K tokens")).toBeInTheDocument();
    expect(screen.getByText(/1 run reported no usage, so the real total is higher/)).toBeInTheDocument();
  });

  test("no number is invented when the engine reported nothing", () => {
    render(<ReportPanel task={makeTask({ status: "REVIEW" })} report={makeReport({ usage: usage({ runsWithUsage: 0, totalTokens: null }) })} />);
    expect(screen.getByText(/didn't report token usage for this task's 3 AI runs/)).toBeInTheDocument();
  });
});
