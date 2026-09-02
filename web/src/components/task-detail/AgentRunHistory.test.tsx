import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentRunHistory } from "./AgentRunHistory.js";
import { makeAgentRunHistoryItem } from "../../test/fixtures.js";

describe("AgentRunHistory", () => {
  test("renders an empty state when there are no runs yet", () => {
    render(<AgentRunHistory runs={[]} />);
    expect(screen.getByText("No agent runs yet.")).toBeInTheDocument();
  });

  test("shows role, attempt number, status, and trigger for a plain Implementer run", () => {
    render(<AgentRunHistory runs={[makeAgentRunHistoryItem()]} />);
    expect(screen.getByText("Implementer")).toBeInTheDocument();
    expect(screen.getByText("attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Initial pass")).toBeInTheDocument();
    expect(screen.getByText("Fixed the bug.")).toBeInTheDocument();
  });

  test("distinguishes multiple Implementer attempts and a Reviewer run in the same list", () => {
    render(
      <AgentRunHistory
        runs={[
          makeAgentRunHistoryItem({ id: "r1", attemptNumber: 1, trigger: "initial" }),
          makeAgentRunHistoryItem({ id: "r2", attemptNumber: 2, trigger: "self_fix_retry" }),
          makeAgentRunHistoryItem({ id: "r3", role: "reviewer", attemptNumber: 1, trigger: "review", verdict: "approved" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Implementer")).toHaveLength(2);
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Self-fix retry")).toBeInTheDocument();
    expect(screen.getByText("Independent review")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  test("shows reviewer findings when present", () => {
    render(
      <AgentRunHistory
        runs={[
          makeAgentRunHistoryItem({
            role: "reviewer",
            trigger: "review",
            verdict: "rejected",
            findings: [{ severity: "blocker", category: "correctness", summary: "Off-by-one error" }],
          }),
        ]}
      />,
    );
    expect(screen.getByText("blocker")).toBeInTheDocument();
    expect(screen.getByText("Off-by-one error")).toBeInTheDocument();
  });

  test("an AI-reviewer-triggered fix and a human-review-triggered fix are visually distinguishable, and human feedback is shown with attribution", () => {
    render(
      <AgentRunHistory
        runs={[
          makeAgentRunHistoryItem({ id: "r1", attemptNumber: 2, trigger: "ai_review_fix" }),
          makeAgentRunHistoryItem({
            id: "r2",
            attemptNumber: 3,
            trigger: "human_review_fix",
            humanReviewFeedback: { reviewerLogin: "octocat", comments: "Please add a doc comment." },
          }),
        ]}
      />,
    );
    expect(screen.getByText("AI reviewer fix")).toBeInTheDocument();
    expect(screen.getByText("Human review fix")).toBeInTheDocument();
    expect(screen.getByText(/Human reviewer feedback/)).toHaveTextContent("octocat");
    expect(screen.getByText("Please add a doc comment.")).toBeInTheDocument();
  });

  test("a failed run shows its status and a sanitized technical error in an expandable — never a raw stack trace by default", () => {
    render(
      <AgentRunHistory
        runs={[
          makeAgentRunHistoryItem({
            status: "failed",
            summary: null,
            completedAt: "2026-01-01T00:00:10.000Z",
            error: "Coding engine invocation (implementer) failed after 2 attempts: HTTP 503",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    const details = screen.getByText("Technical error details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    // Never a raw JS stack trace format ("at ... (file:line:col)") shown anywhere.
    expect(screen.queryByText(/at .* \(.*:\d+:\d+\)/)).not.toBeInTheDocument();
  });

  test("an interrupted run followed by its resumed attempt are both clearly labeled — crash recovery visibility", () => {
    render(
      <AgentRunHistory
        runs={[
          makeAgentRunHistoryItem({ id: "r1", attemptNumber: 1, status: "interrupted", summary: null, completedAt: null }),
          makeAgentRunHistoryItem({ id: "r2", attemptNumber: 2, resumedAfterInterruption: true }),
        ]}
      />,
    );
    expect(screen.getByText("Interrupted (crash recovery)")).toBeInTheDocument();
    expect(screen.getByText("Resumed after crash")).toBeInTheDocument();
  });

  test("missing optional fields (no summary, no files changed, no findings) render without crashing or fabricating content", () => {
    render(<AgentRunHistory runs={[makeAgentRunHistoryItem({ summary: null, filesChanged: [], confidence: null })]} />);
    expect(screen.getByText("Implementer")).toBeInTheDocument();
    expect(screen.queryByText(/files changed:/)).not.toBeInTheDocument();
  });

  test("never dumps raw JSON as the summary text, even if it somehow reached the run", () => {
    render(<AgentRunHistory runs={[makeAgentRunHistoryItem({ summary: '{"type":"step_start","sessionID":"ses_abc"}' })]} />);
    const el = screen.getByText(/step_start/);
    expect(el.tagName).toBe("P");
  });
});
