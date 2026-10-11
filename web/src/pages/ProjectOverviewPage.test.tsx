import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeProjectContext, makeTask, makeWorkspace } from "../test/fixtures.js";
import { chatApi, projectsApi } from "../api/index.js";

vi.mock("../api/chat.js", () => ({
  chatApi: { listMessages: vi.fn(), sendMessage: vi.fn(), listSuggestions: vi.fn(), createTasks: vi.fn() },
}));

vi.mock("../api/projects.js", () => ({
  projectsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    verifyGitHubRepo: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    listBranches: vi.fn(),
    getWorkspace: vi.fn(),
    getContext: vi.fn(),
    updateContext: vi.fn(),
  },
}));

const mockedProjectsApi = vi.mocked(projectsApi);
const mockedChatApi = vi.mocked(chatApi);

describe("ProjectOverviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedChatApi.listMessages.mockResolvedValue({ messages: [], pendingAction: null });
    mockedProjectsApi.get.mockResolvedValue(
      makeProject({ id: "p1", name: "OTT", repoUrl: "https://github.com/example/ott.git", defaultBranch: "main", sourceControlProvider: "github" }),
    );
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext({ project: { name: "OTT" } }));
  });

  it("shows Chat as the primary area, with a compact repo/branch meta line — no large Project Details card", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("github")).toBeInTheDocument());
    expect(screen.getByText("branch: main")).toBeInTheDocument();
    // The old card is gone — no "Created"/"Updated" timestamps or duplicated repo details on Overview.
    expect(screen.queryByText(/^Created /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();
    // Chat's own conversation load is a separate async step from the project load above.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project Chat" })).toBeInTheDocument());
  });

  it("shows a compact status-pill summary derived from the actual task list, not a giant grid of cards", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t1", status: "TODO" }),
      makeTask({ id: "t2", status: "TODO" }),
      makeTask({ id: "t3", status: "DONE" }),
    ]);
    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("To do")).toBeInTheDocument());
    const pill = screen.getByText("To do").closest(".overview-status-pill")!;
    expect(pill).toHaveTextContent("2");
  });

  it("shows an empty-task hint rather than a fabricated count when there are no tasks", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText("No tasks yet.")).toBeInTheDocument());
  });

  it("prioritizes tasks needing attention over a wall of zero-counts", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t1", title: "Needs a decision", status: "NEEDS_INPUT" }),
      makeTask({ id: "t2", title: "Ready to merge", status: "REVIEW" }),
      makeTask({ id: "t3", title: "Still working", status: "WORKING" }),
    ]);
    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("Needs attention (2)")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Needs a decision" })).toHaveAttribute("href", "/tasks/t1");
    expect(screen.getByRole("link", { name: "Ready to merge" })).toHaveAttribute("href", "/tasks/t2");
    expect(screen.queryByText("Still working")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing needs your attention right now.")).not.toBeInTheDocument();
  });

  it("shows every FAILED/REVIEW/NEEDS_INPUT task, not just a truncated handful — the attention list scrolls internally instead", async () => {
    const many = Array.from({ length: 12 }, (_, i) => makeTask({ id: `f${i}`, title: `Failed task ${i}`, status: "FAILED" }));
    mockedProjectsApi.listTasks.mockResolvedValue(many);
    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("Needs attention (12)")).toBeInTheDocument());
    for (const t of many) {
      expect(screen.getByRole("link", { name: t.title })).toBeInTheDocument();
    }
  });

  it("shows a calm confirmation, not empty boxes, when nothing needs attention", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t1", status: "WORKING" })]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText("Nothing needs your attention right now.")).toBeInTheDocument());
  });

  // Regression: "View all tasks" and "Open workspace" previously used relative links (`to="../tasks"`)
  // from this *index* route. React Router resolves `..` from an index route as if it were nested one
  // level deeper than its parent, so `../tasks` landed on `/tasks` (no such route → blank page)
  // instead of `/projects/p1/tasks`. Both links are now absolute (`/projects/${project.id}/...`).
  it("Tasks 'View all →' navigates to this project's own Tasks tab, not a top-level /tasks route", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument());

    const tasksBlock = screen.getByRole("heading", { name: "Tasks" }).closest(".overview-block") as HTMLElement;
    await userEvent.click(within(tasksBlock).getByRole("link", { name: /view all/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveClass("active");
  });

  it("Workspace 'Open →' navigates to this project's own Workspace tab, not a top-level /workspace route", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument());

    const workspaceBlock = screen.getByRole("heading", { name: "Workspace" }).closest(".overview-block") as HTMLElement;
    await userEvent.click(within(workspaceBlock).getByRole("link", { name: /open/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Project Context" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveClass("active");
  });
});
