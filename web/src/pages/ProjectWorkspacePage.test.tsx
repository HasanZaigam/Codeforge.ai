import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeProjectContext, makeWorkspace } from "../test/fixtures.js";
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

describe("ProjectWorkspacePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
    mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext({ project: { name: "OTT" } }));
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
  });

  describe("Workspace Details", () => {
    it("requests the workspace for the current project", async () => {
      renderApp("/projects/p1/workspace");
      await waitFor(() => expect(mockedProjectsApi.getWorkspace).toHaveBeenCalledWith("p1"));
    });

    it("renders workspace details, reachable from the left-nav even while Project Context is the active section", async () => {
      mockedProjectsApi.getWorkspace.mockResolvedValue(
        makeWorkspace({
          id: "workspace-xyz",
          projectId: "p1",
          createdAt: "2026-01-02T10:00:00.000Z",
          updatedAt: "2026-01-03T11:00:00.000Z",
        }),
      );

      renderApp("/projects/p1/workspace");

      await waitFor(() => expect(screen.getByText(/Workspace ID: workspace-xyz/)).toBeInTheDocument());
      expect(screen.getByText(/Created:/)).toBeInTheDocument();
      expect(screen.getByText(/Updated:/)).toBeInTheDocument();
    });

    it("shows a loading state before the workspace request resolves", async () => {
      let resolveWorkspace!: (value: ReturnType<typeof makeWorkspace>) => void;
      mockedProjectsApi.getWorkspace.mockReturnValue(
        new Promise((resolve) => {
          resolveWorkspace = resolve;
        }),
      );

      renderApp("/projects/p1/workspace");

      expect(await screen.findByText("Loading workspace…")).toBeInTheDocument();
      resolveWorkspace(makeWorkspace({ id: "workspace-1", projectId: "p1" }));
      await waitFor(() => expect(screen.queryByText("Loading workspace…")).not.toBeInTheDocument());
    });

    it("shows a safe error state when the workspace request fails, without breaking Project Context", async () => {
      mockedProjectsApi.getWorkspace.mockRejectedValue(new Error("boom"));

      renderApp("/projects/p1/workspace");

      await waitFor(() => expect(screen.getByText("Couldn't load the workspace for this project.")).toBeInTheDocument());
      // Project Context loads independently of the workspace request — wait for IT, not just the error text.
      await waitFor(() => expect(screen.getByLabelText("Project name")).toHaveValue("OTT"));
    });

    it("renders a safe fallback, without crashing, for a missing/malformed workspace response", async () => {
      // @ts-expect-error deliberately malformed to test defensive rendering
      mockedProjectsApi.getWorkspace.mockResolvedValue(null);

      renderApp("/projects/p1/workspace");

      await waitFor(() => expect(screen.getByText("Couldn't load the workspace for this project.")).toBeInTheDocument());
    });

    it("clicking the Workspace Details nav item makes it the visibly active section", async () => {
      mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
      renderApp("/projects/p1/workspace");
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      await userEvent.click(screen.getByRole("button", { name: /Workspace Details/ }));
      expect(screen.getByRole("button", { name: /Workspace Details/ })).toHaveClass("active");
    });
  });

  describe("Project Context section (Phase 3, Slice 8)", () => {
    it("renders the Project Context panel by default, as its own dedicated area (not the task board)", async () => {
      renderApp("/projects/p1/workspace");

      await waitFor(() => expect(screen.getByRole("heading", { name: "Project Context" })).toBeInTheDocument());
      expect(screen.getByLabelText("Project name")).toHaveValue("OTT");
      expect(document.querySelector(".board")).not.toBeInTheDocument();
    });

    it("Project Context loads exactly once regardless of which workspace section is active", async () => {
      renderApp("/projects/p1/workspace");
      await waitFor(() => expect(screen.getByLabelText("Project name")).toHaveValue("OTT"));

      await userEvent.click(screen.getByRole("button", { name: /Workspace Details/ }));
      await userEvent.click(screen.getByRole("button", { name: /Project Context/ }));

      expect(mockedProjectsApi.getContext).toHaveBeenCalledWith("p1");
      expect(mockedProjectsApi.getContext).toHaveBeenCalledTimes(1);
      // Switching sections and back never reset the field — still the loaded value.
      expect(screen.getByLabelText("Project name")).toHaveValue("OTT");
    });

    it("switching to Workspace Details and back preserves an unsaved Project Context edit", async () => {
      renderApp("/projects/p1/workspace");
      await waitFor(() => expect(screen.getByLabelText("Project name")).toHaveValue("OTT"));

      const nameInput = screen.getByLabelText("Project name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "OTT Renamed");

      await userEvent.click(screen.getByRole("button", { name: /Workspace Details/ }));
      await userEvent.click(screen.getByRole("button", { name: /Project Context/ }));

      expect(screen.getByLabelText("Project name")).toHaveValue("OTT Renamed");
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    it("a Project Context load failure shows a useful error without breaking Workspace Details", async () => {
      mockedProjectsApi.getContext.mockRejectedValue(new Error("boom"));

      renderApp("/projects/p1/workspace");

      await waitFor(() => expect(screen.getByText("Unable to load project context.")).toBeInTheDocument());
      // The Workspace Details section stays mounted (only toggled via `hidden`) even while it isn't
      // the active section — `hidden: true` here just means "search past that attribute," the same
      // way a real assistive-tech user wouldn't see it either until they switch sections.
      expect(screen.getByRole("heading", { name: "Workspace Details", hidden: true })).toBeInTheDocument();
    });
  });
});
