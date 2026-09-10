import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NeedsInputPanel } from "./NeedsInputPanel.js";
import { makeInputRequest, makeTask } from "../../test/fixtures.js";

const ZERO_DIFF_OPTIONS = [
  { label: "No change was needed", description: "Confirm the task is effectively already satisfied — close it out without a code change." },
  { label: "Clarify the task", description: "Give the specific file(s) or behavior that should have changed." },
  { label: "Allow modifying existing files", description: "Explicitly permit editing files the AI currently treats as off-limits." },
];

function renderPanel(onSubmit = vi.fn().mockResolvedValue(makeTask())) {
  const input = makeInputRequest({ options: ZERO_DIFF_OPTIONS });
  render(<NeedsInputPanel input={input} onSubmit={onSubmit} submitting={false} />);
  return { onSubmit };
}

describe("NeedsInputPanel", () => {
  test("'No change was needed' selected + empty textarea → Continue is enabled", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("radio", { name: /No change was needed/ }));
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });

  test("'No change was needed' selected + empty textarea → submits using the option label as the decision", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderPanel();
    await user.click(screen.getByRole("radio", { name: /No change was needed/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onSubmit).toHaveBeenCalledWith({ selectedOption: "No change was needed", freeText: "No change was needed" });
  });

  test("'No change was needed' selected + text entered → Continue enabled and the entered text is submitted", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderPanel();
    await user.click(screen.getByRole("radio", { name: /No change was needed/ }));
    await user.type(screen.getByLabelText(/Your decision/), "Confirmed, file already has the requested content.");
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onSubmit).toHaveBeenCalledWith({
      selectedOption: "No change was needed",
      freeText: "Confirmed, file already has the requested content.",
    });
  });

  test("'Clarify the task' selected + empty textarea → Continue stays disabled", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("radio", { name: /Clarify the task/ }));
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  test("'Clarify the task' selected + text entered → Continue enabled", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("radio", { name: /Clarify the task/ }));
    await user.type(screen.getByLabelText(/Your decision/), "Please update src/foo.ts instead.");
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });

  test("'Allow modifying existing files' selected + empty textarea → Continue stays disabled", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("radio", { name: /Allow modifying existing files/ }));
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  test("'Allow modifying existing files' selected + text entered → Continue enabled", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("radio", { name: /Allow modifying existing files/ }));
    await user.type(screen.getByLabelText(/Your decision/), "Yes, you may edit that file.");
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });

  test("no option selected and empty textarea → Continue stays disabled (existing behavior preserved)", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });
});
