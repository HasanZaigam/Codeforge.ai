import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeEvent, makeInputRequest, makeReport, makeTask } from "../test/fixtures.js";
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
});
