import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeProjectContext, makeTask, makeWorkspace } from "../test/fixtures.js";
import { projectsApi, tasksApi } from "../api/index.js";

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

vi.mock("../api/tasks.js", () => ({
  tasksApi: {
    get: vi.fn(),
    listEvents: vi.fn(),
    getReport: vi.fn(),
    getBranchState: vi.fn(),
    start: vi.fn(),
    edit: vi.fn(),
    cancel: vi.fn(),
    listDependencies: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
  },
}));

const mockedProjectsApi = vi.mocked(projectsApi);
const mockedTasksApi = vi.mocked(tasksApi);

describe("ProjectTasksPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
    mockedProjectsApi.getWorkspace.mockResolvedValue(makeWorkspace({ id: "w1", projectId: "p1" }));
    mockedProjectsApi.getContext.mockResolvedValue(makeProjectContext({ project: { name: "OTT" } }));
  });

  it("renders tasks grouped into their status columns", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" }),
      makeTask({ id: "t1", title: "Todo task", status: "TODO" }),
      makeTask({ id: "t2", title: "Working task", status: "WORKING", currentActivity: "Running tests" }),
      makeTask({ id: "t3", title: "Needs input task", status: "NEEDS_INPUT" }),
      makeTask({ id: "t4", title: "Review task", status: "REVIEW" }),
      makeTask({ id: "t5", title: "Done task", status: "DONE" }),
    ]);

    renderApp("/projects/p1/tasks");

    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());
    expect(screen.getByText("Todo task")).toBeInTheDocument();
    expect(screen.getByText("Working task")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Needs input task")).toBeInTheDocument();
    expect(screen.getByText("Review task")).toBeInTheDocument();
    expect(screen.getByText("Done task")).toBeInTheDocument();

    expect(document.querySelector(".board")).toBeInTheDocument();
    expect(document.querySelectorAll(".board-column").length).toBe(6);
  });

  it("never renders a CANCELLED column, even when a CANCELLED task exists in the task list", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" }),
      makeTask({ id: "t9", title: "Cancelled task", status: "CANCELLED" }),
    ]);

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    expect(screen.queryByText("Cancelled task")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".board-column").length).toBe(6);
  });

  it("still renders a FAILED column when a FAILED task exists", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" }),
      makeTask({ id: "t9", title: "Failed task", status: "FAILED" }),
    ]);

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    expect(screen.getByText("Failed task")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(document.querySelectorAll(".board-column").length).toBe(7);
  });

  it("a BACKLOG task card shows Start Task, Edit, and Cancel actions", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" })]);
    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /^Start Task$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cancel task$/i })).toBeInTheDocument();
  });

  it("Start Task still performs the BACKLOG -> TODO release unchanged (regression)", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" })]);
    mockedTasksApi.start.mockResolvedValue(makeTask({ id: "t0", title: "Backlog task", status: "TODO", currentActivity: "Waiting to start" }));

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Start Task$/i }));

    expect(mockedTasksApi.start).toHaveBeenCalledWith("t0");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Start Task$/i })).not.toBeInTheDocument());
    expect(screen.getByText("Backlog task")).toBeInTheDocument();
  });

  it("Cancel requires confirmation before a BACKLOG task is actually cancelled", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" })]);
    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Cancel task$/i }));
    expect(screen.getByText(/This task will be removed from Backlog/i)).toBeInTheDocument();
    expect(mockedTasksApi.cancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Keep Task/i }));
    expect(mockedTasksApi.cancel).not.toHaveBeenCalled();
    expect(screen.getByText("Backlog task")).toBeInTheDocument();
  });

  it("confirming cancellation moves the task to CANCELLED and it's no longer displayed on the board", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" })]);
    mockedTasksApi.cancel.mockResolvedValue(makeTask({ id: "t0", title: "Backlog task", status: "CANCELLED", currentActivity: "Cancelled" }));

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Cancel task$/i }));
    await userEvent.click(screen.getByRole("button", { name: /Confirm cancellation/i }));

    expect(mockedTasksApi.cancel).toHaveBeenCalledWith("t0");
    await waitFor(() => expect(screen.queryByText("Backlog task")).not.toBeInTheDocument());
  });

  it("Edit opens pre-filled from the BACKLOG task, saves, and the board reflects the update", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({
        id: "t0",
        title: "Backlog task",
        description: "Original description",
        status: "BACKLOG",
        branchMode: "new",
        workingBranch: "task/backlog-task",
        baseBranch: "main",
      }),
    ]);
    mockedTasksApi.edit.mockResolvedValue(
      makeTask({ id: "t0", title: "Updated title", description: "Original description", status: "BACKLOG" }),
    );

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Edit$/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/title/i)).toHaveValue("Backlog task");
    expect(within(dialog).getByLabelText(/description/i)).toHaveValue("Original description");
    expect(within(dialog).getByLabelText("New branch name")).toHaveValue("task/backlog-task");
    expect(within(dialog).getByLabelText("Base branch")).toHaveValue("main");

    const titleInput = within(dialog).getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Updated title");
    await userEvent.click(within(dialog).getByRole("button", { name: /^Save changes$/i }));

    expect(mockedTasksApi.edit).toHaveBeenCalledWith("t0", {
      repositoryId: "p1-repo", // the project's one repository, now always explicit
      title: "Updated title",
      description: "Original description",
      branchMode: "new",
      baseBranch: "main",
      branchName: "task/backlog-task",
    });
    await waitFor(() => expect(screen.getByText("Updated title")).toBeInTheDocument());
  });

  it("shows an empty state when the project has no tasks", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument());
  });

  it("creating a task returns immediately and the task appears in Backlog, not yet executable", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    mockedProjectsApi.createTask.mockResolvedValue(
      makeTask({ id: "new-task", title: "Fix OTP timeout login", status: "BACKLOG" }),
    );

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /create task/i }));
    const createDialog = screen.getByRole("dialog");
    await userEvent.type(within(createDialog).getByLabelText(/title/i), "Fix OTP timeout login");
    await userEvent.type(
      within(createDialog).getByLabelText(/description/i),
      "Client reports OTP login fails after session timeout.",
    );
    await userEvent.click(screen.getByRole("button", { name: /^create task$/i }));

    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    const backlogColumn = document.querySelectorAll(".board-column")[0]!;
    expect(within(backlogColumn as HTMLElement).getByText("Fix OTP timeout login")).toBeInTheDocument();
    expect(within(backlogColumn as HTMLElement).getByText("Start Task")).toBeInTheDocument();
    expect(mockedProjectsApi.createTask).toHaveBeenCalledWith("p1", {
      repositoryId: "p1-repo",
      title: "Fix OTP timeout login",
      description: "Client reports OTP login fails after session timeout.",
      branchMode: "new",
      baseBranch: "main",
      branchName: "task/fix-otp-timeout-login",
    });
  });

  it("a task card shows its dependencies, naming only the incomplete ones as blocking", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({
        id: "t0",
        title: "Dependent task",
        status: "BACKLOG",
        dependencies: [
          { id: "d1", title: "Design schema", status: "DONE", satisfied: true },
          { id: "d2", title: "Write migration", status: "BACKLOG", satisfied: false },
        ],
      }),
    ]);
    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Dependent task")).toBeInTheDocument());

    expect(screen.getByText(/Depends on: Design schema, Write migration/)).toBeInTheDocument();
    const blocked = screen.getByText(/Blocked by:/);
    expect(blocked).toHaveTextContent("Blocked by: Write migration");
    expect(blocked).not.toHaveTextContent("Design schema");
  });

  it("Start Task failure from an incomplete dependency is surfaced clearly and the task stays in Backlog", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({
        id: "t0",
        title: "Dependent task",
        status: "BACKLOG",
        dependencies: [{ id: "d1", title: "Write migration", status: "BACKLOG", satisfied: false }],
      }),
    ]);
    mockedTasksApi.start.mockRejectedValue(
      new Error('Task cannot be started because dependency "Write migration" is not completed.'),
    );

    renderApp("/projects/p1/tasks");
    await waitFor(() => expect(screen.getByText("Dependent task")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Start Task$/i }));

    await waitFor(() => expect(screen.getByText(/dependency "Write migration" is not completed/i)).toBeInTheDocument());
    expect(screen.getByText("Dependent task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Start Task$/i })).toBeInTheDocument();
  });

  describe("mobile representation", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows the mobile task list (status chips + vertical cards) instead of the desktop Kanban board on a narrow viewport", async () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockImplementation((query: string) => ({
          matches: query.includes("max-width: 767px"),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      mockedProjectsApi.listTasks.mockResolvedValue([
        makeTask({ id: "t0", title: "Backlog task", status: "BACKLOG" }),
        makeTask({ id: "t1", title: "Todo task", status: "TODO" }),
      ]);

      renderApp("/projects/p1/tasks");
      await waitFor(() => expect(screen.getByText("Backlog task")).toBeInTheDocument());

      // Mobile-native representation: status filter chips + a single vertical list, not the board.
      expect(document.querySelector(".board")).not.toBeInTheDocument();
      expect(screen.getByRole("tablist", { name: /filter tasks by status/i })).toBeInTheDocument();
      expect(screen.getByText("Todo task")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("tab", { name: /^Backlog/ }));
      expect(screen.getByText("Backlog task")).toBeInTheDocument();
      expect(screen.queryByText("Todo task")).not.toBeInTheDocument();
    });
  });
});
