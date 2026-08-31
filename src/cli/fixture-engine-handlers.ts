import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FixtureCodingEngine } from "../coding-engine/fixture-coding-engine.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../coding-engine/coding-engine.js";
import type { StepResult } from "../domain/types.js";

const CORRECT_ADD = `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`;

async function reviewHandler(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
  const content = await readFile(join(request.workspacePath, "add.js"), "utf-8");
  const correct = content.includes("a + b");
  const result: StepResult = correct
    ? { status: "completed", summary: "add() correctly sums its arguments; tests cover the fix.", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null }
    : {
        status: "completed",
        summary: "add() still does not sum its arguments correctly.",
        filesChanged: [],
        diffRef: null,
        confidence: "low",
        findings: [{ category: "correctness", severity: "blocker", summary: "add(a, b) does not return a + b", location: "add.js" }],
        needsInput: null,
      };
  return { result, cost: null, logExcerpt: "fixture reviewer" };
}

/** Scenario: fixes the bug as soon as it sees a failed validation — proves the self-fix loop reaching REVIEW. */
export function createSelfFixDemoEngine(): FixtureCodingEngine {
  return new FixtureCodingEngine({
    implementer: async (request) => {
      const shouldFix = request.context.lastFailure !== null;
      if (shouldFix) await writeFile(join(request.workspacePath, "add.js"), CORRECT_ADD);
      const result: StepResult = {
        status: "completed",
        summary: shouldFix
          ? "Fixed add() to return the sum of its arguments based on the failing test output."
          : "Implemented an initial version of add().",
        filesChanged: shouldFix ? ["add.js"] : [],
        diffRef: null,
        confidence: shouldFix ? "high" : "medium",
        findings: [],
        needsInput: null,
      };
      return { result, cost: { inputTokens: 500, outputTokens: 120 }, logExcerpt: "fixture implementer" };
    },
    reviewer: reviewHandler,
  });
}

/**
 * Scenario: ignores validation failures on its own (simulating a bug it
 * cannot diagnose from test output alone) but applies the correct fix once a
 * human decision is recorded — proves NEEDS_INPUT -> resume without replaying
 * history (the fixture only ever sees the current ContextBundle).
 */
export function createNeedsInputDemoEngine(): FixtureCodingEngine {
  return new FixtureCodingEngine({
    implementer: async (request) => {
      const humanAnswered = request.context.priorDecisions.some((d) => d.source === "human_answer");
      if (humanAnswered) await writeFile(join(request.workspacePath, "add.js"), CORRECT_ADD);
      const result: StepResult = humanAnswered
        ? {
            status: "completed",
            summary: "Applied the fix confirmed by the developer's answer: add() should sum its arguments.",
            filesChanged: ["add.js"],
            diffRef: null,
            confidence: "high",
            findings: [],
            needsInput: null,
          }
        : {
            status: "needs_input",
            summary: "Cannot determine the intended behavior of add() from the repository alone.",
            filesChanged: [],
            diffRef: null,
            confidence: null,
            findings: [],
            needsInput: {
              discovered: "add(a, b) currently returns a - b and the only test asserts add(2, 3) === 5. The repository has no spec clarifying intended semantics beyond this test.",
              attempted: ["Read add.js and test.js", "Ran the declared test command and observed the failure"],
              blocker: "Two equally plausible fixes exist (change the implementation, or the test may be wrong) and nothing in the repo disambiguates which is correct.",
              question: "Should add() be changed to return a + b, or is the test itself wrong?",
              options: [
                { label: "Fix add() to return a + b", description: "Treat the implementation as the bug." },
                { label: "Fix the test instead", description: "Treat the test's expectation as wrong." },
              ],
            },
          };
      return { result, cost: null, logExcerpt: "fixture implementer (needs-input scenario)" };
    },
    reviewer: reviewHandler,
  });
}
