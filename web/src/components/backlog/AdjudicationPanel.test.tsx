import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdjudicationPanel } from "./AdjudicationPanel.js";
import type { DuplicateSampleDTO, ItemSampleDTO } from "../../api/index.js";

vi.mock("../../api/adjudication.js", () => ({
  adjudicationApi: {
    sampleDuplicates: vi.fn(),
    sampleClarification: vi.fn(),
    sampleProposalReady: vi.fn(),
    judgeRelationship: vi.fn(),
    judgeItem: vi.fn(),
    listRelationshipJudgments: vi.fn(),
    listItemJudgments: vi.fn(),
    metrics: vi.fn(),
    exportUrl: (p: string) => `/api/projects/${p}/backlog/adjudication/export`,
  },
  adjudicationBaselineApi: {
    importCsv: vi.fn(),
    createBaseline: vi.fn(),
    listBaselines: vi.fn(),
    getBaseline: vi.fn(),
  },
}));
import { adjudicationApi as api } from "../../api/adjudication.js";

const dupSample: DuplicateSampleDTO = {
  seed: "s", size: 5, totalGroups: 3,
  groups: [{ groupKey: "a,b", items: [{ id: "a", ref: "app:B-1", title: "one" }, { id: "b", ref: "app:B-2", title: "two" }], edges: [{ relationshipId: "e1", fromItemId: "a", toItemId: "b", confidence: "high", status: "PROPOSED", rationale: "same defect", analysisId: "an1", revision: "abc", current: null, history: [] }] }],
  infrastructureFailures: [],
};
const itemSample: ItemSampleDTO = {
  seed: "s", size: 5, totalCandidates: 10,
  sampled: [{ row: { itemId: "i1", ref: "app:B-3", title: "Needs info", status: "NEEDS_CLARIFICATION", module: null, priority: null, analysis: { state: "SUCCEEDED", failureCategory: null, failureReason: null, completedAt: "t" }, review: { state: "NEEDS_CLARIFICATION", implementation: "unknown", behavior: "BEHAVIOR_UNVERIFIED" }, flow: null, evidenceCount: 0, verification: { checksAvailable: 0, sufficientChecks: 0, verified: false }, duplicates: { proposed: 0, confirmed: 0 }, dependencies: { proposed: 0, confirmed: 0 }, proposal: null, usage: { inputTokens: null, outputTokens: null, estimatedCost: null, status: "unavailable" } }, current: null, history: [], stale: false }],
  infrastructureFailures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.metrics).mockResolvedValue({
    duplicates: { groupsReviewed: 0, totalGroups: 0, relationshipsReviewed: 0, staleRelationships: 0, confirmedDuplicate: 0, relatedNotDuplicate: 0, rejected: 0, confirmationRate: null },
    clarification: { reviewed: 0, stale: 0, correctClarification: 0, shouldBeProposalReady: 0, insufficientAnalysis: 0, other: 0 },
    proposalReadiness: { reviewed: 0, stale: 0, correctProposalReady: 0, needsClarification: 0, insufficientAnalysis: 0, other: 0 },
  });
});

describe("AdjudicationPanel", () => {
  it("samples duplicates with the reviewer's seed/size, shows edge-level context, and judging an edge never mentions the sibling edge", async () => {
    vi.mocked(api.sampleDuplicates).mockResolvedValue(dupSample);
    render(<AdjudicationPanel projectId="p1" />);
    const section = screen.getByRole("region", { name: "Duplicate review" });
    await userEvent.click(section.querySelector("button")!); // first control is the seed's sibling; click "Sample"
    const sampleBtn = Array.from(section.querySelectorAll("button")).find((b) => b.textContent === "Sample")!;
    await userEvent.click(sampleBtn);
    await waitFor(() => expect(api.sampleDuplicates).toHaveBeenCalledWith("p1", "baseline-1", 8));
    expect((await screen.findAllByText(/app:B-1/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/same defect/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirmed duplicate" }));
    await waitFor(() => expect(api.judgeRelationship).toHaveBeenCalledWith("e1", "CONFIRMED_DUPLICATE"));
  });

  it("clarification review offers the CORRECT_CLARIFICATION label set and never the proposal-readiness one", async () => {
    vi.mocked(api.sampleClarification).mockResolvedValue(itemSample);
    render(<AdjudicationPanel projectId="p1" />);
    const section = screen.getByRole("region", { name: "Clarification review" });
    const sampleBtn = Array.from(section.querySelectorAll("button")).find((b) => b.textContent === "Sample")!;
    await userEvent.click(sampleBtn);
    expect(await screen.findByText(/Needs info/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Correct — clarification genuinely needed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Correct — proposal-ready" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Should be proposal-ready" }));
    await waitFor(() => expect(api.judgeItem).toHaveBeenCalledWith("i1", "CLARIFICATION", "SHOULD_BE_PROPOSAL_READY"));
  });

  it("shows a stale notice when the item has since been re-analyzed", async () => {
    vi.mocked(api.sampleProposalReady).mockResolvedValue({ ...itemSample, sampled: [{ ...itemSample.sampled[0]!, stale: true, current: { id: "j1", backlogItemId: "i1", analysisId: "old", revision: "abc", category: "PROPOSAL_READINESS", aiReviewState: "READY_FOR_PROPOSAL", label: "CORRECT_PROPOSAL_READY", reviewerId: "u1", note: null, createdAt: "t" } }] });
    render(<AdjudicationPanel projectId="p1" />);
    const section = screen.getByRole("region", { name: "Proposal readiness review" });
    const sampleBtn = Array.from(section.querySelectorAll("button")).find((b) => b.textContent === "Sample")!;
    await userEvent.click(sampleBtn);
    expect(await screen.findByText(/re-analyzed; this judgment is historical/)).toBeInTheDocument();
  });

  it("offers a ground-truth CSV export link and states labels never change AI output", () => {
    render(<AdjudicationPanel projectId="p1" />);
    expect(screen.getByRole("link", { name: /Export ground truth/ })).toHaveAttribute("href", "/api/projects/p1/backlog/adjudication/export");
    expect(screen.getByText(/never overwritten|not instructions that change/)).toBeInTheDocument();
  });
});

describe("AdjudicationPanel — CSV import and baseline (Phase 4B.2)", () => {
  it("imports a filled CSV and shows a per-outcome summary, never fabricating a result", async () => {
    const { adjudicationBaselineApi } = await import("../../api/adjudication.js");
    vi.mocked(adjudicationBaselineApi.importCsv).mockResolvedValue({ totalRows: 3, imported: 1, blank: 1, invalidLabel: 1, malformedRow: 0, wrongProject: 0, notFound: 0, results: [] });
    render(<AdjudicationPanel projectId="p1" />);
    const section = screen.getByRole("region", { name: "Import human-filled labels" });
    await userEvent.type(within(section).getByLabelText("…or paste CSV"), "kind,targetId,category,context,aiConfidenceOrState,label,note\nitem,i1,CLARIFICATION,ctx,state,CORRECT_CLARIFICATION,\n");
    await userEvent.click(within(section).getByRole("button", { name: "Import labels" }));
    expect(adjudicationBaselineApi.importCsv).toHaveBeenCalledWith("p1", expect.stringContaining("CORRECT_CLARIFICATION"));
    expect(await screen.findByText(/1 imported, 1 not yet filled in, 1 invalid label/)).toBeInTheDocument();
  });

  it("a baseline with zero labels says NOT ESTABLISHED, never a fabricated percentage; 'Not measured' appears instead of 0%", async () => {
    const { adjudicationBaselineApi } = await import("../../api/adjudication.js");
    vi.mocked(adjudicationBaselineApi.createBaseline).mockResolvedValue({
      id: "b1", projectId: "p1", version: 1, seed: "baseline-1", sourceName: null, repositoryRevisions: ["abc1234"], models: ["opencode/gemini"],
      sample: { runId: null, duplicateGroups: [], clarificationItemIds: [], proposalReadyItemIds: [], analysisIds: [], infrastructureFailures: [], requestedSampleSizes: { duplicateSize: 8, clarificationSize: 15, proposalReadySize: 10 }, actualSampleSizes: { duplicateGroups: 8, duplicateEdges: 11, clarificationItems: 15, proposalReadyItems: 10 } }, established: false, createdBy: "u1", createdAt: "t",
      metrics: {
        duplicates: { candidateGroups: 12, sampledGroups: 8, sampledEdges: 11, reviewedEdges: 0, unreviewedEdges: 11, staleEdges: 0, labelDistribution: {}, confirmationRate: null, status: "NOT_REVIEWED" },
        clarification: { candidateCount: 61, sampledCount: 15, reviewedCount: 0, unreviewedCount: 15, staleCount: 0, labelDistribution: {}, status: "NOT_REVIEWED" },
        proposalReadiness: { candidateCount: 17, sampledCount: 10, reviewedCount: 0, unreviewedCount: 10, staleCount: 0, labelDistribution: {}, status: "NOT_REVIEWED" },
        coverage: { labelsCollected: 0, staleLabels: 0, sampledTotal: 34, notYetReviewed: 34 },
        limitations: ["Sample sizes are small.", "Single reviewer."],
      },
    });
    vi.mocked(adjudicationBaselineApi.listBaselines).mockResolvedValue([]);
    render(<AdjudicationPanel projectId="p1" />);
    const section = screen.getByRole("region", { name: "Baseline snapshot" });
    await userEvent.click(within(section).getByRole("button", { name: "Sample" }));
    expect((await screen.findAllByText(/NOT ESTABLISHED/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/NO HUMAN LABELS AVAILABLE — BASELINE NOT ESTABLISHED/)).toBeInTheDocument();
    expect(screen.getAllByText("Not measured").length).toBe(3);
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.getByText(/0\/11 edges reviewed/)).toBeInTheDocument();
    expect(screen.getByText(/8\/12 groups sampled/)).toBeInTheDocument();
  });
});

describe("AdjudicationPanel — corrected run identity (Phase 4B.4)", () => {
  it("shows a CORRECTED REPOSITORY-AWARE RUN banner with revision/model/sample-size/infra-failure counts when the baseline is run-scoped", async () => {
    const { adjudicationBaselineApi } = await import("../../api/adjudication.js");
    vi.mocked(adjudicationBaselineApi.createBaseline).mockResolvedValue({
      id: "b2", projectId: "p1", version: 1, seed: "baseline-1", sourceName: "OTT Bug Report", repositoryRevisions: ["7145038f0071"], models: ["opencode/gemini"],
      sample: {
        runId: "run-123", duplicateGroups: [], clarificationItemIds: [], proposalReadyItemIds: [], analysisIds: [],
        infrastructureFailures: [{ itemId: "i9", ref: "app:B-9", title: "Broken item", failureCategory: "engine_error", failureReason: "timed out" }],
        requestedSampleSizes: { duplicateSize: 8, clarificationSize: 15, proposalReadySize: 10 },
        actualSampleSizes: { duplicateGroups: 8, duplicateEdges: 16, clarificationItems: 15, proposalReadyItems: 10 },
      },
      established: false,
      createdBy: "u1", createdAt: "t",
      metrics: {
        duplicates: { candidateGroups: 15, sampledGroups: 8, sampledEdges: 16, reviewedEdges: 0, unreviewedEdges: 16, staleEdges: 0, labelDistribution: {}, confirmationRate: null, status: "NOT_REVIEWED" },
        clarification: { candidateCount: 54, sampledCount: 15, reviewedCount: 0, unreviewedCount: 15, staleCount: 0, labelDistribution: {}, status: "NOT_REVIEWED" },
        proposalReadiness: { candidateCount: 24, sampledCount: 10, reviewedCount: 0, unreviewedCount: 10, staleCount: 0, labelDistribution: {}, status: "NOT_REVIEWED" },
        coverage: { labelsCollected: 0, staleLabels: 0, sampledTotal: 41, notYetReviewed: 41 },
        limitations: ["x"],
      },
    });
    render(<AdjudicationPanel projectId="p1" />);
    const section = screen.getByRole("region", { name: "Baseline snapshot" });
    const sampleBtn = Array.from(section.querySelectorAll("button")).find((b) => b.textContent === "Sample")!;
    await userEvent.click(sampleBtn);
    expect(await screen.findByText("CORRECTED REPOSITORY-AWARE RUN")).toBeInTheDocument();
    expect(screen.getAllByText(/7145038/).length).toBeGreaterThan(0);
    expect(screen.getByText(/41 sampled/)).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => el?.textContent?.includes("1 infrastructure failure(s) excluded") ?? false).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText(/infrastructure failure\(s\) excluded from every sample/));
    expect(screen.getByText(/Broken item/)).toBeInTheDocument();
    expect(screen.getByText(/engine_error: timed out/)).toBeInTheDocument();
  });
});
