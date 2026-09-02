import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestDescription, buildPullRequestTitle } from "../src/orchestrator/pull-request-content.js";
import type { ReviewResult, Task, ValidationResult } from "../src/domain/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return { title: "Create a README.md file", goal: "Create a README.md file for this repository explaining what the project does.", ...overrides } as Task;
}

function makeValidation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return { status: "passed", checks: [{ name: "test", command: "npm test", passed: true, exitCode: 0, durationMs: 10, logExcerpt: "" }], durationMs: 10, ...overrides };
}

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { verdict: "approved", findings: [], confidence: "high", summary: "No concerns raised — the README accurately describes the project.", ...overrides };
}

/**
 * The PR body is what a human reviewer reads on GitHub — this test suite
 * exists specifically because a prior bug let the raw OpenCode NDJSON event
 * stream leak into `implementerSummary` (fixed in opencode-adapter.ts's
 * parseResult()). These tests guard the PR-building layer itself: given a
 * clean summary, does it produce valid, readable Markdown — and does it
 * never invent or leak anything the platform doesn't actually have?
 */
test("produces the exact structure requested: # Task / ## Implementation summary / ## Validation / ## Independent review", () => {
  const body = buildPullRequestDescription(makeTask(), "Created `README.md` with a project overview.", makeValidation(), makeReview());

  assert.ok(body.startsWith("# Task\n"));
  assert.ok(body.includes("\n## Implementation summary\n"));
  assert.ok(body.includes("\n## Validation\n"));
  assert.ok(body.includes("\n## Independent review\n"));
});

test("verdict is rendered as a plain, human-readable Verdict line — never the raw enum value", () => {
  const approved = buildPullRequestDescription(makeTask(), "summary", makeValidation(), makeReview({ verdict: "approved" }));
  assert.ok(approved.includes("**Verdict:** Approved"));

  const rejected = buildPullRequestDescription(makeTask(), "summary", makeValidation(), makeReview({ verdict: "rejected" }));
  assert.ok(rejected.includes("**Verdict:** Changes requested"));
  assert.ok(!rejected.includes('"rejected"'));
});

test("no structured findings: shows 'Findings: None' plus the reviewer's own prose, not a hardcoded platitude", () => {
  const review = makeReview({ findings: [], summary: "I verified the README accurately reflects the codebase and found no issues." });
  const body = buildPullRequestDescription(makeTask(), "summary", makeValidation(), review);

  assert.ok(body.includes("**Findings:** None"));
  assert.ok(body.includes("I verified the README accurately reflects the codebase"), "the reviewer's real assessment must not be discarded just because there are no structured findings");
});

test("structured findings present: lists them, and does not duplicate the reviewer's prose summary underneath", () => {
  const review = makeReview({
    verdict: "rejected",
    findings: [
      { category: "correctness", severity: "concern", summary: "The install command in the README doesn't match package.json" },
      { category: "security", severity: "blocker", summary: "README documents a debug endpoint with no auth warning" },
    ],
    summary: "Found two issues that should be addressed before merging.",
  });
  const body = buildPullRequestDescription(makeTask(), "summary", makeValidation(), review);

  assert.ok(body.includes("- **concern** (correctness): The install command in the README doesn't match package.json"));
  assert.ok(body.includes("- **blocker** (security): README documents a debug endpoint with no auth warning"));
  assert.ok(!body.includes("Found two issues that should be addressed"), "prose summary is redundant once real structured findings are listed");
});

test("validation checks render as a readable pass/fail list, and 'no checks declared' is stated plainly", () => {
  const passing = buildPullRequestDescription(
    makeTask(),
    "summary",
    makeValidation({ checks: [{ name: "build", command: "npm run build", passed: true, exitCode: 0, durationMs: 1, logExcerpt: "" }, { name: "test", command: "npm test", passed: false, exitCode: 1, durationMs: 1, logExcerpt: "" }] }),
    makeReview(),
  );
  assert.ok(passing.includes("- build: passed"));
  assert.ok(passing.includes("- test: failed"));

  const none = buildPullRequestDescription(makeTask(), "summary", makeValidation({ checks: [] }), makeReview());
  assert.ok(none.includes("No checks were declared for this project."));
});

test("the implementer's summary (now real Markdown from the fixed parser) is embedded verbatim, preserving headings/lists/code — not re-escaped or flattened", () => {
  const markdownSummary = "Created `README.md` with:\n\n- project overview\n- purpose\n- development instructions\n\n```bash\nnpm install\n```";
  const body = buildPullRequestDescription(makeTask(), markdownSummary, makeValidation(), makeReview());
  assert.ok(body.includes(markdownSummary));
});

test("never contains raw OpenCode event-stream artifacts — the exact class of leak this suite guards against", () => {
  const body = buildPullRequestDescription(makeTask(), "Created README.md with a project overview.", makeValidation(), makeReview());
  for (const artifact of ['"type":"step_start"', '"sessionID"', '"messageID"', '"snapshot"', '"tokens":{', "callID"]) {
    assert.ok(!body.includes(artifact), `PR body must never contain raw event artifact: ${artifact}`);
  }
});

test("PR title is exactly the task's own title — never fabricated or reworded", () => {
  assert.equal(buildPullRequestTitle(makeTask({ title: "Fix the flaky login test" })), "Fix the flaky login test");
});

test("footer always states no auto-merge, regardless of verdict", () => {
  const body = buildPullRequestDescription(makeTask(), "summary", makeValidation(), makeReview());
  assert.ok(body.includes("A human review and merge decision is still required"));
});
