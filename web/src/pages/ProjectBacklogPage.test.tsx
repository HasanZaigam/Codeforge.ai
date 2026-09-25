import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeBacklogItem, makeBacklogSummary, makeProject, makeProjectContext, makeWorkspace } from "../test/fixtures.js";
import { ApiError, backlogApi, projectsApi } from "../api/index.js";

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
    generateProposal: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    convertProposal: vi.fn(),
  },
}));

const mockedProjects = vi.mocked(projectsApi);
const mockedBacklog = vi.mocked(backlogApi);

describe("ProjectBacklogPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjects.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
    mockedProjects.listTasks.mockResolvedValue([]);
    mockedProjects.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjects.getContext.mockResolvedValue(makeProjectContext());
  });

  it("renders items with their references, statuses and secondary indicators, plus the explanatory note", async () => {
    mockedBacklog.list.mockResolvedValue([
      makeBacklogSummary({ id: "a", title: "First item", status: "ANALYZED", proposal: { id: "p", status: "CONVERTED", taskId: "t1" } }),
      makeBacklogSummary({
        id: "b",
        externalRef: null,
        title: "Second item",
        status: "NEEDS_CLARIFICATION",
        latestAnalysis: { id: "an", status: "failed", completedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ]);
    renderApp("/projects/p1/backlog");

    await waitFor(() => expect(screen.getByText("First item")).toBeInTheDocument());
    expect(screen.getByText(/They are not tasks/)).toBeInTheDocument();
    expect(screen.getByText("BUG-002")).toBeInTheDocument();
    expect(screen.getByText("Analyzed")).toBeInTheDocument();
    expect(screen.getByText("Needs clarification")).toBeInTheDocument();
    expect(screen.getByText("Analysis failed")).toBeInTheDocument();
    expect(screen.getByText("Linked task")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /First item/ })).toHaveAttribute("href", "/projects/p1/backlog/a");
  });

  it("shows an empty state", async () => {
    mockedBacklog.list.mockResolvedValue([]);
    renderApp("/projects/p1/backlog");
    await waitFor(() => expect(screen.getByText(/no backlog items yet/i)).toBeInTheDocument());
  });

  it("creates an item and it appears in the list", async () => {
    mockedBacklog.list.mockResolvedValueOnce([]).mockResolvedValue([makeBacklogSummary({ title: "Brand new" })]);
    mockedBacklog.create.mockResolvedValue(makeBacklogItem({ title: "Brand new" }));
    renderApp("/projects/p1/backlog");
    await waitFor(() => expect(screen.getByText(/no backlog items yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /new backlog item/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/title/i), "Brand new");
    await userEvent.type(within(dialog).getByLabelText(/description/i), "Some details");
    await userEvent.type(within(dialog).getByLabelText(/reference/i), "BUG-002");
    await userEvent.click(within(dialog).getByRole("button", { name: /create backlog item/i }));

    expect(mockedBacklog.create).toHaveBeenCalledWith("p1", { title: "Brand new", description: "Some details", externalRef: "BUG-002" });
    await waitFor(() => expect(screen.getByText("Brand new")).toBeInTheDocument());
  });

  it("shows the server's duplicate-reference message and keeps the dialog open", async () => {
    mockedBacklog.list.mockResolvedValue([]);
    mockedBacklog.create.mockRejectedValue(new ApiError(409, "DUPLICATE_BACKLOG_REFERENCE", "Reference BUG-002 is already used in this project."));
    renderApp("/projects/p1/backlog");
    await waitFor(() => expect(screen.getByText(/no backlog items yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /new backlog item/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/title/i), "T");
    await userEvent.type(within(dialog).getByLabelText(/description/i), "D");
    await userEvent.type(within(dialog).getByLabelText(/reference/i), "BUG-002");
    await userEvent.click(within(dialog).getByRole("button", { name: /create backlog item/i }));

    await waitFor(() => expect(screen.getByText(/already used in this project/)).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
