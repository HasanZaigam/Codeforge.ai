import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskHeader } from "./TaskHeader.js";
import { makeTask } from "../../test/fixtures.js";

describe("TaskHeader — branch plan (BACKLOG/TODO, before real execution)", () => {
  test("new mode, no custom name/base: shows the auto-generated-branch + default-base plan", () => {
    render(<TaskHeader task={makeTask({ status: "BACKLOG", branchMode: "new", workingBranch: null, baseBranch: null, branchName: null })} />);
    expect(screen.getByText(/Will create a new branch from the repository's default branch/)).toBeInTheDocument();
  });

  test("new mode with a custom branch name and base branch: shows both", () => {
    render(
      <TaskHeader
        task={makeTask({ status: "BACKLOG", branchMode: "new", workingBranch: "task/fix-login", baseBranch: "develop", branchName: null })}
      />,
    );
    expect(screen.getByText(/Will create branch/)).toBeInTheDocument();
    expect(screen.getByText("task/fix-login")).toBeInTheDocument();
    expect(screen.getByText("develop")).toBeInTheDocument();
  });

  test("existing mode: shows the exact selected branch", () => {
    render(<TaskHeader task={makeTask({ status: "TODO", branchMode: "existing", workingBranch: "feature/crm", baseBranch: null, branchName: null })} />);
    expect(screen.getByText(/Will use existing branch/)).toBeInTheDocument();
    expect(screen.getByText("feature/crm")).toBeInTheDocument();
  });

  test("once real execution has picked an actual branch, the plan is no longer shown", () => {
    render(<TaskHeader task={makeTask({ status: "WORKING", branchMode: "new", workingBranch: null, baseBranch: null, branchName: "task/abc12345" })} />);
    expect(screen.queryByText(/Will create/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Will use existing/)).not.toBeInTheDocument();
  });
});

describe("TaskHeader — dependency info (see /docs/TASK_LIFECYCLE.md \"Task dependencies\")", () => {
  test("no dependencies: nothing is shown", () => {
    render(<TaskHeader task={makeTask({ dependencies: [] })} />);
    expect(screen.queryByText(/Depends on/)).not.toBeInTheDocument();
  });

  test("all dependencies satisfied: shows 'Depends on' but no 'Blocked by'", () => {
    render(
      <TaskHeader
        task={makeTask({
          dependencies: [
            { id: "d1", title: "Design schema", status: "DONE", satisfied: true },
            { id: "d2", title: "Write migration", status: "DONE", satisfied: true },
          ],
        })}
      />,
    );
    expect(screen.getByText(/Depends on: Design schema, Write migration/)).toBeInTheDocument();
    expect(screen.queryByText(/Blocked by/)).not.toBeInTheDocument();
  });

  test("some dependencies incomplete: 'Blocked by' names only the incomplete ones", () => {
    render(
      <TaskHeader
        task={makeTask({
          dependencies: [
            { id: "d1", title: "Design schema", status: "DONE", satisfied: true },
            { id: "d2", title: "Write migration", status: "BACKLOG", satisfied: false },
          ],
        })}
      />,
    );
    expect(screen.getByText(/Depends on: Design schema, Write migration/)).toBeInTheDocument();
    const blocked = screen.getByText(/Blocked by:/);
    expect(blocked).toHaveTextContent("Blocked by: Write migration");
    expect(blocked).not.toHaveTextContent("Design schema");
  });

  test("a CANCELLED dependency is shown as an ordinary incomplete blocker, nothing special-cased", () => {
    render(
      <TaskHeader
        task={makeTask({
          dependencies: [{ id: "d1", title: "Abandoned prerequisite", status: "CANCELLED", satisfied: false }],
        })}
      />,
    );
    expect(screen.getByText(/Blocked by: Abandoned prerequisite/)).toBeInTheDocument();
  });
});
