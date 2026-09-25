import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import type { Project } from "../src/domain/types.js";

/**
 * V1.1 Slice 2 — orchestrator-level regression suite for the
 * Reviewer-requested, platform-executed verification round trip (see
 * PLATFORM_GAPS.md GAP-016 and /docs/SECURITY_ARCHITECTURE.md "AI may
 * request verification. CodeForge owns verification evidence."). Uses a
 * real fixture repository and a real spawned `node test.js` — the same
 * pattern as tests/branch-integrity.test.ts — so nothing here is mocked
 * away at the layer this slice is actually about.
 */

const GOOD_ADD_JS = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";

async function setup(label: string, engine: FixtureCodingEngine) {
  const root = await mkdtemp(join(tmpdir(), `reviewer-verification-integration-${label}-`));
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: `${label}@example.com`, name: "Tester", passwordHash: "", createdAt: now };
  platform.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  const task = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
  return { platform, project, task };
}

function fixedImplementer() {
  return async (request: { workspacePath: string }) => {
    await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
    return {
      result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
      cost: null,
      logExcerpt: "",
    };
  };
}

// ---------------------------------------------------------------------------
// A — reviewer requests an approved verification; the platform executes it
// and the reviewer's real approval is backed by real evidence
// ---------------------------------------------------------------------------

test("A: reviewer requests an approved check, the platform executes it, and the reviewer's follow-up approval is recorded as platform-backed EXECUTED", async () => {
  const engine = new FixtureCodingEngine({
    implementer: fixedImplementer(),
    reviewer: async (request) => {
      if (!request.context.verificationEvidence) {
        return {
          result: { status: "completed", summary: "VERIFY: test\nPURPOSE: confirm add() now sums correctly", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
          cost: null,
          logExcerpt: "",
        };
      }
      const ev = request.context.verificationEvidence;
      return {
        result: {
          status: "completed",
          summary: `The platform ran the test suite for me — outcome: ${ev.outcome}.\n\nVERIFICATION: EXECUTED\nVERDICT: APPROVED`,
          filesChanged: [],
          diffRef: null,
          confidence: "high",
          findings: [],
          needsInput: null,
        },
        cost: null,
        logExcerpt: "",
      };
    },
  });
  const { platform, task } = await setup("scenario-a", engine);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const events = platform.taskEvents.listForTask(task.id);
  const requested = events.find((e) => e.type === "REVIEWER_VERIFICATION_REQUESTED");
  const completed = events.find((e) => e.type === "REVIEWER_VERIFICATION_COMPLETED");
  assert.ok(requested, "expected a REVIEWER_VERIFICATION_REQUESTED event");
  assert.equal(requested!.payload.checkId, "test");
  assert.ok(completed, "expected a REVIEWER_VERIFICATION_COMPLETED event");
  assert.equal(completed!.payload.outcome, "passed");
  assert.equal(completed!.payload.command, "node test.js");

  const review = events.filter((e) => e.type === "REVIEW_COMPLETED").at(-1);
  assert.ok(review);
  assert.equal(review!.payload.verificationMethod, "executed");
  assert.equal((review!.payload.verification as { outcome: string }).outcome, "passed");
});

// ---------------------------------------------------------------------------
// E — a fabricated EXECUTED claim with no VERIFY: request never becomes
// platform evidence
// ---------------------------------------------------------------------------

test("E: reviewer claims VERIFICATION: EXECUTED without ever requesting a verification — the platform never ran anything, so the recorded method is 'static', not 'executed'", async () => {
  const engine = new FixtureCodingEngine({
    implementer: fixedImplementer(),
    reviewer: async () => ({
      result: {
        status: "completed",
        summary: "I ran the full test suite myself and everything passed.\n\nVERIFICATION: EXECUTED\nVERDICT: APPROVED",
        filesChanged: [],
        diffRef: null,
        confidence: "high",
        findings: [],
        needsInput: null,
      },
      cost: null,
      logExcerpt: "",
    }),
  });
  const { platform, task } = await setup("scenario-e", engine);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const events = platform.taskEvents.listForTask(task.id);
  assert.ok(!events.some((e) => e.type === "REVIEWER_VERIFICATION_REQUESTED"), "no request was ever made");
  assert.ok(!events.some((e) => e.type === "REVIEWER_VERIFICATION_COMPLETED"), "nothing was ever executed");

  const review = events.filter((e) => e.type === "REVIEW_COMPLETED").at(-1);
  assert.equal(review!.payload.verificationMethod, "static", "a text-only EXECUTED claim with no platform evidence must never be recorded as executed");
});

// ---------------------------------------------------------------------------
// F — an unknown/unapproved check request is rejected, never executed, and
// never counts as evidence
// ---------------------------------------------------------------------------

test("F: reviewer requests an unapproved check — the request is rejected, nothing executes, and the task still reaches REVIEW rather than failing", async () => {
  const engine = new FixtureCodingEngine({
    implementer: fixedImplementer(),
    reviewer: async (request) => {
      if (!request.context.verificationEvidence) {
        return {
          result: { status: "completed", summary: "VERIFY: deploy-to-production", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
          cost: null,
          logExcerpt: "",
        };
      }
      return {
        result: { status: "completed", summary: "That wasn't allowed, so I'll just review statically.\n\nVERIFICATION: STATIC\nVERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
        cost: null,
        logExcerpt: "",
      };
    },
  });
  const { platform, task } = await setup("scenario-f", engine);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW", "a rejected verification request must not fail the task");

  const events = platform.taskEvents.listForTask(task.id);
  const completed = events.find((e) => e.type === "REVIEWER_VERIFICATION_COMPLETED");
  assert.ok(completed);
  assert.equal(completed!.payload.outcome, "rejected");
  assert.equal(completed!.payload.command, null, "nothing was ever executed for an unapproved check");

  const review = events.filter((e) => e.type === "REVIEW_COMPLETED").at(-1);
  assert.equal(review!.payload.verificationMethod, "static", "a rejected request never counts as executed evidence");
});

// ---------------------------------------------------------------------------
// H — verification evidence is bound to the exact commit it ran against;
// a later commit gets its own, distinct evidence, never the stale one
// ---------------------------------------------------------------------------

test("H: verification evidence from a rejected cycle (commit A) is never reused as evidence for the fixed cycle's new commit (commit B)", async () => {
  let implementerCalls = 0;
  const engine = new FixtureCodingEngine({
    implementer: async (request) => {
      implementerCalls += 1;
      // The second implementer pass makes a real, distinct change so a genuinely new commit exists
      // for the second review cycle to verify — never the same commit re-inspected.
      const content = implementerCalls === 1 ? GOOD_ADD_JS : `${GOOD_ADD_JS}\n// re-confirmed after review\n`;
      await writeFile(join(request.workspacePath, "add.js"), content);
      return {
        result: { status: "completed", summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high", findings: [], needsInput: null },
        cost: null,
        logExcerpt: "",
      };
    },
    reviewer: async (request) => {
      const alreadyRejectedOnce = request.context.priorDecisions.some((d) => d.summary.includes("Independent review rejected"));
      if (!request.context.verificationEvidence) {
        return {
          result: { status: "completed", summary: "VERIFY: test", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
          cost: null,
          logExcerpt: "",
        };
      }
      if (!alreadyRejectedOnce) {
        return {
          result: {
            status: "completed",
            summary: "Want a second pass to be sure.\n\nVERIFICATION: EXECUTED\nFINDING: concern | test_gap | want a second confirmation\nVERDICT: CHANGES_REQUESTED",
            filesChanged: [],
            diffRef: null,
            confidence: "high",
            findings: [],
            needsInput: null,
          },
          cost: null,
          logExcerpt: "",
        };
      }
      return {
        result: { status: "completed", summary: "Confirmed again.\n\nVERIFICATION: EXECUTED\nVERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
        cost: null,
        logExcerpt: "",
      };
    },
  });
  const { platform, task } = await setup("scenario-h", engine);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const completedEvents = platform.taskEvents.listForTask(task.id).filter((e) => e.type === "REVIEWER_VERIFICATION_COMPLETED");
  assert.equal(completedEvents.length, 2, "one verification per review cycle");
  const commitA = completedEvents[0]!.payload.commitSha as string;
  const commitB = completedEvents[1]!.payload.commitSha as string;
  assert.ok(commitA && commitB, "both verifications must be bound to a real commit");
  assert.notEqual(commitA, commitB, "the second review cycle's evidence must be bound to the NEW commit the fix produced, never the stale first commit");
});

// ---------------------------------------------------------------------------
// J/K — existing reviewer rejection/fix and approval loops still work when
// no VERIFY: request is ever made
// ---------------------------------------------------------------------------

test("J/K: ordinary approve/reject review loop (no verification requested at all) behaves exactly as before this slice", async () => {
  let reviewCalls = 0;
  const engine = new FixtureCodingEngine({
    implementer: fixedImplementer(),
    reviewer: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          result: { status: "completed", summary: "FINDING: concern | test_gap | needs another look\nVERDICT: CHANGES_REQUESTED", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
          cost: null,
          logExcerpt: "",
        };
      }
      return {
        result: { status: "completed", summary: "VERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
        cost: null,
        logExcerpt: "",
      };
    },
  });
  const { platform, task } = await setup("scenario-jk", engine);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  const events = platform.taskEvents.listForTask(task.id);
  assert.ok(!events.some((e) => e.type.startsWith("REVIEWER_VERIFICATION")), "no verification machinery is triggered when the reviewer never asks for one");
  assert.ok(events.some((e) => e.type === "REVIEW_CHANGES_REQUESTED"));
  assert.ok(events.some((e) => e.type === "TASK_MOVED_TO_REVIEW"));
});
