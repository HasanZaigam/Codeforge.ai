import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeTask, makeWorkspace } from "../test/fixtures.js";
import { projectsApi } from "../api/index.js";

vi.mock("../api/projects.js", () => ({
  projectsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    getWorkspace: vi.fn(),
  },
}));

const mockedProjectsApi = vi.mocked(projectsApi);

describe("ProjectsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads and displays projects", async () => {
    mockedProjectsApi.list.mockResolvedValue([makeProject({ id: "p1", name: "OTT" }), makeProject({ id: "p2", name: "E-True" })]);

    renderApp("/");

    expect(screen.getByText("Loading projects…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("OTT")).toBeInTheDocument());
    expect(screen.getByText("E-True")).toBeInTheDocument();
  });

  it("shows an empty state with no projects", async () => {
    mockedProjectsApi.list.mockResolvedValue([]);
    renderApp("/");
    await waitFor(() => expect(screen.getByText(/no projects connected yet/i)).toBeInTheDocument());
  });

  it("opening a project navigates to its board and loads its tasks", async () => {
    mockedProjectsApi.list.mockResolvedValue([makeProject({ id: "p1", name: "OTT" })]);
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t1", status: "TODO", title: "Fix bug" })]);
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));

    renderApp("/");
    await waitFor(() => expect(screen.getByText("OTT")).toBeInTheDocument());

    await userEvent.click(screen.getByText("OTT"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());
    expect(mockedProjectsApi.listTasks).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(screen.getByText("Fix bug")).toBeInTheDocument());
  });

  it("surfaces an API failure with a retry action", async () => {
    mockedProjectsApi.list.mockRejectedValueOnce(new Error("Request failed (500)"));
    mockedProjectsApi.list.mockResolvedValueOnce([makeProject({ id: "p1", name: "OTT" })]);

    renderApp("/");
    await waitFor(() => expect(screen.getByText(/couldn't load your projects/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText("OTT")).toBeInTheDocument());
  });
});
