import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeProjectContext, makeTask, makeWorkspace } from "../test/fixtures.js";
import { projectsApi } from "../api/index.js";

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

describe("ProjectOverviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjectsApi.get.mockResolvedValue(
      makeProject({ id: "p1", name: "OTT", repoUrl: "https://github.com/example/ott.git", defaultBranch: "main" }),
    );
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext({ project: { name: "OTT" } }));
  });

  it("renders project details from fields the backend already returns — nothing invented", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("Repository: https://github.com/example/ott.git")).toBeInTheDocument());
    expect(screen.getByText(/default branch/)).toBeInTheDocument();
  });

  it("shows a real task-status summary derived from the actual task list", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t1", status: "TODO" }),
      makeTask({ id: "t2", status: "TODO" }),
      makeTask({ id: "t3", status: "DONE" }),
    ]);
    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("To do")).toBeInTheDocument());
    const todoCell = screen.getByText("To do").closest(".overview-status-cell")!;
    expect(todoCell).toHaveTextContent("2");
  });

  it("shows an empty-task hint rather than a fabricated count when there are no tasks", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText("No tasks yet.")).toBeInTheDocument());
  });

  // Regression: "View all tasks" and "Open workspace" previously used relative links (`to="../tasks"`)
  // from this *index* route. React Router resolves `..` from an index route as if it were nested one
  // level deeper than its parent, so `../tasks` landed on `/tasks` (no such route → blank page)
  // instead of `/projects/p1/tasks`. Both links are now absolute (`/projects/${project.id}/...`).
  it("'View all tasks' navigates to this project's own Tasks tab, not a top-level /tasks route", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText("Repository: https://github.com/example/ott.git")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("link", { name: /view all tasks/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveClass("active");
  });

  it("'Open workspace' navigates to this project's own Workspace tab, not a top-level /workspace route", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText("Repository: https://github.com/example/ott.git")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("link", { name: /open workspace/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Project Context" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveClass("active");
  });
});
