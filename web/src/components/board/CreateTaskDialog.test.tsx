import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateTaskDialog } from "./CreateTaskDialog.js";
import { projectsApi, tasksApi, type TaskDTO } from "../../api/index.js";
import { makeRepository, makeTask } from "../../test/fixtures.js";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/projects.js", () => ({
  projectsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), verifyGitHubRepo: vi.fn(), listTasks: vi.fn(), createTask: vi.fn(), listBranches: vi.fn() },
}));

vi.mock("../../api/tasks.js", () => ({
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

function renderDialog(onCreated = vi.fn(), allTasks: TaskDTO[] = []) {
  render(<CreateTaskDialog projectId="p1" defaultBranch="main" allTasks={allTasks} onClose={vi.fn()} onCreated={onCreated} />);
  return { onCreated };
}

function renderEditDialog(task: TaskDTO, allTasks: TaskDTO[], onSaved = vi.fn()) {
  render(<CreateTaskDialog projectId="p1" defaultBranch="main" task={task} allTasks={allTasks} onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}

async function fillTitleAndDescription() {
  await userEvent.type(screen.getByLabelText(/title/i), "Fix OTP timeout login");
  await userEvent.type(screen.getByLabelText(/description/i), "Client reports that OTP login fails after session timeout.");
}

describe("CreateTaskDialog branch mode", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): several tests set a persistent mockResolvedValue on
    // listBranches — clearAllMocks only clears call history, not that lingering implementation,
    // which would otherwise leak into the next test.
    vi.resetAllMocks();
  });

  test("defaults to 'new branch' mode with the project's default branch pre-filled and an auto-suggested branch name", async () => {
    renderDialog();
    expect(screen.getByLabelText("Branch")).toHaveValue("new");
    expect(screen.getByLabelText("Base branch")).toHaveValue("main");

    await fillTitleAndDescription();
    expect(screen.getByLabelText("New branch name")).toHaveValue("task/fix-otp-timeout-login");
  });

  test("changing the title updates an untouched branch-name suggestion to match", async () => {
    renderDialog();
    await fillTitleAndDescription();
    expect(screen.getByLabelText("New branch name")).toHaveValue("task/fix-otp-timeout-login");

    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Add retry logic");

    expect(screen.getByLabelText("New branch name")).toHaveValue("task/add-retry-logic");
  });

  test("'existing branch' mode shows no new-branch-name (or base-branch) field", async () => {
    mockedProjectsApi.listBranches.mockResolvedValue(["main", "develop"]);
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();

    await user.selectOptions(screen.getByLabelText("Branch"), "existing");

    expect(screen.queryByLabelText("New branch name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Base branch")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Existing branch")).toBeInTheDocument());
  });

  test("editing the branch name by hand stops it from following further title changes", async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();
    const branchNameInput = screen.getByLabelText("New branch name");
    await user.clear(branchNameInput);
    await user.type(branchNameInput, "my/custom-branch");

    await user.type(screen.getByLabelText(/title/i), " updated");
    expect(branchNameInput).toHaveValue("my/custom-branch");
  });

  test("an unsafe branch name shows an inline warning and disables submit", async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();
    const branchNameInput = screen.getByLabelText("New branch name");
    await user.clear(branchNameInput);
    await user.type(branchNameInput, "-rf");

    expect(screen.getByRole("alert")).toHaveTextContent("may only contain letters, numbers");
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeDisabled();
  });

  test("a new-branch name identical to the base branch shows a warning and disables submit", async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();
    const branchNameInput = screen.getByLabelText("New branch name");
    await user.clear(branchNameInput);
    await user.type(branchNameInput, "main");

    expect(screen.getByRole("alert")).toHaveTextContent("can't be the same as the base branch");
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeDisabled();
  });

  test("switching to 'existing branch' mode loads the repository's real branch list and requires a selection", async () => {
    const user = userEvent.setup();
    // DETERMINISM: the request is held open by a promise THIS TEST resolves, so the transient "Loading
    // branches…" state is observable for exactly as long as the test needs — never dependent on how fast the
    // machine runs (a real 10 ms timer used to expire before the assertion under CPU load).
    let resolveBranches!: (branches: string[]) => void;
    mockedProjectsApi.listBranches.mockImplementation(() => new Promise((resolve) => (resolveBranches = resolve)));
    renderDialog();
    await fillTitleAndDescription();

    await user.selectOptions(screen.getByLabelText("Branch"), "existing");
    expect(screen.getByText(/Loading branches/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeDisabled();

    resolveBranches(["main", "develop"]);
    await waitFor(() => expect(screen.getByLabelText("Existing branch")).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "develop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Existing branch"), "develop");
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeEnabled();
  });

  test("an empty branch list in 'existing branch' mode is shown clearly, with no way to submit", async () => {
    mockedProjectsApi.listBranches.mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();
    await user.selectOptions(screen.getByLabelText("Branch"), "existing");

    await waitFor(() => expect(screen.getByText(/No branches were found/i)).toBeInTheDocument());
    expect(screen.queryByLabelText("Existing branch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeDisabled();
  });

  test("a branch-list load failure shows a retryable error state", async () => {
    mockedProjectsApi.listBranches.mockRejectedValue(new Error("Could not reach the server."));
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();
    await user.selectOptions(screen.getByLabelText("Branch"), "existing");

    await waitFor(() => expect(screen.getByText("Could not reach the server.")).toBeInTheDocument());

    mockedProjectsApi.listBranches.mockResolvedValue(["main"]);
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByLabelText("Existing branch")).toBeInTheDocument());
  });

  test("submitting in 'existing branch' mode sends existingBranch and no baseBranch/branchName fields", async () => {
    mockedProjectsApi.listBranches.mockResolvedValue(["main", "develop"]);
    mockedProjectsApi.createTask.mockResolvedValue(makeTask({ id: "t9" }));
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await fillTitleAndDescription();
    await user.selectOptions(screen.getByLabelText("Branch"), "existing");
    await waitFor(() => expect(screen.getByLabelText("Existing branch")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Existing branch"), "develop");

    await user.click(screen.getByRole("button", { name: /^Create task$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockedProjectsApi.createTask).toHaveBeenCalledWith("p1", {
      title: "Fix OTP timeout login",
      description: "Client reports that OTP login fails after session timeout.",
      branchMode: "existing",
      existingBranch: "develop",
    });
  });

  test("mentions that only one active task may work on a given existing branch at a time", async () => {
    mockedProjectsApi.listBranches.mockResolvedValue(["main"]);
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByLabelText("Branch"), "existing");
    expect(screen.getByText(/Only one active task may work on a given branch at a time/i)).toBeInTheDocument();
  });

  test("a server-side error surfaces without a raw stack trace, and re-enables the form", async () => {
    mockedProjectsApi.createTask.mockRejectedValue(new Error("Branch \"shared\" is already in use by another active task."));
    const user = userEvent.setup();
    renderDialog();
    await fillTitleAndDescription();
    await user.click(screen.getByRole("button", { name: /^Create task$/i }));

    await waitFor(() => expect(screen.getByText(/already in use by another active task/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Create task$/i })).toBeEnabled();
  });
});

describe("CreateTaskDialog dependencies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("shows every other project task as a dependency option, excluding the current task itself", () => {
    const other1 = makeTask({ id: "t-other-1", title: "Other task 1" });
    const other2 = makeTask({ id: "t-other-2", title: "Other task 2" });
    const current = makeTask({ id: "t-current", title: "Current task", status: "BACKLOG" });
    renderEditDialog(current, [current, other1, other2]);

    const picker = screen.getByRole("group", { name: /depends on/i });
    expect(within(picker).getByText("Other task 1")).toBeInTheDocument();
    expect(within(picker).getByText("Other task 2")).toBeInTheDocument();
    expect(within(picker).queryByText("Current task")).not.toBeInTheDocument();
  });

  test("pre-selects the task's existing dependencies when opening in edit mode", () => {
    const dep = makeTask({ id: "t-dep", title: "Dependency task" });
    const current = makeTask({
      id: "t-current",
      title: "Current task",
      status: "BACKLOG",
      dependencies: [{ id: "t-dep", title: "Dependency task", status: "BACKLOG", satisfied: false }],
    });
    renderEditDialog(current, [current, dep]);

    const checkbox = screen.getByRole("checkbox", { name: "Dependency task" });
    expect(checkbox).toBeChecked();
  });

  test("create mode: selecting dependencies includes dependencyIds in the create request", async () => {
    const other = makeTask({ id: "t-other", title: "Other task" });
    mockedProjectsApi.createTask.mockResolvedValue(makeTask({ id: "t9" }));
    const user = userEvent.setup();
    const { onCreated } = renderDialog(vi.fn(), [other]);
    await fillTitleAndDescription();

    await user.click(screen.getByRole("checkbox", { name: "Other task" }));
    await user.click(screen.getByRole("button", { name: /^Create task$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockedProjectsApi.createTask).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ dependencyIds: ["t-other"] }),
    );
  });

  test("edit mode: adding a new dependency calls addDependency for it", async () => {
    const other = makeTask({ id: "t-other", title: "Other task" });
    const current = makeTask({ id: "t-current", title: "Current task", status: "BACKLOG", dependencies: [] });
    mockedTasksApi.edit.mockResolvedValue(current);
    mockedTasksApi.addDependency.mockResolvedValue([]);
    mockedTasksApi.get.mockResolvedValue({ ...current, dependencies: [{ id: "t-other", title: "Other task", status: "BACKLOG", satisfied: false }] });
    const user = userEvent.setup();
    const { onSaved } = renderEditDialog(current, [current, other]);

    await user.click(screen.getByRole("checkbox", { name: "Other task" }));
    await user.click(screen.getByRole("button", { name: /^Save changes$/i }));

    await waitFor(() => expect(mockedTasksApi.addDependency).toHaveBeenCalledWith("t-current", "t-other"));
    expect(mockedTasksApi.removeDependency).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  test("edit mode: deselecting an existing dependency calls removeDependency for it", async () => {
    const current = makeTask({
      id: "t-current",
      title: "Current task",
      status: "BACKLOG",
      dependencies: [{ id: "t-dep", title: "Dependency task", status: "DONE", satisfied: true }],
    });
    const dep = makeTask({ id: "t-dep", title: "Dependency task" });
    mockedTasksApi.edit.mockResolvedValue(current);
    mockedTasksApi.removeDependency.mockResolvedValue([]);
    mockedTasksApi.get.mockResolvedValue({ ...current, dependencies: [] });
    const user = userEvent.setup();
    const { onSaved } = renderEditDialog(current, [current, dep]);

    await user.click(screen.getByRole("checkbox", { name: "Dependency task" }));
    await user.click(screen.getByRole("button", { name: /^Save changes$/i }));

    await waitFor(() => expect(mockedTasksApi.removeDependency).toHaveBeenCalledWith("t-current", "t-dep"));
    expect(mockedTasksApi.addDependency).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  test("dependency editing is disabled once the task has left BACKLOG", () => {
    const dep = makeTask({ id: "t-dep", title: "Dependency task" });
    const current = makeTask({
      id: "t-current",
      title: "Current task",
      status: "TODO",
      dependencies: [{ id: "t-dep", title: "Dependency task", status: "BACKLOG", satisfied: false }],
    });
    renderEditDialog(current, [current, dep]);

    expect(screen.getByText(/dependencies can no longer be changed/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Dependency task" })).toBeDisabled();
  });
});

describe("CreateTaskDialog repositories (multi-repository projects)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const FRONTEND = makeRepository({ id: "fe", name: "frontend", defaultBranch: "main" });
  const BACKEND = makeRepository({ id: "be", name: "backend", defaultBranch: "develop" });

  function renderWith(repositories: ReturnType<typeof makeRepository>[], onCreated = vi.fn()) {
    render(
      <MemoryRouter>
        <CreateTaskDialog projectId="p1" defaultBranch="main" repositories={repositories} allTasks={[]} onClose={vi.fn()} onCreated={onCreated} />
      </MemoryRouter>,
    );
    return { onCreated };
  }

  async function fill() {
    await userEvent.type(screen.getByLabelText(/title/i), "Fix login");
    await userEvent.type(screen.getByLabelText(/description/i), "Login fails");
  }

  test("with several repositories the user must choose one — nothing is guessed", async () => {
    renderWith([FRONTEND, BACKEND]);
    await fill();
    expect(screen.getByLabelText("Repository")).toHaveValue("");
    expect(screen.getByRole("button", { name: /^create task$/i })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText("Repository"), "be");
    expect(screen.getByLabelText("Base branch")).toHaveValue("develop");
    expect(screen.getByRole("button", { name: /^create task$/i })).toBeEnabled();
  });

  test("the chosen repository is sent, and existing-branch mode lists THAT repository's branches", async () => {
    mockedProjectsApi.listBranches.mockResolvedValue(["develop", "release"]);
    mockedProjectsApi.createTask.mockResolvedValue(makeTask({ id: "t1", repositoryId: "be" }));
    const { onCreated } = renderWith([FRONTEND, BACKEND]);
    await fill();
    await userEvent.selectOptions(screen.getByLabelText("Repository"), "be");
    await userEvent.selectOptions(screen.getByLabelText("Branch"), "existing");
    await waitFor(() => expect(mockedProjectsApi.listBranches).toHaveBeenCalledWith("p1", "be"));
    await userEvent.selectOptions(await screen.findByLabelText("Existing branch"), "release");
    await userEvent.click(screen.getByRole("button", { name: /^create task$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockedProjectsApi.createTask).toHaveBeenCalledWith("p1", expect.objectContaining({ repositoryId: "be", branchMode: "existing", existingBranch: "release" }));
  });

  test("a single repository is chosen automatically and no picker is shown", async () => {
    mockedProjectsApi.createTask.mockResolvedValue(makeTask({ id: "t1" }));
    renderWith([BACKEND]);
    await fill();
    expect(screen.queryByLabelText("Repository")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Base branch")).toHaveValue("develop");
    await userEvent.click(screen.getByRole("button", { name: /^create task$/i }));
    await waitFor(() => expect(mockedProjectsApi.createTask).toHaveBeenCalledWith("p1", expect.objectContaining({ repositoryId: "be" })));
  });

  test("a project with no repository can't create tasks and points to Settings", async () => {
    renderWith([]);
    await fill();
    expect(screen.getByRole("link", { name: "Connect one in Settings" })).toHaveAttribute("href", "/projects/p1/settings");
    expect(screen.getByRole("button", { name: /^create task$/i })).toBeDisabled();
  });
});
