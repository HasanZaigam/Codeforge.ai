import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render.js";
import { makeProject, makeTask } from "../test/fixtures.js";
import { projectsApi } from "../api/index.js";

vi.mock("../api/projects.js", () => ({
  projectsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
  },
}));

const mockedProjectsApi = vi.mocked(projectsApi);

describe("ProjectBoardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjectsApi.get.mockResolvedValue(makeProject({ id: "p1", name: "OTT" }));
  });

  it("renders tasks grouped into their status columns", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([
      makeTask({ id: "t1", title: "Todo task", status: "TODO" }),
      makeTask({ id: "t2", title: "Working task", status: "WORKING", currentActivity: "Running tests" }),
      makeTask({ id: "t3", title: "Needs input task", status: "NEEDS_INPUT" }),
      makeTask({ id: "t4", title: "Review task", status: "REVIEW" }),
      makeTask({ id: "t5", title: "Done task", status: "DONE" }),
    ]);

    renderApp("/projects/p1");

    await waitFor(() => expect(screen.getByText("Todo task")).toBeInTheDocument());
    expect(screen.getByText("Working task")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Needs input task")).toBeInTheDocument();
    expect(screen.getByText("Review task")).toBeInTheDocument();
    expect(screen.getByText("Done task")).toBeInTheDocument();

    // Structural responsive check: the board renders one column per status as a responsive grid
    // that shares the available width (wrapping rather than overflowing on narrow viewports) — see
    // /docs/UI_ARCHITECTURE.md "Responsive strategy" and TECHNICAL_DECISIONS.md TD-23 (revised).
    expect(document.querySelector(".board")).toBeInTheDocument();
    expect(document.querySelectorAll(".board-column").length).toBe(5);
  });

  it("shows an empty state when the project has no tasks", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument());
  });

  it("creating a task returns immediately and the task appears in TODO without waiting for execution", async () => {
    mockedProjectsApi.listTasks.mockResolvedValue([]);
    mockedProjectsApi.createTask.mockResolvedValue(
      makeTask({ id: "new-task", title: "Fix OTP timeout login", status: "TODO" }),
    );

    renderApp("/projects/p1");
    await waitFor(() => expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /create task/i }));
    await userEvent.type(screen.getByLabelText(/title/i), "Fix OTP timeout login");
    await userEvent.type(screen.getByLabelText(/description/i), "Client reports OTP login fails after session timeout.");
    await userEvent.click(screen.getByRole("button", { name: /^create task$/i }));

    await waitFor(() => expect(screen.getByText("Fix OTP timeout login")).toBeInTheDocument());
    const todoColumn = document.querySelectorAll(".board-column")[0]!;
    expect(within(todoColumn as HTMLElement).getByText("Fix OTP timeout login")).toBeInTheDocument();
    expect(mockedProjectsApi.createTask).toHaveBeenCalledWith("p1", {
      title: "Fix OTP timeout login",
      description: "Client reports OTP login fails after session timeout.",
    });
  });
});
