import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BranchStateNote } from "./BranchStateNote.js";
import { makeTask } from "../../test/fixtures.js";
import type { BranchStateDTO } from "../../api/index.js";

function makeBranchState(overrides: Partial<BranchStateDTO> = {}): BranchStateDTO {
  return { aheadBy: 0, behindBy: 0, comparable: true, mergeState: "READY", ...overrides };
}

describe("BranchStateNote", () => {
  test("renders nothing while no branch exists yet (task still TODO)", () => {
    const { container } = render(<BranchStateNote task={makeTask({ branchName: null })} branchState={makeBranchState()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("renders nothing for READY — no warning noise for the common case", () => {
    const { container } = render(<BranchStateNote task={makeTask({ branchName: "task/fix-login" })} branchState={makeBranchState({ mergeState: "READY" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows "N commits behind" using the real count, never a fabricated number', () => {
    render(
      <BranchStateNote
        task={makeTask({ branchName: "task/fix-login", branchMode: "new" })}
        branchState={makeBranchState({ mergeState: "BEHIND", behindBy: 3, comparable: true })}
      />,
    );
    expect(screen.getByText("3 commits behind base branch")).toBeInTheDocument();
  });

  test("singular commit count reads naturally", () => {
    render(<BranchStateNote task={makeTask({ branchName: "task/x" })} branchState={makeBranchState({ mergeState: "BEHIND", behindBy: 1 })} />);
    expect(screen.getByText("1 commit behind base branch")).toBeInTheDocument();
  });

  test("shows a conflict warning distinctly from the behind note", () => {
    render(<BranchStateNote task={makeTask({ branchName: "task/x" })} branchState={makeBranchState({ mergeState: "CONFLICT", behindBy: 0 })} />);
    expect(screen.getByText("Merge conflict")).toBeInTheDocument();
  });

  test("never shows anything for NOT_APPLICABLE (local-git) — no fabricated GitHub-style state", () => {
    const { container } = render(
      <BranchStateNote task={makeTask({ branchName: "task/x", branchMode: "existing" })} branchState={makeBranchState({ mergeState: "NOT_APPLICABLE" })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("comparable:false never fabricates a behind count", () => {
    render(<BranchStateNote task={makeTask({ branchName: "task/x" })} branchState={makeBranchState({ mergeState: "UNKNOWN", comparable: false, behindBy: null })} />);
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
  });
});
