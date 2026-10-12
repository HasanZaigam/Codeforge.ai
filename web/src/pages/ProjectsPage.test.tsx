import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeProjectContext, makeRepository, makeTask, makeWorkspace } from "../test/fixtures.js";
import { projectsApi } from "../api/index.js";

vi.mock("../api/projects.js", () => ({
  projectsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    addRepository: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    getWorkspace: vi.fn(),
    getContext: vi.fn(),
    updateContext: vi.fn(),
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
    await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument());
  });

  it("opening a project navigates to its Overview, and its Tasks tab loads its tasks", async () => {
    mockedProjectsApi.list.mockResolvedValue([makeProject({ id: "p1", name: "OTT" })]);
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t1", status: "TODO", title: "Fix bug" })]);
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext({ project: { name: "OTT" } }));

    renderApp("/");
    await waitFor(() => expect(screen.getByText("OTT")).toBeInTheDocument());

    await userEvent.click(screen.getByText("OTT"));

    // Projects -> Project Overview, a distinct screen from the task board.
    await waitFor(() => expect(screen.getByRole("heading", { name: "OTT" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Overview" })).toHaveClass("active");

    await userEvent.click(screen.getByRole("link", { name: "Tasks" }));
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

  describe("guided repository setup after Create Project", () => {
    const empty = makeProject({ id: "p9", name: "OTT", repositories: [], repoUrl: "" });
    const backend = makeRepository({ id: "be", projectId: "p9", name: "backend", sourceControlProvider: "local-git", repoUrl: "/srv/api" });

    async function createProject(setup: "One repository" | "Several repositories") {
      mockedProjectsApi.list.mockResolvedValue([]);
      mockedProjectsApi.create.mockResolvedValue(empty);
      mockedProjectsApi.get.mockResolvedValue(empty);
      mockedProjectsApi.listTasks.mockResolvedValue([]);
      mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ projectId: "p9" }));
      mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext());
      mockedProjectsApi.addRepository.mockResolvedValue(backend);
      renderApp("/");

      await userEvent.click(await screen.findByRole("button", { name: "Create Project" }));
      await userEvent.type(screen.getByLabelText("Project name"), "OTT");
      const choice = screen.getByRole("radio", { name: new RegExp(setup) });
      await userEvent.click(choice);
      expect(choice).toHaveAttribute("aria-checked", "true");
      await userEvent.click(screen.getByRole("button", { name: "Create project" }));
      expect(mockedProjectsApi.create).toHaveBeenCalledWith({ name: "OTT" });
    }

    async function connectBackend() {
      const dialog = await screen.findByRole("dialog", { name: "Connect a repository" });
      await userEvent.selectOptions(within(dialog).getByLabelText("Source control"), "local-git");
      await userEvent.type(within(dialog).getByLabelText("Repository name *"), "backend");
      await userEvent.type(within(dialog).getByLabelText("Repository URL *"), "/srv/api");
      await userEvent.click(within(dialog).getByRole("button", { name: "Connect repository" }));
    }

    it("defaults to 'One repository'", async () => {
      mockedProjectsApi.list.mockResolvedValue([]);
      renderApp("/");
      await userEvent.click(await screen.findByRole("button", { name: "Create Project" }));
      expect(screen.getByRole("radio", { name: /One repository/ })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: /Several repositories/ })).toHaveAttribute("aria-checked", "false");
    });

    it("'One repository' opens the connect dialog straight away, then goes to the Overview once it's connected", async () => {
      await createProject("One repository");
      await connectBackend();
      expect(await screen.findByRole("heading", { name: "Project Chat" })).toBeInTheDocument();
    });

    it("'Several repositories' keeps offering 'Connect another' until Done", async () => {
      await createProject("Several repositories");
      await connectBackend();

      expect(await screen.findByText(/1 repository connected: backend/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Connect another repository" }));
      expect(await screen.findByRole("dialog", { name: "Connect a repository" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await userEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(await screen.findByRole("heading", { name: "Project Chat" })).toBeInTheDocument();
    });
  });
});
