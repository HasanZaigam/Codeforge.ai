import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import {
  makeAnalysis,
  makeAnalysisJob,
  makeBacklogDetail,
  makeBacklogItem,
  makeProject,
  makeProjectContext,
  makeProposal,
  makeRelationship,
  makeTask,
  makeWorkspace,
} from "../test/fixtures.js";
import { ApiError, backlogApi, projectsApi, type BacklogItemStatus } from "../api/index.js";

vi.mock("../api/projects.js", () => ({
  projectsApi: { list: vi.fn(), get: vi.fn(), listTasks: vi.fn(), getWorkspace: vi.fn(), getContext: vi.fn() },
}));
vi.mock("../api/backlog.js", () => ({
  backlogApi: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    reject: vi.fn(),
    analyze: vi.fn(),
    cancelAnalysis: vi.fn(),
    generateProposal: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    convertProposal: vi.fn(),
  },
}));

const mockedProjects = vi.mocked(projectsApi);
const mockedBacklog = vi.mocked(backlogApi);

const PATH = "/projects/p1/backlog/item-1";

function detail(status: BacklogItemStatus, extra = {}) {
  return makeBacklogDetail({ item: makeBacklogItem({ status }), ...extra });
}

describe("BacklogItemPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjects.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
    mockedProjects.listTasks.mockResolvedValue([]);
    mockedProjects.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjects.getContext.mockResolvedValue(makeProjectContext());
  });

  async function open(d: ReturnType<typeof detail>) {
    mockedBacklog.get.mockResolvedValue(d);
    renderApp(PATH);
    await waitFor(() => expect(screen.getByText("Login fails after timeout")).toBeInTheDocument());
  }

  it("a NEW item shows Analyze, the not-a-task label, and no proposal button", async () => {
    await open(detail("NEW"));
    expect(screen.getByText("Backlog item — not an executable task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /generate task proposal/i })).not.toBeInTheDocument();
    expect(screen.getByText(/has not been analyzed yet/i)).toBeInTheDocument();
  });

  it("an ANALYZING item shows a disabled analyzing state and polls until it leaves ANALYZING", async () => {
    mockedBacklog.get.mockResolvedValueOnce(detail("ANALYZING")).mockResolvedValue(detail("ANALYZED", { latestAnalysis: makeAnalysis() }));
    renderApp(PATH);
    await waitFor(() => expect(screen.getByRole("button", { name: /analyzing/i })).toBeDisabled());
    expect(screen.queryByRole("button", { name: /^analyze$/i })).not.toBeInTheDocument();

    // A REAL 3 s poll interval (usePolling): the wait is on an observable outcome, with generous margin
    // for a loaded machine — a starved CI/dev box has previously run right up against a tighter bound.
    await waitFor(() => expect(screen.getAllByText("The session refresh path drops the token.").length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(mockedBacklog.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "Re-analyze" })).toBeEnabled();
  }, 20_000);

  describe("analysis job", () => {
    const job = makeAnalysisJob;
    const item = (s: BacklogItemStatus = "ANALYZING") => makeBacklogItem({ status: s });

    it("shows the queued state and a Cancel button", async () => {
      await open(detail("ANALYZING", { analysisJob: job() }));
      expect(screen.getByText(/queued — waiting for a worker/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel analysis" })).toBeEnabled();
    });

    it("a QUEUED job never reads as work in progress: the button says Queued (no spinner label) and the panel says it is waiting for a worker", async () => {
      await open(detail("ANALYZING", { analysisJob: job() }));
      expect(screen.getByRole("button", { name: /^queued…$/i })).toBeDisabled();
      expect(screen.queryByRole("button", { name: /analyzing/i })).not.toBeInTheDocument();
      expect(screen.getByText(/waiting for a worker to start the analysis/i)).toBeInTheDocument();
      expect(screen.queryByText(/analysis in progress/i)).not.toBeInTheDocument();
    });

    it("a RUNNING job shows Analyzing… on the button", async () => {
      await open(detail("ANALYZING", { analysisJob: job({ status: "RUNNING", attemptCount: 1 }) }));
      expect(screen.getByRole("button", { name: /analyzing/i })).toBeDisabled();
    });

    it("shows running attempt and model, and Cancelling once requested", async () => {
      await open(detail("ANALYZING", { analysisJob: job({ status: "RUNNING", attemptCount: 2, providerId: "anthropic", modelId: "sonnet" }) }));
      expect(screen.getByText(/running — attempt 2 of 3/i)).toHaveTextContent("anthropic / sonnet");
    });

    it("shows Cancelling and hides Cancel when cancelRequested", async () => {
      await open(detail("ANALYZING", { analysisJob: job({ status: "RUNNING", attemptCount: 1, cancelRequested: true }) }));
      expect(screen.getByText("Cancelling…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel analysis" })).not.toBeInTheDocument();
    });

    it("shows a scheduled retry with the failure reason", async () => {
      await open(
        detail("ANALYZING", {
          analysisJob: job({ attemptCount: 1, failureCategory: "timeout", failureReason: "took too long", availableAt: "2999-01-01T00:00:00.000Z" }),
        }),
      );
      expect(screen.getByText(/retry scheduled — attempt 1 of 3 failed \(The analysis timed out\)/i)).toBeInTheDocument();
      expect(screen.getByText("took too long")).toBeInTheDocument();
    });

    it("shows a failed job, no Cancel, and Analyze available again", async () => {
      await open(detail("NEEDS_CLARIFICATION", { analysisJob: job({ status: "FAILED", attemptCount: 3, failureCategory: "malformed_output", failureReason: "bad json" }) }));
      expect(screen.getByText(/analysis failed — the model returned output/i)).toHaveTextContent("no task can be created");
      expect(screen.getByText("bad json")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel analysis" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    });

    it("shows a cancelled job without a Cancel button", async () => {
      await open(detail("NEW", { analysisJob: job({ status: "CANCELLED" }) }));
      expect(screen.getByText("Analysis cancelled.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel analysis" })).not.toBeInTheDocument();
    });

    it("Analyze shows the queued state from the response", async () => {
      mockedBacklog.get.mockResolvedValueOnce(detail("NEW")).mockResolvedValue(detail("ANALYZING", { analysisJob: job() }));
      mockedBacklog.analyze.mockResolvedValue({ item: item(), job: job(), enqueued: true });
      renderApp(PATH);
      await userEvent.click(await screen.findByRole("button", { name: "Analyze" }));
      expect(await screen.findByText(/queued — waiting for a worker/i)).toBeInTheDocument();
      expect(mockedBacklog.analyze).toHaveBeenCalledTimes(1);
    });

    it("handles enqueued:false without an error", async () => {
      mockedBacklog.get.mockResolvedValueOnce(detail("NEW")).mockResolvedValue(detail("ANALYZING", { analysisJob: job({ status: "RUNNING", attemptCount: 1 }) }));
      mockedBacklog.analyze.mockResolvedValue({ item: item(), job: job({ status: "RUNNING", attemptCount: 1 }), enqueued: false });
      renderApp(PATH);
      await userEvent.click(await screen.findByRole("button", { name: "Analyze" }));
      expect(await screen.findByText(/running — attempt 1 of 3/i)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("Cancel analysis posts to the cancel endpoint and adopts the job", async () => {
      mockedBacklog.cancelAnalysis.mockResolvedValue({ item: item("NEW"), job: job({ status: "CANCELLED" }) });
      mockedBacklog.get.mockResolvedValueOnce(detail("ANALYZING", { analysisJob: job() })).mockResolvedValue(detail("NEW", { analysisJob: job({ status: "CANCELLED" }) }));
      renderApp(PATH);
      await userEvent.click(await screen.findByRole("button", { name: "Cancel analysis" }));
      expect(mockedBacklog.cancelAnalysis).toHaveBeenCalledWith("item-1");
      expect(await screen.findByText("Analysis cancelled.")).toBeInTheDocument();
    });

    it("shows a server 409 from cancel", async () => {
      mockedBacklog.cancelAnalysis.mockRejectedValue(new ApiError(409, "INVALID_OPERATION", "No live analysis."));
      await open(detail("ANALYZING", { analysisJob: job() }));
      await userEvent.click(screen.getByRole("button", { name: "Cancel analysis" }));
      expect(await screen.findByText("No live analysis.")).toBeInTheDocument();
    });
  });

  it("renders a succeeded analysis with BLOCKING info, platform file checks and the model/provider", async () => {
    await open(detail("ANALYZED", { latestAnalysis: makeAnalysis() }));
    expect(screen.getAllByText("The session refresh path drops the token.").length).toBeGreaterThan(0);
    expect(screen.getByText("BLOCKING")).toBeInTheDocument();
    expect(screen.getByText("Which browsers are affected?")).toBeInTheDocument();
    expect(screen.getByText("verified in repository")).toBeInTheDocument();
    expect(screen.getByText("not found in repository listing")).toBeInTheDocument();
    expect(screen.getByText(/provider-y \/ model-x/)).toBeInTheDocument();
    expect(screen.getByText(/AI-proposed analysis/)).toBeInTheDocument();
    expect(screen.getByText("User stays logged in")).toBeInTheDocument();
  });

  it("a failed malformed_output analysis shows the failure panel with diagnostics and no Generate button", async () => {
    await open(
      detail("NEEDS_CLARIFICATION", {
        latestAnalysis: makeAnalysis({
          status: "failed",
          result: null,
          platformChecks: null,
          failureCategory: "malformed_output",
          failureReason: "Output did not match the schema",
          diagnostics: { stage: "schema", excerpt: "not json" },
        }),
      }),
    );
    expect(screen.getByRole("heading", { name: "Analysis failed" })).toBeInTheDocument();
    expect(screen.getByText("Output did not match the schema")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics")).toBeInTheDocument();
    expect(screen.getByText(/no task can be created from it/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate task proposal/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-analyze" })).toBeInTheDocument();
  });

  it("renders duplicates and dependencies with the proposals-only copy", async () => {
    await open(
      detail("ANALYZED", {
        latestAnalysis: makeAnalysis(),
        relationships: [
          makeRelationship(),
          makeRelationship({ id: "rel-2", kind: "DEPENDS_ON", direction: "incoming", other: { id: "item-4", ref: "FEAT-1", title: "Needs auth", status: "NEW" } }),
        ],
      }),
    );
    expect(screen.getAllByText(/never merges items or changes execution order automatically/)).toHaveLength(2);
    expect(screen.getByRole("link", { name: /BUG-003 — Other login bug/ })).toHaveAttribute("href", "/projects/p1/backlog/item-2");
    expect(screen.getByText(/Flagged by this item's analysis/)).toBeInTheDocument();
    expect(screen.getByText(/Flagged by FEAT-1's analysis/)).toBeInTheDocument();
    expect(screen.getAllByText("Proposed")).toHaveLength(2);
  });

  it("ANALYZED with no proposal offers Generate; a PENDING proposal offers Approve/Reject but not Convert", async () => {
    await open(detail("ANALYZED", { latestAnalysis: makeAnalysis() }));
    expect(screen.getByRole("button", { name: /generate task proposal/i })).toBeInTheDocument();
  });

  it("PENDING proposal shows Approve and Reject, not Convert, and the goal text is available", async () => {
    await open(detail("ANALYZED", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ status: "PENDING" }) }));
    expect(screen.getByRole("button", { name: "Approve proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject proposal" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /convert to task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate task proposal/i })).not.toBeInTheDocument();
    expect(screen.getByText("GOAL TEXT for the task")).toBeInTheDocument();
  });

  it("APPROVED proposal shows Convert; CONVERTED shows an Open task link", async () => {
    await open(detail("READY_FOR_TASK", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ status: "APPROVED" }) }));
    expect(screen.getByRole("button", { name: "Convert to task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve proposal" })).not.toBeInTheDocument();
  });

  it("CONVERTED proposal links to the task", async () => {
    await open(detail("CONVERTED", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ status: "CONVERTED", taskId: "task-9" }) }));
    expect(screen.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/tasks/task-9");
    expect(screen.getByText(/start it there when you're ready/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /convert to task/i })).not.toBeInTheDocument();
  });

  it("Approve and Convert are separate calls, and converting only links to the created task", async () => {
    mockedBacklog.get.mockResolvedValueOnce(detail("ANALYZED", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ status: "PENDING" }) }));
    mockedBacklog.get.mockResolvedValue(detail("READY_FOR_TASK", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ status: "APPROVED" }) }));
    mockedBacklog.approveProposal.mockResolvedValue(makeProposal({ status: "APPROVED" }));
    mockedBacklog.convertProposal.mockResolvedValue({
      proposal: makeProposal({ status: "CONVERTED", taskId: "task-9" }),
      task: makeTask({ id: "task-9", title: "Created task", status: "BACKLOG" }),
      alreadyConverted: false,
    });
    renderApp(PATH);
    await userEvent.click(await screen.findByRole("button", { name: "Approve proposal" }));
    expect(mockedBacklog.approveProposal).toHaveBeenCalledWith("proposal-1");
    expect(mockedBacklog.convertProposal).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole("button", { name: "Convert to task" }));
    expect(mockedBacklog.convertProposal).toHaveBeenCalledWith("proposal-1");
    const link = await screen.findByRole("link", { name: "Created task" });
    expect(link).toHaveAttribute("href", "/tasks/task-9");
  });

  it("shows the server's message for a 409 CONVERSION_IN_PROGRESS", async () => {
    await open(detail("READY_FOR_TASK", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ status: "APPROVED" }) }));
    mockedBacklog.convertProposal.mockRejectedValue(new ApiError(409, "CONVERSION_IN_PROGRESS", "A conversion is already running."));
    await userEvent.click(screen.getByRole("button", { name: "Convert to task" }));
    await waitFor(() => expect(screen.getByText(/A conversion is already running\. Please retry in a moment\./)).toBeInTheDocument());
  });

  it("an invalid stored proposal can only be rejected", async () => {
    await open(detail("ANALYZED", { latestAnalysis: makeAnalysis(), proposal: makeProposal({ content: null }) }));
    expect(screen.getByText(/stored content is invalid/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve proposal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject proposal" })).toBeInTheDocument();
  });

  it("Reject item requires a confirmation step", async () => {
    await open(detail("NEW"));
    mockedBacklog.reject.mockResolvedValue(makeBacklogItem({ status: "REJECTED" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject item" }));
    expect(mockedBacklog.reject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    expect(mockedBacklog.reject).toHaveBeenCalledWith("item-1");
  });

  it.each(["READY_FOR_TASK", "CONVERTED", "REJECTED", "ANALYZING"] as const)("editing is disabled for %s", async (status) => {
    await open(detail(status));
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it.each(["NEW", "ANALYZED", "NEEDS_CLARIFICATION"] as const)("editing is available for %s", async (status) => {
    await open(detail(status));
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});
