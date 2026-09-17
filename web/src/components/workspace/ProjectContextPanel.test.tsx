import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectContextPanel } from "./ProjectContextPanel.js";
import { projectsApi, ApiError } from "../../api/index.js";
import { makeProjectContext } from "../../test/fixtures.js";

vi.mock("../../api/projects.js", () => ({
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

function renderPanel() {
  return render(<ProjectContextPanel projectId="p1" />);
}

describe("ProjectContextPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("shows a loading state before the request resolves", async () => {
    let resolveContext!: (value: ReturnType<typeof makeProjectContext>) => void;
    mockedProjectsApi.getContext.mockReturnValue(
      new Promise((resolve) => {
        resolveContext = resolve;
      }),
    );

    renderPanel();

    expect(await screen.findByText("Loading project context…")).toBeInTheDocument();
    resolveContext(makeProjectContext());
    await waitFor(() => expect(screen.queryByText("Loading project context…")).not.toBeInTheDocument());
  });

  test("a generic load failure shows a useful error with a retry action", async () => {
    mockedProjectsApi.getContext.mockRejectedValue(new Error("boom"));
    renderPanel();

    await waitFor(() => expect(screen.getByText("Unable to load project context.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  test("a 404 (unauthorized/unknown project) is handled the same as any other load failure, without leaking context", async () => {
    mockedProjectsApi.getContext.mockRejectedValue(new ApiError(404, "NOT_FOUND", "Not found"));
    renderPanel();

    await waitFor(() => expect(screen.getByText("Unable to load project context.")).toBeInTheDocument());
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
  });

  describe("once loaded", () => {
    beforeEach(() => {
      mockedProjectsApi.getContext.mockResolvedValue(
        makeProjectContext({
          revision: 4,
          project: { name: "OTT", description: "Streaming platform" },
          instructions: ["Use TypeScript for backend changes"],
          architecture: ["Express API + SQLite"],
          conventions: ["Prefer named exports"],
          validation: { commands: ["npm test"] },
          constraints: ["Never touch billing code"],
        }),
      );
    });

    test("renders project name, description, every list field, and the revision", async () => {
      renderPanel();

      await waitFor(() => expect(screen.getByLabelText("Project name")).toHaveValue("OTT"));
      expect(screen.getByLabelText("Description")).toHaveValue("Streaming platform");
      expect(screen.getByDisplayValue("Use TypeScript for backend changes")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Express API + SQLite")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Prefer named exports")).toBeInTheDocument();
      expect(screen.getByDisplayValue("npm test")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Never touch billing code")).toBeInTheDocument();
      expect(screen.getByText("Revision: 4")).toBeInTheDocument();
    });

    test("validation guidance carries an explicit non-authoritative disclaimer", async () => {
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());
      expect(
        screen.getByText(/These commands provide project guidance to the AI\. CodeForge's configured project validation commands remain authoritative\./),
      ).toBeInTheDocument();
    });

    test("an array item can be added, edited, and removed, and Save stays disabled until something actually changes", async () => {
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const saveButton = screen.getByRole("button", { name: /^Save Changes$/ });
      expect(saveButton).toBeDisabled();
      expect(screen.getByText("No unsaved changes")).toBeInTheDocument();

      const constraintsGroup = screen.getByRole("group", { name: "Constraints" });
      await userEvent.click(within(constraintsGroup).getByRole("button", { name: "+ Add constraint" }));

      expect(saveButton).not.toBeDisabled();
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

      const newItemInput = within(constraintsGroup).getByLabelText("Constraints item 2");
      await userEvent.type(newItemInput, "No direct DB writes from controllers");
      expect(newItemInput).toHaveValue("No direct DB writes from controllers");

      await userEvent.click(within(constraintsGroup).getAllByRole("button", { name: "Remove" })[0]!);
      // Original first constraint removed, the newly-added one remains and shifted up.
      expect(within(constraintsGroup).queryByDisplayValue("Never touch billing code")).not.toBeInTheDocument();
      expect(within(constraintsGroup).getByDisplayValue("No direct DB writes from controllers")).toBeInTheDocument();
    });

    test("Save sends the loaded revision and, on success, updates the revision shown and clears dirty state", async () => {
      mockedProjectsApi.updateContext.mockResolvedValue(
        makeProjectContext({
          revision: 5,
          project: { name: "OTT", description: "Streaming platform" },
          instructions: ["Use TypeScript for backend changes", "Be terse"],
          architecture: ["Express API + SQLite"],
          conventions: ["Prefer named exports"],
          validation: { commands: ["npm test"] },
          constraints: ["Never touch billing code"],
        }),
      );
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const instructionsGroup = screen.getByRole("group", { name: "Instructions" });
      await userEvent.click(within(instructionsGroup).getByRole("button", { name: "+ Add instruction" }));
      await userEvent.type(within(instructionsGroup).getByLabelText("Instructions item 2"), "Be terse");

      await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

      await waitFor(() => expect(mockedProjectsApi.updateContext).toHaveBeenCalled());
      expect(mockedProjectsApi.updateContext).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ revision: 4, instructions: ["Use TypeScript for backend changes", "Be terse"] }),
      );

      await waitFor(() => expect(screen.getByText("Revision: 5")).toBeInTheDocument());
      expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Save Changes$/ })).toBeDisabled();
    });

    test("a save failure preserves the user's edits, shows an error, and allows retry", async () => {
      mockedProjectsApi.updateContext.mockRejectedValue(new Error("network down"));
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const nameInput = screen.getByLabelText("Project name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "OTT Renamed");
      await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

      await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
      // Edits are still there — nothing was reset.
      expect(screen.getByLabelText("Project name")).toHaveValue("OTT Renamed");
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

      // Retry is available directly from the error state.
      mockedProjectsApi.updateContext.mockResolvedValue(
        makeProjectContext({ revision: 5, project: { name: "OTT Renamed" } }),
      );
      await userEvent.click(screen.getByRole("button", { name: /try again/i }));
      await waitFor(() => expect(screen.getByText("Revision: 5")).toBeInTheDocument());
    });

    test("409 PROJECT_CONTEXT_CONFLICT shows the conflict UI and does not overwrite the user's edits", async () => {
      mockedProjectsApi.updateContext.mockRejectedValue(
        new ApiError(409, "PROJECT_CONTEXT_CONFLICT", "conflict", { currentRevision: 7 }),
      );
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const nameInput = screen.getByLabelText("Project name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "My Local Edit");
      await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

      await waitFor(() => expect(screen.getByText("Project Context Changed")).toBeInTheDocument());
      expect(screen.getByText(/have not been overwritten/i)).toBeInTheDocument();
      // The user's unsaved edit is still sitting in the form, untouched.
      expect(screen.getByLabelText("Project name")).toHaveValue("My Local Edit");
      expect(screen.getByRole("button", { name: "Reload Latest" })).toBeInTheDocument();
    });

    test("Reload Latest explicitly replaces local state with the freshly-fetched context", async () => {
      mockedProjectsApi.updateContext.mockRejectedValue(
        new ApiError(409, "PROJECT_CONTEXT_CONFLICT", "conflict", { currentRevision: 7 }),
      );
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const nameInput = screen.getByLabelText("Project name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "My Local Edit");
      await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));
      await waitFor(() => expect(screen.getByText("Project Context Changed")).toBeInTheDocument());

      mockedProjectsApi.getContext.mockResolvedValue(
        makeProjectContext({ revision: 7, project: { name: "Someone Else's Edit" } }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Reload Latest" }));

      await waitFor(() => expect(screen.getByLabelText("Project name")).toHaveValue("Someone Else's Edit"));
      expect(screen.getByText("Revision: 7")).toBeInTheDocument();
      expect(screen.queryByText("Project Context Changed")).not.toBeInTheDocument();
      expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    });

    test("409 PROJECT_CONTEXT_LOCKED is handled as a temporary, retryable conflict — not a generic error", async () => {
      mockedProjectsApi.updateContext.mockRejectedValueOnce(
        new ApiError(409, "PROJECT_CONTEXT_LOCKED", "locked"),
      );
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const nameInput = screen.getByLabelText("Project name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "OTT v2");
      await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

      await waitFor(() => expect(screen.getByText("Project Context is currently being updated")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

      mockedProjectsApi.updateContext.mockResolvedValue(makeProjectContext({ revision: 5, project: { name: "OTT v2" } }));
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getByText("Revision: 5")).toBeInTheDocument());
    });

    test("saving state disables Save Changes and shows a saving label", async () => {
      let resolveSave!: (value: ReturnType<typeof makeProjectContext>) => void;
      mockedProjectsApi.updateContext.mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
      );
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      const nameInput = screen.getByLabelText("Project name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "OTT v2");
      await userEvent.click(screen.getByRole("button", { name: /^Save Changes$/ }));

      expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
      resolveSave(makeProjectContext({ revision: 5, project: { name: "OTT v2" } }));
      await waitFor(() => expect(screen.getByRole("button", { name: /^Save Changes$/ })).toBeInTheDocument());
    });

    test("the AI Context Preview is available on demand and never exposes the revision counter", async () => {
      renderPanel();
      await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

      expect(screen.getByText("AI Context Preview")).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: "View Preview" });
      await userEvent.click(toggle);

      const preview = screen.getByText(/Project: OTT/).closest("pre")!;
      expect(within(preview).getByText(/Use TypeScript for backend changes/)).toBeInTheDocument();
      expect(preview.textContent).not.toMatch(/revision/i);
      expect(preview.textContent).not.toContain("4");
    });

    describe("Upload MD/PDF", () => {
      test("uploading a .md file appends its lines to that field's list and marks the form dirty", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

        const constraintsSection = screen.getByRole("heading", { name: "Constraints" }).closest(".context-section") as HTMLElement;
        const file = new File(["- No direct DB writes from controllers\n- Never log raw tokens"], "constraints.md", {
          type: "text/markdown",
        });
        await userEvent.upload(within(constraintsSection).getByLabelText(/upload md\/pdf/i), file);

        await waitFor(() =>
          expect(within(constraintsSection).getByDisplayValue("No direct DB writes from controllers")).toBeInTheDocument(),
        );
        expect(within(constraintsSection).getByDisplayValue("Never log raw tokens")).toBeInTheDocument();
        // The original item loaded from the server is still there — upload appends, never replaces.
        expect(within(constraintsSection).getByDisplayValue("Never touch billing code")).toBeInTheDocument();
        expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
      });

      test("an unsupported file type is rejected with a clear error and nothing is added to the list", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

        const instructionsSection = screen.getByRole("heading", { name: "Instructions" }).closest(".context-section") as HTMLElement;
        const file = new File(["not markdown or pdf"], "notes.txt", { type: "text/plain" });
        // The input's `accept` attribute is only a picker hint, not a real guarantee (a user can
        // still drag-drop or rename a file around it) — `applyAccept: false` bypasses
        // userEvent.upload's own accept-matching so this test can exercise that defensive path.
        const user = userEvent.setup({ applyAccept: false });
        await user.upload(within(instructionsSection).getByLabelText(/upload md\/pdf/i), file);

        await waitFor(() => expect(within(instructionsSection).getByRole("alert")).toBeInTheDocument());
        expect(within(instructionsSection).getByText(/isn't a supported file type/i)).toBeInTheDocument();
        expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
      });

      test("an upload never calls the save API by itself — it only affects local, unsaved form state", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

        const architectureSection = screen.getByRole("heading", { name: "Architecture" }).closest(".context-section") as HTMLElement;
        const file = new File(["A new architecture note"], "architecture.md", { type: "text/markdown" });
        await userEvent.upload(within(architectureSection).getByLabelText(/upload md\/pdf/i), file);

        await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeInTheDocument());
        expect(mockedProjectsApi.updateContext).not.toHaveBeenCalled();
      });
    });
  });
});
