import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeAgentRunHistoryItem, makeEvent, makeInputRequest, makeReport, makeTask } from "../test/fixtures.js";
import { tasksApi, humanInputApi } from "../api/index.js";

vi.mock("../api/tasks.js", () => ({
  tasksApi: {
    get: vi.fn(),
    listEvents: vi.fn(),
    getReport: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock("../api/humanInput.js", () => ({
  humanInputApi: {
    get: vi.fn(),
    submit: vi.fn(),
  },
}));

const mockedTasksApi = vi.mocked(tasksApi);
const mockedHumanInputApi = vi.mocked(humanInputApi);

describe("TaskDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTasksApi.listEvents.mockResolvedValue([]);
    mockedTasksApi.getReport.mockResolvedValue(makeReport());
    mockedHumanInputApi.get.mockResolvedValue(null);
  });

  it("renders WORKING status, description, and current activity", async () => {
    mockedTasksApi.get.mockResolvedValue(
      makeTask({ status: "WORKING", currentActivity: "Running tests", selfFixAttempts: 1 }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Client reports that OTP login fails after session timeout.")).toBeInTheDocument();
    expect(screen.getAllByText(/Running tests/).length).toBeGreaterThan(0);
  });

  it("converts raw event types into human-readable activity", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "WORKING" }));
    mockedTasksApi.listEvents.mockResolvedValue([
      makeEvent({ id: "e1", type: "TASK_CREATED" }),
      makeEvent({ id: "e2", type: "AGENT_STARTED" }),
      makeEvent({ id: "e3", type: "VALIDATION_STARTED" }),
      makeEvent({ id: "e4", type: "RETRY_STARTED" }),
    ]);

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Task created")).toBeInTheDocument());
    expect(screen.getByText("AI developer started working")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Automatically fixing a test failure")).toBeInTheDocument();
    // Raw internal event names must never reach the screen.
    expect(screen.queryByText("TASK_CREATED")).not.toBeInTheDocument();
    expect(screen.queryByText("AGENT_STARTED")).not.toBeInTheDocument();
  });

  it("renders NEEDS_INPUT with the question/evidence and lets the developer answer", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "NEEDS_INPUT" }));
    mockedHumanInputApi.get.mockResolvedValue(makeInputRequest());
    mockedHumanInputApi.submit.mockResolvedValue(makeTask({ status: "WORKING" }));

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Your decision is required")).toBeInTheDocument());
    expect(screen.getByText(/two equally plausible fixes/i)).toBeInTheDocument();
    expect(screen.getByText("Should the session refresh automatically, or force re-login?")).toBeInTheDocument();
    expect(screen.getByText("Auto-refresh")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Auto-refresh"));
    await userEvent.type(screen.getByLabelText(/your decision/i), "Go with auto-refresh.");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(mockedHumanInputApi.submit).toHaveBeenCalledWith("task-1", {
        selectedOption: "Auto-refresh",
        freeText: "Go with auto-refresh.",
      }),
    );
    // The frontend never sets status itself — it only shows that submission succeeded.
    await waitFor(() => expect(screen.getByText(/continuing/i)).toBeInTheDocument());
  });

  it("renders a clear explanation (not a raw GitHub error) when NEEDS_INPUT was raised because the AI made no repository changes", async () => {
    // Regression for the zero-change orchestrator fix: this reuses the exact same generic
    // NEEDS_INPUT panel as every other question — see NeedsInputPanel.tsx — so this test proves
    // the human-readable text produced by orchestrator/needs-input.ts's fromEmptyDiff() renders
    // correctly, instead of the opaque "GitHubApiError: 422 Validation Failed" a user saw before.
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "NEEDS_INPUT" }));
    mockedHumanInputApi.get.mockResolvedValue(
      makeInputRequest({
        discovered:
          'The AI developer completed an implementation pass and validation passed, but the workspace ended up ' +
          'identical to its starting point — no files were changed. Its own summary: "The target file already ' +
          'exists and the task forbids modifying existing files, so no change was made."',
        attempted: [
          "Ran a full implement-and-validate pass on this task; validation succeeded, but the working tree and " +
            "commit history came out unchanged from the branch's starting point.",
        ],
        blocker:
          "The AI developer could not find any change it judged safe and necessary to make for this task, so " +
          "there is nothing to commit, push, or open a Pull Request for.",
        question:
          "How should this task proceed — confirm no change was actually needed, clarify/narrow the task, or " +
          "explicitly allow the AI to modify files it currently treats as off-limits?",
        options: [{ label: "No change was needed", description: "Confirm the task is effectively already satisfied." }],
      }),
    );
    mockedTasksApi.listEvents.mockResolvedValue([makeEvent({ id: "e1", type: "NO_CHANGES_DETECTED" })]);

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Your decision is required")).toBeInTheDocument());
    expect(screen.getByText(/no files were changed/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to commit, push, or open a Pull Request/i)).toBeInTheDocument();
    // No raw GitHub/API error text ever reaches the screen for this path.
    expect(screen.queryByText(/422/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHubApiError/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Validation Failed/i)).not.toBeInTheDocument();
    // The activity timeline shows a plain-language label, not the raw event name.
    expect(screen.getByText(/No repository changes were needed/i)).toBeInTheDocument();
    expect(screen.queryByText("NO_CHANGES_DETECTED")).not.toBeInTheDocument();
  });

  it("renders a DONE completion summary using only real report data", async () => {
    mockedTasksApi.get.mockResolvedValue(
      makeTask({ status: "DONE", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:18:00.000Z" }),
    );
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({ status: "Done", whatChanged: "Updated session timeout handling.", filesChanged: 5 }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("✓ Completed")).toBeInTheDocument());
    expect(screen.getByText("Updated session timeout handling.")).toBeInTheDocument();
    expect(screen.getByText("5 files changed")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("No concerns raised.")).toBeInTheDocument();
  });

  it("renders a task completed via PR-merge sync as DONE with 'Completed — PR #N merged', not 'Ready for your review'", async () => {
    // See docs/TASK_LIFECYCLE.md "PR merge sync": once the backend detects the PR was merged
    // directly on GitHub, the task's status/currentActivity flip from REVIEW/"Ready for your
    // review" to DONE/"Completed — PR #N merged" — the frontend only ever renders what the API
    // already computed (see api/dto.ts deriveCurrentActivity), never re-deriving it itself.
    mockedTasksApi.get.mockResolvedValue(
      makeTask({
        status: "DONE",
        currentActivity: "Completed — PR #42 merged",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:18:00.000Z",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/example/ott/pull/42",
      }),
    );
    mockedTasksApi.listEvents.mockResolvedValue([
      makeEvent({ id: "e1", type: "TASK_MOVED_TO_REVIEW" }),
      makeEvent({ id: "e2", type: "PULL_REQUEST_MERGED", payload: { number: 42, url: "https://github.com/example/ott/pull/42" } }),
    ]);
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({ status: "Done", whatChanged: "Updated session timeout handling.", filesChanged: 5 }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    expect(screen.getByText("Done")).toBeInTheDocument(); // StatusBadge — same DONE label as a manual accept
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Completed — PR #42 merged/).length).toBeGreaterThan(0);
    // The merge transition itself shows in the activity timeline, via the existing event-label convention.
    expect(screen.getByText("Pull Request merged on GitHub — task completed")).toBeInTheDocument();
    expect(screen.getByText("✓ Completed")).toBeInTheDocument();
  });

  it("shows a clean failure reason (e.g. an exhausted review/fix cycle) when a task is FAILED", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "FAILED", completedAt: "2026-01-01T00:20:00.000Z" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Failed",
        failureReason:
          "Independent review rejected the implementation after 3 fix attempts, reaching the configured review/fix cycle limit. Latest findings: [blocker/correctness] still missing error handling",
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText(/reaching the configured review\/fix cycle limit/)).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Failed" })).toBeInTheDocument();
  });

  it("renders a Markdown 'What changed' summary as real formatted elements — headings, lists, inline code — not raw text", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Ready for review",
        whatChanged: "Created `README.md` with:\n\n- project overview\n- development instructions",
        filesChanged: 1,
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("development instructions")).toBeInTheDocument());
    expect(screen.getByText("README.md").tagName).toBe("CODE");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("never renders raw agent execution event JSON as the task summary, even if it somehow reached the report", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Ready for review",
        // A defense-in-depth check: the backend fix (opencode-adapter.ts) is what stops this from
        // happening in the first place, but the UI must still never *interpret* stray JSON-looking
        // text as anything other than inert text — see Markdown.test.tsx for the component-level
        // version of this guarantee.
        whatChanged: '{"type":"step_start","sessionID":"ses_abc123","timestamp":1788198798610}',
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText(/step_start/)).toBeInTheDocument());
    // It renders as plain inert text, not as any kind of structured/interactive element.
    const el = screen.getByText(/step_start/);
    expect(el.tagName).toBe("P");
  });

  it("shows the reviewer's own readable assessment when there are no structured findings, instead of only a generic 'No concerns raised'", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Ready for review",
        reviewFindings: [],
        reviewSummary: "I verified the README accurately reflects the codebase and found no issues.",
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText(/I verified the README accurately reflects the codebase/)).toBeInTheDocument());
    expect(screen.queryByText("No concerns raised.")).not.toBeInTheDocument();
  });

  it("handles a failed task load without a raw error message", async () => {
    mockedTasksApi.get.mockRejectedValue(new Error("Request failed (500)"));
    renderApp("/tasks/task-1");
    await waitFor(() => expect(screen.getByText(/couldn't load this task/i)).toBeInTheDocument());
    expect(screen.queryByText(/request failed \(500\)/i)).not.toBeInTheDocument();
  });

  it("shows Cancel task only for cancellable statuses (TODO/WORKING/NEEDS_INPUT), not REVIEW/DONE/CANCELLED", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "WORKING" }));
    renderApp("/tasks/task-1");
    await waitFor(() => expect(screen.getByRole("button", { name: /cancel task/i })).toBeInTheDocument());
  });

  it("hides Cancel task on REVIEW", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    renderApp("/tasks/task-1");
    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /cancel task/i })).not.toBeInTheDocument();
  });

  it("hides Cancel task on DONE", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "DONE" }));
    renderApp("/tasks/task-1");
    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /cancel task/i })).not.toBeInTheDocument();
  });

  it("hides Cancel task on CANCELLED and cannot be resumed through the UI", async () => {
    mockedTasksApi.get.mockResolvedValue(
      makeTask({ status: "CANCELLED", completedAt: "2026-01-01T00:05:00.000Z", cancelledBy: "user-1" }),
    );
    renderApp("/tasks/task-1");
    await waitFor(() => expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /cancel task/i })).not.toBeInTheDocument();
    // No resume/continue/answer affordance exists anywhere on a cancelled task's page.
    expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
  });

  it("requires confirmation before cancelling, then calls the cancel API and refreshes the task", async () => {
    mockedTasksApi.get
      .mockResolvedValueOnce(makeTask({ id: "task-1", status: "WORKING" }))
      .mockResolvedValueOnce(makeTask({ id: "task-1", status: "CANCELLED", completedAt: "2026-01-01T00:05:00.000Z" }));
    mockedTasksApi.cancel.mockResolvedValue(makeTask({ id: "task-1", status: "CANCELLED" }));

    renderApp("/tasks/task-1");
    await waitFor(() => expect(screen.getByRole("button", { name: /cancel task/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /cancel task/i }));
    expect(screen.getByText("Cancel this task?")).toBeInTheDocument();
    expect(mockedTasksApi.cancel).not.toHaveBeenCalled();

    // Backing out via "Keep Working" must not call the API.
    await userEvent.click(screen.getByRole("button", { name: /keep working/i }));
    expect(screen.queryByText("Cancel this task?")).not.toBeInTheDocument();
    expect(mockedTasksApi.cancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /cancel task/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));

    await waitFor(() => expect(mockedTasksApi.cancel).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0));
  });

  it("shows a disabled 'Cancelling…' state while a cancellation is pending, and cancellation events appear in the activity log", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "WORKING", cancelRequested: true }));
    mockedTasksApi.listEvents.mockResolvedValue([
      makeEvent({ id: "e1", type: "CANCEL_REQUESTED" }),
      makeEvent({ id: "e2", type: "EXECUTION_CANCELLED" }),
      makeEvent({ id: "e3", type: "TASK_CANCELLED" }),
    ]);

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Cancelling…")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /cancel task/i })).not.toBeInTheDocument();
    expect(screen.getByText("Cancellation requested")).toBeInTheDocument();
    expect(screen.getByText("Execution stopped")).toBeInTheDocument();
    expect(screen.getByText("Task cancelled")).toBeInTheDocument();
  });

  it("shows duration stats derived from the report when durations are available", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "DONE", completedAt: "2026-01-01T00:20:00.000Z" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Done",
        durations: { totalMs: 20 * 60 * 1000, implementationMs: 5 * 60 * 1000, reviewMs: null, validationMs: 30 * 1000, waitingForHumanReviewMs: null },
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("20m")).toBeInTheDocument());
    expect(screen.getByText("5m")).toBeInTheDocument();
    expect(screen.getByText("30s")).toBeInTheDocument();
    // No stat rendered for a duration that isn't computable (reviewMs: null) — never fabricated.
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
  });

  it("shows a recovery banner when the task's history includes a crash-recovery resume", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    mockedTasksApi.getReport.mockResolvedValue(makeReport({ status: "Ready for review", recoveredFromCrash: true }));

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Recovered from a crash")).toBeInTheDocument());
  });

  it("does not show a recovery banner for a normal task with no interrupted runs", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    mockedTasksApi.getReport.mockResolvedValue(makeReport({ status: "Ready for review", recoveredFromCrash: false }));

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    expect(screen.queryByText("Recovered from a crash")).not.toBeInTheDocument();
  });

  it("shows which stage/role/attempt failed, in addition to the failure reason, when failureContext is present", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "FAILED", completedAt: "2026-01-01T00:20:00.000Z" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Failed",
        failureReason: "Gemini returned retryable HTTP 503 after 2 attempts.",
        failureContext: { stage: "Agent invocation", failedRole: "implementer", attemptNumber: 2, recoveredFromCrash: false },
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText(/Agent invocation/)).toBeInTheDocument());
    expect(screen.getByText(/attempt 2/)).toBeInTheDocument();
  });

  it("exposes the full agent run history (implementer + reviewer, multiple attempts) inside an expandable Execution details section", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "REVIEW" }));
    mockedTasksApi.getReport.mockResolvedValue(
      makeReport({
        status: "Ready for review",
        agentRuns: [
          makeAgentRunHistoryItem({ id: "r1", attemptNumber: 1, trigger: "initial" }),
          makeAgentRunHistoryItem({ id: "r2", role: "reviewer", attemptNumber: 1, trigger: "review", verdict: "approved" }),
        ],
      }),
    );

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("Execution details")).toBeInTheDocument());
    expect(screen.getAllByText("Implementer").length).toBeGreaterThan(0);
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("existing report shape (no agentRuns/durations) still renders correctly — backward compatibility", async () => {
    mockedTasksApi.get.mockResolvedValue(makeTask({ status: "DONE", completedAt: "2026-01-01T00:20:00.000Z" }));
    // Deliberately the exact minimal shape earlier milestones' tests already relied on.
    mockedTasksApi.getReport.mockResolvedValue(makeReport({ status: "Done", whatChanged: "Updated session timeout handling.", filesChanged: 5 }));

    renderApp("/tasks/task-1");

    await waitFor(() => expect(screen.getByText("✓ Completed")).toBeInTheDocument());
    expect(screen.getByText("Updated session timeout handling.")).toBeInTheDocument();
    expect(screen.getByText("5 files changed")).toBeInTheDocument();
  });
});
