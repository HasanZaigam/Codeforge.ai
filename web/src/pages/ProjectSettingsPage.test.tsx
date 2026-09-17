import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject } from "../test/fixtures.js";
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

  it("Save Changes stays disabled until a command is actually edited, then sends the full commands object", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: { build: "npm run build" } }));
    mockedProjectsApi.updateCommands.mockResolvedValue(
      makeProject({ id: "p1", commands: { build: "npm run build", typecheck: "npm run typecheck" } }),
    );
    renderApp("/projects/p1/settings");

    await waitFor(() => expect(screen.getByLabelText("Build")).toHaveValue("npm run build"));
    const saveButton = screen.getByRole("button", { name: /^Save Changes$/ });
    expect(saveButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Typecheck"), "npm run typecheck");
    expect(saveButton).not.toBeDisabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await userEvent.click(saveButton);

    await waitFor(() => expect(mockedProjectsApi.updateCommands).toHaveBeenCalledWith("p1", { build: "npm run build", typecheck: "npm run typecheck" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save Changes$/ })).toBeDisabled());
  });

  it("clearing a previously-set command and saving sends it as omitted, not an empty string", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: { build: "npm run build", test: "npm test" } }));
    mockedProjectsApi.updateCommands.mockResolvedValue(makeProject({ id: "p1", commands: { test: "npm test" } }));
    renderApp("/projects/p1/settings");

    await waitFor(() => expect(screen.getByLabelText("Build")).toHaveValue("npm run build"));
    await userEvent.clear(screen.getByLabelText("Build"));
    await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

    await waitFor(() => expect(mockedProjectsApi.updateCommands).toHaveBeenCalledWith("p1", { test: "npm test" }));
  });

  it("a save failure preserves the user's edits and shows a retryable error", async () => {
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", commands: {} }));
    mockedProjectsApi.updateCommands.mockRejectedValue(new Error("network down"));
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
