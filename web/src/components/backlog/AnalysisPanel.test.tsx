import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AnalysisPanel } from "./AnalysisPanel.js";
import { ProposalPanel } from "./ProposalPanel.js";
import { BacklogActivity } from "./BacklogActivity.js";
import { makeAnalysis, makeAssessedAnalysis, makeProposal, makeProposalContent } from "../../test/fixtures.js";

function region(name: RegExp) {
  return screen.getByRole("region", { name });
}

const AI = /AI analysis/;
const PLATFORM = /Platform evidence/;
const ASSESSMENT = /Evidence assessment/;

describe("AnalysisPanel trust boundary", () => {
  it("renders AI claims, platform evidence and assessment as three separate parts", () => {
    render(<AnalysisPanel analysis={makeAssessedAnalysis()} itemStatus="ANALYZED" />);
    expect(within(region(AI)).getByText(/Nothing rotates refresh tokens/)).toBeInTheDocument();
    const platform = within(region(PLATFORM));
    expect(platform.getByText("FILE_EXISTS")).toBeInTheDocument();
    expect(platform.getByText("backend/otpThrottle.ts")).toBeInTheDocument();
    expect(platform.getByText(/L12: const refreshToken/)).toBeInTheDocument();
    expect(platform.queryByText("SUPPORTED")).not.toBeInTheDocument();
    expect(within(region(ASSESSMENT)).getByText("SUPPORTED")).toBeInTheDocument();
    expect(within(region(AI)).queryByText("SUPPORTED")).not.toBeInTheDocument();
  });

  it("shows CONTRADICTED with the platform reason, and the override notice only when confidenceOverridden", () => {
    const { unmount } = render(<AnalysisPanel analysis={makeAssessedAnalysis()} itemStatus="ANALYZED" />);
    const a = within(region(ASSESSMENT));
    expect(a.getByText("CONTRADICTED")).toBeInTheDocument();
    expect(a.getByText("Repository content matches the search terms.")).toBeInTheDocument();
    expect(screen.queryByText(/Confidence does not override evidence/)).not.toBeInTheDocument();
    unmount();

    render(<AnalysisPanel analysis={makeAssessedAnalysis({ confidenceOverridden: true })} itemStatus="NEEDS_CLARIFICATION" />);
    expect(screen.getByText(/Confidence does not override evidence/)).toBeInTheDocument();
    expect(screen.getByText(/human should review the contradiction/)).toBeInTheDocument();
  });

  it("renders UNRESOLVED and NOT CHECKED with their own text and the existence-is-not-correctness help", () => {
    render(<AnalysisPanel analysis={makeAssessedAnalysis()} itemStatus="ANALYZED" />);
    const a = within(region(ASSESSMENT));
    expect(a.getByText("UNRESOLVED")).toBeInTheDocument();
    expect(a.getByText("NOT CHECKED")).toBeInTheDocument();
    expect(a.getByText("not checked")).toBeInTheDocument();
    expect(a.getByText(/Existence is not correctness/)).toBeInTheDocument();
    expect(screen.queryByText(/human should review the contradiction/)).not.toBeInTheDocument();
  });

  it("states what each status establishes, defaulting to nothing for legacy records", () => {
    const base = makeAssessedAnalysis();
    const claims = base.platformChecks!.assessment!.claims.map((c, i) => (i === 0 ? { ...c, establishes: "existence" as const } : c));
    render(<AnalysisPanel analysis={makeAssessedAnalysis({ claims })} itemStatus="ANALYZED" />);
    const a = within(region(ASSESSMENT));
    expect(a.getAllByText("Establishes only that matching files/code exist — not what they do.")).toHaveLength(1);
    // three claims lack `establishes` (legacy) => "nothing" line
    expect(a.getAllByText("Establishes nothing about this claim.")).toHaveLength(3);
  });

  it("still renders an old analysis without claims or assessment", () => {
    render(<AnalysisPanel analysis={makeAnalysis()} itemStatus="ANALYZED" />);
    expect(screen.getByText("The session refresh path drops the token.")).toBeInTheDocument();
    expect(within(region(PLATFORM)).getByText("No platform evidence was recorded for this analysis.")).toBeInTheDocument();
    expect(screen.getByText(/made no structured claims/)).toBeInTheDocument();
    expect(screen.getByText("verified in repository")).toBeInTheDocument();
  });

  it("shows only reported usage counts, never 0 for null", () => {
    const analysis = makeAnalysis({ usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, estimatedCost: null });
    render(<AnalysisPanel analysis={analysis} itemStatus="ANALYZED" />);
    const usage = within(screen.getByRole("region", { name: "Model usage" }));
    expect(usage.getByText("1,200")).toBeInTheDocument();
    expect(usage.getByText("300")).toBeInTheDocument();
    expect(usage.queryByText("Reasoning tokens")).not.toBeInTheDocument();
    expect(usage.queryByText("Cache read tokens")).not.toBeInTheDocument();
    expect(usage.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("shows no usage section when usage and cost are null", () => {
    render(<AnalysisPanel analysis={makeAnalysis()} itemStatus="ANALYZED" />);
    expect(screen.queryByText("Model usage")).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost/)).not.toBeInTheDocument();
  });

  it("shows the estimated cost with currency and its pricing source", () => {
    const analysis = makeAnalysis({
      usage: null,
      estimatedCost: { amount: 0.0054, currency: "USD", pricingSource: "opencode-reported", pricingVersion: null },
    });
    render(<AnalysisPanel analysis={analysis} itemStatus="ANALYZED" />);
    expect(screen.getByText("Estimated cost: US$0.0054 — estimate reported by opencode-reported (not provider-billed)")).toBeInTheDocument();
  });

  it("words truncated and unavailable listings honestly", () => {
    const inspection = { listing: "truncated" as const, filesRead: 0, bytesRead: 0, filesSkipped: [], limits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 } };
    const { unmount } = render(<AnalysisPanel analysis={makeAssessedAnalysis({ inspection })} itemStatus="ANALYZED" />);
    expect(screen.getByText(/Repository listing: truncated \(absence proves nothing\) — 0 files read, 0\.0 KB/)).toBeInTheDocument();
    unmount();
    render(<AnalysisPanel analysis={makeAssessedAnalysis({ inspection: { ...inspection, listing: "unavailable" } })} itemStatus="ANALYZED" />);
    expect(screen.getByText(/Repository listing: unavailable/)).toBeInTheDocument();
  });

  it("lists files the platform declined to read, grouped by reason", () => {
    const inspection = {
      listing: "complete" as const,
      filesRead: 1,
      bytesRead: 1024,
      filesSkipped: [
        { path: ".env", reason: "secret_path" },
        { path: "big.bin", reason: "binary" },
      ],
      limits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 },
    };
    render(<AnalysisPanel analysis={makeAssessedAnalysis({ inspection })} itemStatus="ANALYZED" />);
    const platform = within(region(PLATFORM));
    expect(platform.getByText("2 files CodeForge declined to read")).toBeInTheDocument();
    expect(platform.getByText("Secret-looking path")).toBeInTheDocument();
    expect(platform.getByText(".env")).toBeInTheDocument();
    expect(platform.getByText("Binary file")).toBeInTheDocument();
  });
});

describe("ProposalPanel claim assessments", () => {
  const noop = () => {};
  const renderProposal = (content = makeProposalContent()) =>
    render(
      <MemoryRouter>
        <ProposalPanel proposal={makeProposal({ content })} projectId="p1" busy={false} onApprove={noop} onReject={noop} onConvert={noop} />
      </MemoryRouter>,
    );

  it("shows the investigate-first banner and claim assessments", () => {
    renderProposal(
      makeProposalContent({
        investigateFirst: true,
        claimAssessments: [{ statement: "Nothing rotates tokens", kind: "FEATURE_ABSENT", aiConfidence: "high", status: "CONTRADICTED", reason: "Content matched.", evidence: ["CONTENT_MATCH src/a.ts"] }],
      }),
    );
    expect(screen.getByText(/Investigate first — CodeForge's evidence contradicts an AI claim/)).toBeInTheDocument();
    expect(screen.getByText("CONTRADICTED")).toBeInTheDocument();
    expect(screen.getByText("Content matched.")).toBeInTheDocument();
    expect(screen.getByText("CONTENT_MATCH src/a.ts")).toBeInTheDocument();
    expect(screen.getByText(/AI-stated summary/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve proposal" })).toBeInTheDocument();
  });

  it("shows what each proposal claim establishes", () => {
    renderProposal(
      makeProposalContent({
        claimAssessments: [
          { statement: "A exists", kind: "FILE_EXISTS", aiConfidence: "high", status: "SUPPORTED", establishes: "existence", reason: "r1", evidence: [] },
          { statement: "B works", kind: "BEHAVIOR_CORRECT", aiConfidence: "low", status: "UNRESOLVED", reason: "r2", evidence: [] },
        ],
      }),
    );
    expect(screen.getByText("Establishes only that matching files/code exist — not what they do.")).toBeInTheDocument();
    expect(screen.getByText("Establishes nothing about this claim.")).toBeInTheDocument();
  });

  it("renders a proposal without those fields as before", () => {
    renderProposal();
    expect(screen.queryByText(/Investigate first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claim assessments/)).not.toBeInTheDocument();
    expect(screen.getByText("Proposal summary")).toBeInTheDocument();
  });
});

describe("BacklogActivity", () => {
  it("shows a claims fact from the completed payload", () => {
    render(
      <BacklogActivity
        events={[{ id: "e1", type: "ANALYSIS_COMPLETED", createdAt: "2026-01-01T00:00:00.000Z", payload: { claims: 4, claimsContradicted: 1 } }]}
      />,
    );
    expect(screen.getByText("4 claims — 1 contradicted")).toBeInTheDocument();
  });
});

describe("AnalysisPanel — repository index, symbol evidence and verification (Phase 4A.3)", () => {
  const withContext = (extra: Record<string, unknown>) => {
    const a = makeAssessedAnalysis();
    return { ...a, platformChecks: { ...a.platformChecks!, context: { ...a.platformChecks!.context, ...extra } } };
  };

  it("says files were chosen using the repository index, at which revision, and why", () => {
    render(
      <AnalysisPanel
        analysis={withContext({
          index: { state: "used", revision: "abcdef1234567890", built: true, files: 100, contentIndexedFiles: 90, symbols: 400, complete: true, reason: null },
          selection: { method: "index", rankedFiles: 12, top: [{ path: "src/accounts/manager.ts", score: 12, reasons: ["symbol:deleteProfile"] }], excerptPaths: ["src/accounts/manager.ts"] },
        })}
        itemStatus="ANALYZED"
      />,
    );
    expect(screen.getByText(/Files chosen using the repository index @ abcdef1/)).toBeInTheDocument();
    expect(screen.getByText(/12 ranked, 1 read/)).toBeInTheDocument();
    expect(screen.getByText("symbol:deleteProfile")).toBeInTheDocument();
  });

  it("says plainly when selection fell back to file names, and why", () => {
    render(
      <AnalysisPanel
        analysis={withContext({
          index: { state: "building_elsewhere", revision: "abcdef1234567890", built: false, files: null, contentIndexedFiles: null, symbols: null, complete: null, reason: "x" },
          selection: { method: "name", rankedFiles: 3, top: [], excerptPaths: [] },
        })}
        itemStatus="ANALYZED"
      />,
    );
    expect(screen.getByText(/Files chosen by file name only — the repository index was being built by another analysis/)).toBeInTheDocument();
    expect(screen.queryByText(/Why these files/)).not.toBeInTheDocument();
  });

  it("flags a partial index, and renders nothing for older analyses that have no index info", () => {
    const { unmount } = render(
      <AnalysisPanel
        analysis={withContext({
          index: { state: "used", revision: "abcdef1234567890", built: false, files: 100, contentIndexedFiles: 40, symbols: 100, complete: false, reason: null },
          selection: { method: "index", rankedFiles: 1, top: [], excerptPaths: [] },
        })}
        itemStatus="ANALYZED"
      />,
    );
    expect(screen.getByText(/The index is partial/)).toBeInTheDocument();
    unmount();
    render(<AnalysisPanel analysis={makeAssessedAnalysis()} itemStatus="ANALYZED" />);
    expect(screen.queryByText(/Files chosen/)).not.toBeInTheDocument();
  });

  it("shows index-derived symbol evidence as PLATFORM evidence with its revision, and never as an AI claim", () => {
    const evidence = [
      { id: "E1", type: "SYMBOL_MATCH" as const, source: "repository_index" as const, path: "src/accounts/manager.ts", detail: "deleteProfile @ abcdef123456", matchedTerms: ["delete"], revision: "abcdef1234567890" },
    ];
    render(<AnalysisPanel analysis={makeAssessedAnalysis({ evidence })} itemStatus="ANALYZED" />);
    const platform = within(region(PLATFORM));
    expect(platform.getByText("SYMBOL_MATCH")).toBeInTheDocument();
    expect(platform.getByText("src/accounts/manager.ts")).toBeInTheDocument();
    expect(within(region(AI)).queryByText("SYMBOL_MATCH")).not.toBeInTheDocument();
  });

  it("shows a planned-but-not-run verification honestly: not run, with the platform's reason — never as passed", () => {
    render(
      <AnalysisPanel
        analysis={makeAssessedAnalysis({
          verification: [{ claimIndex: 2, checkId: "test", state: "not_run", reason: "Backlog analysis is read-only by policy and does not execute the project's checks.", evidenceId: null }],
        })}
        itemStatus="ANALYZED"
      />,
    );
    const a = within(region(ASSESSMENT));
    expect(a.getByText("not run")).toBeInTheDocument();
    expect(a.getByText(/read-only by policy/)).toBeInTheDocument();
    expect(a.queryByText("passed")).not.toBeInTheDocument();
  });
});

describe("Reconciliation (Phase 4A.4) — claim, evidence and reconciliation stay separate; nothing says fixed", () => {
  const recon = (over: Record<string, unknown> = {}) => ({
    revision: "abcdef1234567890",
    alreadyImplemented: "possible" as const,
    behaviorVerified: false,
    ignoredEvidence: [],
    findings: [
      { claimIndex: 0, statement: "Profile deletion does not check whether deletion is allowed", claimClass: "implementation_absence" as const, labelledAsBehavior: true, outcome: "IMPLEMENTATION_PRESENT" as const, strength: "weak" as const, evidenceIds: ["E1"], explanation: "A matching declaration exists and is referenced in a file the platform read. Behavioral correctness was not verified.", behaviorVerified: false },
    ],
    ...over,
  });

  it("shows the conflict as a reconciliation — separate from the AI claim and the evidence — and states behavior is unverified", () => {
    render(<AnalysisPanel analysis={makeAssessedAnalysis({ reconciliation: recon() })} itemStatus="ANALYZED" />);
    const a = within(region(ASSESSMENT));
    expect(a.getByRole("heading", { name: "Reconciliation" })).toBeInTheDocument();
    expect(a.getByText(/Possibly already implemented \(possible\)/)).toBeInTheDocument();
    expect(a.getByText("Implementation evidence conflicts with the reported absence")).toBeInTheDocument();
    expect(a.getByText(/Profile deletion does not check whether deletion is allowed/)).toBeInTheDocument();
    expect(a.getByText(/Behavior verification: not verified/)).toBeInTheDocument();
    expect(a.getByText(/does not mean the item is fixed/)).toBeInTheDocument();
    expect(a.getByText(/@ revision|revision abcdef1/)).toBeInTheDocument();
    // Never claims a fix, anywhere on the page.
    expect(screen.queryByText(/bug fixed|is fixed\b(?! —)/i)).not.toBeInTheDocument();
    // The AI region does not contain the reconciliation, the platform-evidence region does not either.
    expect(within(region(AI)).queryByText("Implementation evidence conflicts with the reported absence")).not.toBeInTheDocument();
    expect(within(region(PLATFORM)).queryByText("Implementation evidence conflicts with the reported absence")).not.toBeInTheDocument();
  });

  it("a strong conflict is prominent; a bound check that passed is the ONLY thing that reads as verified; ignored stale evidence is disclosed", () => {
    const { unmount } = render(<AnalysisPanel analysis={makeAssessedAnalysis({ reconciliation: recon({ alreadyImplemented: "strong" }) })} itemStatus="NEEDS_CLARIFICATION" />);
    expect(screen.getByText(/Possibly already implemented \(strong\)/).closest(".error-banner")).not.toBeNull();
    unmount();
    render(
      <AnalysisPanel
        analysis={makeAssessedAnalysis({
          reconciliation: recon({
            alreadyImplemented: "none",
            behaviorVerified: true,
            ignoredEvidence: [{ id: "E9", reason: "describes revision 1111111, not the analysed 2222222" }],
            findings: [{ claimIndex: 0, statement: "Limiter works", claimClass: "behavior", labelledAsBehavior: false, outcome: "CHECK_VERIFIED", strength: null, evidenceIds: [], explanation: "The project's configured 'test' check, bound to this claim, passed.", behaviorVerified: true }],
          }),
        })}
        itemStatus="ANALYZED"
      />,
    );
    expect(screen.getByText("Verified by a platform check bound to this claim")).toBeInTheDocument();
    expect(screen.getByText(/1 evidence item\(s\) for another revision were ignored/)).toBeInTheDocument();
  });

  it("with no conflict it says so; with an older analysis (no reconciliation) it renders nothing extra", () => {
    const { unmount } = render(
      <AnalysisPanel
        analysis={makeAssessedAnalysis({ reconciliation: recon({ alreadyImplemented: "none", findings: [{ claimIndex: 0, statement: "x", claimClass: "behavior", labelledAsBehavior: false, outcome: "UNRESOLVED", strength: null, evidenceIds: [], explanation: "e", behaviorVerified: false }] }) })}
        itemStatus="ANALYZED"
      />,
    );
    expect(screen.getByText(/No claim was found to conflict with repository evidence/)).toBeInTheDocument();
    expect(screen.queryByText(/Possibly already implemented/)).not.toBeInTheDocument();
    unmount();
    render(<AnalysisPanel analysis={makeAssessedAnalysis()} itemStatus="ANALYZED" />);
    expect(screen.queryByRole("heading", { name: "Reconciliation" })).not.toBeInTheDocument();
  });

  it("the proposal carries the signal as an investigation banner that says it is not a fix claim", () => {
    render(
      <MemoryRouter>
        <ProposalPanel proposal={makeProposal({ content: makeProposalContent({ implementationConflict: "possible", investigateFirst: true }) })} projectId="p1" busy={false} onApprove={() => {}} onReject={() => {}} onConvert={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/may already be implemented/)).toBeInTheDocument();
    expect(screen.getByText(/not a claim that it works or is fixed/)).toBeInTheDocument();
    expect(screen.queryByText(/contradicts an AI claim this proposal/)).not.toBeInTheDocument();
  });
});

