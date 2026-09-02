import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityTimeline } from "./ActivityTimeline.js";
import { makeEvent } from "../../test/fixtures.js";

describe("ActivityTimeline", () => {
  test("renders events in chronological order with human-readable labels, never raw event type names", () => {
    render(
      <ActivityTimeline
        events={[
          makeEvent({ id: "e1", type: "TASK_CREATED" }),
          makeEvent({ id: "e2", type: "WORKSPACE_CREATED" }),
          makeEvent({ id: "e3", type: "BRANCH_CREATED" }),
        ]}
      />,
    );
    const labels = screen.getAllByText(/Task created|Prepared a workspace|Created a branch/).map((el) => el.textContent);
    expect(labels).toEqual(["Task created", "Prepared a workspace", "Created a branch"]);
    expect(screen.queryByText("TASK_CREATED")).not.toBeInTheDocument();
  });

  test("shows relevant agent/run information from the event's own payload — role and attempt number", () => {
    render(<ActivityTimeline events={[makeEvent({ type: "AGENT_STARTED", payload: { runId: "r1", role: "implementer", attemptNumber: 2 } })]} />);
    expect(screen.getByText("Implementer · attempt 2")).toBeInTheDocument();
  });

  test("shows a status/result summary for validation and review completion events", () => {
    render(
      <ActivityTimeline
        events={[
          makeEvent({ id: "e1", type: "VALIDATION_COMPLETED", payload: { status: "passed", checks: [{ name: "test", passed: true }, { name: "build", passed: false }] } }),
          makeEvent({ id: "e2", type: "REVIEW_COMPLETED", payload: { verdict: "approved", findings: [] } }),
        ]}
      />,
    );
    expect(screen.getByText("1/2 checks passed")).toBeInTheDocument();
    expect(screen.getByText("verdict: approved")).toBeInTheDocument();
  });

  test("shows recovery-relevant events (human review detection/changes-requested) with attribution from the payload", () => {
    render(
      <ActivityTimeline
        events={[
          makeEvent({ id: "e1", type: "HUMAN_REVIEW_DETECTED", payload: { newItemCount: 1 } }),
          makeEvent({ id: "e2", type: "HUMAN_REVIEW_CHANGES_REQUESTED", payload: { reviewer: "octocat" } }),
        ]}
      />,
    );
    expect(screen.getByText("1 new item found")).toBeInTheDocument();
    expect(screen.getByText("by octocat")).toBeInTheDocument();
  });

  test("an event with no useful payload fields renders its label alone, with no fabricated detail line", () => {
    render(<ActivityTimeline events={[makeEvent({ type: "TASK_STARTED", payload: {} })]} />);
    expect(screen.getByText("Started working")).toBeInTheDocument();
  });

  test("never renders raw payload JSON as a detail line, even for an event type with an unexpected payload shape", () => {
    render(<ActivityTimeline events={[makeEvent({ type: "TASK_CREATED", payload: { unexpected: { nested: "value" } } })]} />);
    expect(screen.queryByText(/nested/)).not.toBeInTheDocument();
  });

  test("shows an empty state when there is no activity yet", () => {
    render(<ActivityTimeline events={[]} />);
    expect(screen.getByText("No activity yet.")).toBeInTheDocument();
  });
});
