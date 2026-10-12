import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

describe("ProjectLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedChatApi.listMessages.mockResolvedValue({ messages: [], pendingAction: null });
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT", repoUrl: "https://github.com/example/ott.git" }));
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext({ project: { name: "OTT" } }));
  });

  it("renders the project header and Overview by default", async () => {
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());
    expect(screen.getByText("https://github.com/example/ott.git")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveClass("active");
  });

  it("navigates Overview -> Tasks -> Workspace -> Settings via the project tabs, each a distinct screen", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t1", title: "Fix bug", status: "TODO" })]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("link", { name: "Tasks" }));
    await waitFor(() => expect(screen.getByText("Fix bug")).toBeInTheDocument());
    expect(document.querySelector(".board")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Workspace" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project Context" })).toBeInTheDocument());
    expect(document.querySelector(".board")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(screen.getByText("Project settings are currently read-only from this screen.")).toBeInTheDocument());
  });

  it("shows exactly the primary navigation Overview, Workspace, Tasks, Settings — no Issues & Requests, Chat, or Advanced tab", async () => {
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());
    const tabs = screen.getAllByRole("link").map((l) => l.textContent);
    const navTabs = tabs.filter((t) => ["Overview", "Workspace", "Tasks", "Settings"].includes(t ?? ""));
    expect(navTabs).toEqual(["Overview", "Workspace", "Tasks", "Settings"]);
    expect(tabs).not.toContain("Issues & Requests");
    expect(tabs).not.toContain("Backlog");
    expect(tabs).not.toContain("Chat");
    expect(tabs).not.toContain("Evaluation");
    expect(tabs).not.toContain("Advanced Features");
  });

  it("legacy: the old /backlog list URL redirects to Overview rather than 404ing or showing a dead page", async () => {
    renderApp("/projects/p1/backlog");
    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());
    expect(screen.getByText("https://github.com/example/ott.git")).toBeInTheDocument();
    // The <Navigate> redirect lands a render after the project header first appears.
    await waitFor(() => expect(screen.getByRole("link", { name: "Overview" })).toHaveClass("active"));
  });

  it("the breadcrumb returns to the Projects list", async () => {
    mockedProjectsApi.list.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("link", { name: "Projects" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument());
  });

  it("shows an error state when the project fails to load, instead of a broken tab layout", async () => {
    mockedProjectsApi.get.mockRejectedValue(new Error("boom"));
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText("Couldn't load this project.")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Tasks" })).not.toBeInTheDocument();
  });
});
