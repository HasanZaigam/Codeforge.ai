import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeRepository } from "../test/fixtures.js";
import { ApiError } from "../api/index.js";
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
    updateCommands: vi.fn(),
    updateRepositoryCommands: vi.fn(),
    addRepository: vi.fn(),
    updateRepository: vi.fn(),
    removeRepository: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockedProjectsApi = vi.mocked(projectsApi);

describe("ProjectSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders read-only project fields and pre-fills declared commands", async () => {
    mockedProjectsApi.get.mockResolvedValue(
      makeProject({ id: "p1", name: "OTT", commands: { build: "npm run build", test: "npm test" } }),
    );
    renderApp("/projects/p1/settings");

    await waitFor(() => expect(screen.getByText("Project name")).toBeInTheDocument());
    const infoCallout = document.querySelector(".info-callout") as HTMLElement;
    expect(within(infoCallout).getByText("OTT")).toBeInTheDocument();
    expect(screen.getByLabelText("Build")).toHaveValue("npm run build");
    expect(screen.getByLabelText("Test")).toHaveValue("npm test");
    expect(screen.getByLabelText("Lint")).toHaveValue("");
  });

  it("a project with no repository shows a clear call to connect one", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", repositories: [] }));
    renderApp("/projects/p1/settings");
    expect(await screen.findByText(/No repository connected yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect your first repository" })).toBeInTheDocument();
  });

  it("lists each repository with its own validation commands — a multi-repository project", async () => {
    mockedProjectsApi.get.mockResolvedValue(
      makeProject({
        id: "p1",
        repositories: [
          makeRepository({ id: "fe", projectId: "p1", name: "frontend", repoUrl: "https://github.com/acme/web.git", commands: { test: "npm test" } }),
          makeRepository({ id: "be", projectId: "p1", name: "backend", repoUrl: "https://github.com/acme/api.git", commands: { build: "go build ./..." } }),
        ],
      }),
    );
    renderApp("/projects/p1/settings");

    const frontend = await screen.findByRole("article", { name: "Repository frontend" });
    const backend = screen.getByRole("article", { name: "Repository backend" });
    expect(within(frontend).getByLabelText("Test")).toHaveValue("npm test");
    expect(within(backend).getByLabelText("Build")).toHaveValue("go build ./...");
    expect(within(backend).getByLabelText("Test")).toHaveValue("");
  });

  it("connecting another repository adds it to the list", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", repositories: [] }));
    mockedProjectsApi.addRepository.mockResolvedValue(makeRepository({ id: "be", projectId: "p1", name: "backend", sourceControlProvider: "local-git", repoUrl: "/srv/api" }));
    renderApp("/projects/p1/settings");

    await userEvent.click(await screen.findByRole("button", { name: "Connect your first repository" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect a repository" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Source control"), "local-git");
    await userEvent.type(within(dialog).getByLabelText("Repository name *"), "backend");
    await userEvent.type(within(dialog).getByLabelText("Repository URL *"), "/srv/api");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect repository" }));

    expect(await screen.findByRole("article", { name: "Repository backend" })).toBeInTheDocument();
    expect(mockedProjectsApi.addRepository).toHaveBeenCalledWith("p1", { sourceControlProvider: "local-git", name: "backend", repoUrl: "/srv/api" });
  });

  it("removing a repository that tasks still use shows the server's explanation and keeps it", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1" }));
    mockedProjectsApi.removeRepository.mockRejectedValue(new ApiError(409, "REPOSITORY_IN_USE", '"ott" is still used by 2 tasks — it can\'t be removed while anything targets it.'));
    renderApp("/projects/p1/settings");

    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove repository" }));
    expect(await screen.findByText(/still used by 2 tasks/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep repository" }));
    expect(await screen.findByRole("article", { name: "Repository ott" })).toBeInTheDocument();
  });

  it("Save Changes stays disabled until a command is actually edited, then sends the full commands object", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: { build: "npm run build" } }));
    mockedProjectsApi.updateRepositoryCommands.mockResolvedValue(
      makeRepository({ id: "p1-repo", projectId: "p1", commands: { build: "npm run build", typecheck: "npm run typecheck" } }),
    );
    renderApp("/projects/p1/settings");

    await waitFor(() => expect(screen.getByLabelText("Build")).toHaveValue("npm run build"));
    const saveButton = screen.getByRole("button", { name: /^Save Changes$/ });
    expect(saveButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Typecheck"), "npm run typecheck");
    expect(saveButton).not.toBeDisabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await userEvent.click(saveButton);

    await waitFor(() => expect(mockedProjectsApi.updateRepositoryCommands).toHaveBeenCalledWith("p1", "p1-repo", { build: "npm run build", typecheck: "npm run typecheck" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save Changes$/ })).toBeDisabled());
  });

  it("clearing a previously-set command and saving sends it as omitted, not an empty string", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: { build: "npm run build", test: "npm test" } }));
    mockedProjectsApi.updateRepositoryCommands.mockResolvedValue(makeRepository({ id: "p1-repo", projectId: "p1", commands: { test: "npm test" } }));
    renderApp("/projects/p1/settings");

    await waitFor(() => expect(screen.getByLabelText("Build")).toHaveValue("npm run build"));
    await userEvent.clear(screen.getByLabelText("Build"));
    await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

    await waitFor(() => expect(mockedProjectsApi.updateRepositoryCommands).toHaveBeenCalledWith("p1", "p1-repo", { test: "npm test" }));
  });

  it("a save failure preserves the user's edits and shows a retryable error", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: {} }));
    mockedProjectsApi.updateRepositoryCommands.mockRejectedValue(new Error("network down"));
    renderApp("/projects/p1/settings");

    await waitFor(() => expect(screen.getByLabelText("Build")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Build"), "npm run build");
    await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

    await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
    expect(screen.getByLabelText("Build")).toHaveValue("npm run build");
  });

  describe("Danger Zone", () => {
    it("Delete project requires confirmation before anything is actually deleted", async () => {
      mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: {} }));
      renderApp("/projects/p1/settings");

      await waitFor(() => expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Delete project" }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(mockedProjectsApi.delete).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("button", { name: "Keep Project" }));
      expect(mockedProjectsApi.delete).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Delete Permanently" })).not.toBeInTheDocument();
    });

    it("confirming delete calls the API and navigates back to the Projects list", async () => {
      mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: {} }));
      mockedProjectsApi.list.mockResolvedValue([]);
      mockedProjectsApi.delete.mockResolvedValue(undefined);
      renderApp("/projects/p1/settings");

      await waitFor(() => expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete Permanently" }));

      await waitFor(() => expect(mockedProjectsApi.delete).toHaveBeenCalledWith("p1"));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument());
    });

    it("a blocked delete (active tasks) shows the server's own error and keeps the project", async () => {
      mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: {} }));
      mockedProjectsApi.delete.mockRejectedValue(new Error('This project has 1 task(s) that are still active: "Fix login"'));
      renderApp("/projects/p1/settings");

      await waitFor(() => expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete Permanently" }));

      await waitFor(() => expect(screen.getByText(/still active: "Fix login"/)).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Delete Permanently" })).toBeInTheDocument();
    });
  });
});
