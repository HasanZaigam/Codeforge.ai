import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { MobileTaskList } from "./MobileTaskList.js";
import { makeTask } from "../../test/fixtures.js";

function renderList(tasks: Parameters<typeof MobileTaskList>[0]["tasks"]) {
  return render(
    <MemoryRouter>
      <MobileTaskList tasks={tasks} defaultBranch="main" />
    </MemoryRouter>,
  );
}

describe("MobileTaskList", () => {
  it("shows every task under the 'All' chip by default", () => {
    renderList([makeTask({ id: "t1", title: "Task A", status: "TODO" }), makeTask({ id: "t2", title: "Task B", status: "DONE" })]);
    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
  });

  it("filters the vertical list down to one status when its chip is selected", async () => {
    renderList([makeTask({ id: "t1", title: "Task A", status: "TODO" }), makeTask({ id: "t2", title: "Task B", status: "DONE" })]);

    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));

    expect(screen.getByText("Task B")).toBeInTheDocument();
    expect(screen.queryByText("Task A")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no tasks at all", () => {
    renderList([]);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("never renders the CANCELLED status as a filter chip", () => {
    renderList([makeTask({ id: "t1", title: "Task A", status: "CANCELLED" })]);
    expect(screen.queryByRole("tab", { name: /Cancelled/ })).not.toBeInTheDocument();
  });
});
