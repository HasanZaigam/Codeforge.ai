import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TokenBudgetForm, TokenMeter } from "./TokenMeter.js";
import { formatTokens, tokenLabel } from "../../lib/tokens.js";
import type { TokenMeterDTO } from "../../api/index.js";

const meter = (overrides: Partial<TokenMeterDTO> = {}): TokenMeterDTO => ({
  periodStart: "2026-10-01T00:00:00.000Z",
  used: 1_240_000,
  estimatedTokens: 0,
  unreportedOperations: 0,
  budget: 2_000_000,
  remaining: 760_000,
  percentUsed: 62,
  ...overrides,
});

describe("token formatting", () => {
  test("compact numbers, and estimates are always labelled", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(1_240_000)).toBe("1.24M");
    expect(tokenLabel(2847, false)).toBe("2.8K tokens");
    expect(tokenLabel(3200, true)).toBe("~3.2K tokens (est.)");
  });
});

describe("TokenMeter", () => {
  test("shows used, budget, what's left and a progress bar", () => {
    render(<TokenMeter meter={meter()} label="Project token usage" />);
    expect(screen.getByText("1.24M")).toBeInTheDocument();
    expect(screen.getByText(/of 2.00M tokens/)).toBeInTheDocument();
    expect(screen.getByText("760K left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");
  });

  test("over budget says so — it never shows negative tokens left", () => {
    render(<TokenMeter meter={meter({ used: 2_500_000, remaining: 0, percentUsed: 125 })} label="Project token usage" />);
    expect(screen.getByText("Over budget")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  test("without a budget there's no countdown, just usage", () => {
    render(<TokenMeter meter={meter({ budget: null, remaining: null, percentUsed: null })} label="Project token usage" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/No monthly budget set/)).toBeInTheDocument();
  });

  test("estimated and unreported usage are called out", () => {
    render(<TokenMeter meter={meter({ estimatedTokens: 3200, unreportedOperations: 2 })} label="Project token usage" />);
    expect(screen.getByText(/~3.2K of this is estimated/)).toBeInTheDocument();
    expect(screen.getByText(/2 AI runs reported no usage/)).toBeInTheDocument();
  });
});

describe("TokenBudgetForm", () => {
  test("saves a whole-number budget and can remove it", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<TokenBudgetForm id="b" budget={null} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText("Monthly token budget"), "2,000,000");
    await userEvent.click(screen.getByRole("button", { name: "Save budget" }));
    expect(onSave).toHaveBeenCalledWith(2_000_000);

    rerender(<TokenBudgetForm id="b" budget={2_000_000} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove budget" }));
    expect(onSave).toHaveBeenLastCalledWith(null);
  });

  test("rejects a non-number", async () => {
    render(<TokenBudgetForm id="b" budget={null} onSave={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Monthly token budget"), "lots");
    expect(screen.getByText(/Enter a whole number of tokens/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save budget" })).toBeDisabled();
  });
});
