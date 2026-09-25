import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { FakeSourceControlProvider } from "./helpers/fake-source-control-provider.js";
import type { Project, StepResult } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * V1.1 Slice 1 — the regression suite for PLATFORM_GAPS.md GAP-015 (a coding
 * engine moved the workspace off its task branch; every downstream step —
 * commit, push, review, PR — kept reporting success) and GAP-024 ("AI
 * claims are not execution evidence"). Sections A/B use the shared
 * FakeSourceControlProvider for fast, deterministic coverage of each
 * distinct failure shape; section "real git" reproduces the actual incident
 * end to end against a genuine repository, with no mocking at all.
 */

function makeTask(platform: Platform, project: Project) {
  return createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

async function setupFake(label: string, engine: FixtureCodingEngine) {
  const root = await mkdtemp(join(tmpdir(), `branch-integrity-${label}-`));
  const scProvider = new FakeSourceControlProvider("github");
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    additionalSourceControlProviders: [scProvider],
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
    sourceControlProvider: "github",
    owner: "acme",
    repo: "widgets",
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  return { platform, project, user, scProvider };
}

const fixEngine = new FixtureCodingEngine({
  implementer: async (request) => {
    // Writes a genuinely correct fix so the real `node test.js` validation command actually
    // passes — these tests are about what happens AFTER validation passes and prepareChanges
    // (commit/push) runs, not about the self-fix loop itself.
    await writeFile(join(request.workspacePath, "add.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
    return {
      result: { status: "completed", summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high", findings: [], needsInput: null },
      cost: null,
      logExcerpt: "",
    };
  },
  reviewer: async () => ({
    result: { status: "completed", summary: "VERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high", findings: [], needsInput: null },
    cost: null,
    logExcerpt: "",
  }),
});

// ---------------------------------------------------------------------------
// A — commit-time branch mismatch
// ---------------------------------------------------------------------------

test("A: a branch mismatch detected at commit time fails the task, records expected/actual branch in the event, and never records COMMIT_CREATED or BRANCH_PUSHED", async () => {
  const { platform, project, scProvider } = await setupFake("commit-mismatch", fixEngine);
  const task = makeTask(platform, project);
  scProvider.simulateBranchMismatchOn("commitAll");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");

  const events = platform.taskEvents.listForTask(task.id);
  const types = events.map((e) => e.type);
  assert.ok(!types.includes("COMMIT_CREATED"), "nothing was committed");
  assert.ok(!types.includes("BRANCH_PUSHED"), "nothing was pushed — commit never happened, so push was never attempted");

  const failure = events.find((e) => e.type === "SOURCE_CONTROL_FAILED");
  assert.ok(failure, "expected a structured SOURCE_CONTROL_FAILED event");
  assert.ok(typeof failure!.payload.expectedBranch === "string" && (failure!.payload.expectedBranch as string).startsWith("task/"), "expectedBranch must be present as its own structured field, not buried in a string");
  assert.equal(failure!.payload.actualBranch, "some-other-branch-the-agent-checked-out");
});

// ---------------------------------------------------------------------------
// B — push-time branch mismatch and remote-verification mismatch
// ---------------------------------------------------------------------------

test("B1: a branch mismatch detected at push time fails the task after a real commit, records both branch names, and never records BRANCH_PUSHED", async () => {
  const { platform, project, scProvider } = await setupFake("push-mismatch", fixEngine);
  const task = makeTask(platform, project);
  scProvider.simulateBranchMismatchOn("push");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");
  assert.ok(result.taskRecord.latestDiffRef, "the commit is real evidence and must survive even though the push never happened");

  const events = platform.taskEvents.listForTask(task.id);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("COMMIT_CREATED"));
  assert.ok(!types.includes("BRANCH_PUSHED"));

  const failure = events.find((e) => e.type === "SOURCE_CONTROL_FAILED");
  assert.equal(failure!.payload.actualBranch, "some-other-branch-the-agent-checked-out");
});

test("B2: a push that exits successfully but the remote ref disagrees is treated as a real failure — 'git push exited 0' is not sufficient evidence on its own", async () => {
  const { platform, project, scProvider } = await setupFake("push-verify-mismatch", fixEngine);
  const task = makeTask(platform, project);
  scProvider.simulateRemoteVerificationMismatch("a-completely-different-remote-sha");

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");

  const events = platform.taskEvents.listForTask(task.id);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("COMMIT_CREATED"));
  assert.ok(!types.includes("BRANCH_PUSHED"), "verification failed before BRANCH_PUSHED was ever recorded");

  const failure = events.find((e) => e.type === "SOURCE_CONTROL_FAILED");
  assert.equal(failure!.payload.remoteSha, "a-completely-different-remote-sha");
  assert.ok(typeof failure!.payload.expectedSha === "string" && (failure!.payload.expectedSha as string).length > 0);
});

test("B3: the ordinary case — push succeeds and the remote verifies — still reaches REVIEW exactly as before this slice", async () => {
  const { platform, project } = await setupFake("push-happy", fixEngine);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  const types = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(types.includes("COMMIT_CREATED"));
  assert.ok(types.includes("BRANCH_PUSHED"));
  assert.ok(types.includes("TASK_MOVED_TO_REVIEW"));
});

// ---------------------------------------------------------------------------
// Real git, no mocking — the authentic GAP-015 reproduction: the coding
// engine runs its own `git checkout -b` and commits there, exactly as the
// real incident did.
// ---------------------------------------------------------------------------

test("real git: an implementer that checks out its own branch and leaves a real diff there is refused — the fixture repo's remote never receives the change", async () => {
  const root = await mkdtemp(join(tmpdir(), "branch-integrity-realgit-"));
  const engine = new FixtureCodingEngine({
    implementer: async (request) => {
      // Exactly the real incident: the engine manages its own git branch instead of leaving the
      // workspace on the branch the platform already checked out for it.
      await execFileAsync("git", ["checkout", "-b", "agent-decided-to-branch-here"], { cwd: request.workspacePath });
      await writeFile(join(request.workspacePath, "add.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
      const result: StepResult = {
        status: "completed",
        summary: "Fixed add() to return the sum.",
        filesChanged: ["add.js"],
        diffRef: null,
        confidence: "high",
        findings: [],
        needsInput: null,
      };
      return { result, cost: null, logExcerpt: "" };
    },
  });
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: "test-worker-realgit",
  });
  const repoPath = await createFixtureRepo(root);
  const { stdout: originalMainSha } = await execFileAsync("git", ["rev-parse", "main"], { cwd: repoPath });
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "realgit@example.com", name: "Tester", passwordHash: "", createdAt: now };
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
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");

  const failure = platform.taskEvents.listForTask(task.id).find((e) => e.type === "SOURCE_CONTROL_FAILED");
  assert.ok(failure);
  assert.equal(failure!.payload.actualBranch, "agent-decided-to-branch-here");
  assert.ok(typeof failure!.payload.expectedBranch === "string" && (failure!.payload.expectedBranch as string).startsWith("task/"));

  // The real, authoritative fact: the fixture "remote" repository itself never moved. This is what
  // actually happened in the real incident and is the only check that cannot be fooled by anything
  // the orchestrator merely believes — it is reading the same repository GitHub would be.
  const { stdout: mainAfter } = await execFileAsync("git", ["rev-parse", "main"], { cwd: repoPath });
  assert.equal(mainAfter.trim(), originalMainSha.trim(), "main must be exactly where it started");
  const { stdout: branches } = await execFileAsync("git", ["branch", "--list"], { cwd: repoPath });
  assert.ok(!branches.includes("task/"), "no task branch was ever created on the real remote — nothing was pushed");
});

// ---------------------------------------------------------------------------
// C — evidence integrity (see PLATFORM_GAPS.md GAP-024: reports must never
// contain verification output the platform did not itself produce)
// ---------------------------------------------------------------------------

test("C: an implementer that claims validation passed in prose, without actually fixing the bug, does not make the platform record a pass — the real command's real exit code is what counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "branch-integrity-evidence-"));
  const engine = new FixtureCodingEngine({
    implementer: async () => ({
      // The AI's own summary loudly claims success. It changed nothing — add.js still has its bug.
      result: {
        status: "completed",
        summary: "All tests passed! ✅ Verified add() now returns the correct sum in every case.",
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
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: "test-worker-evidence",
    orchestratorConfig: { maxSelfFixAttempts: 1 },
  });
  const repoPath = await createFixtureRepo(root); // add.js still has its real bug (a - b instead of a + b)
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "evidence@example.com", name: "Tester", passwordHash: "", createdAt: now };
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
    commands: { test: "node test.js" }, // the real fixture test: assert.strictEqual(add(2,3), 5)
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);

  // Never reaches REVIEW/DONE on the strength of the AI's own claim — the real command really did fail.
  assert.notEqual(result.status, "REVIEW");
  assert.notEqual(result.status, "DONE");

  const validationEvent = platform.taskEvents.listForTask(task.id).find((e) => e.type === "VALIDATION_COMPLETED");
  assert.ok(validationEvent);
  assert.equal(validationEvent!.payload.outcome, "checks_failed", "the platform's own execution, not the AI's prose, is what outcome reflects");
  const checks = validationEvent!.payload.checks as Array<{ passed: boolean }>;
  assert.equal(checks[0]!.passed, false, "the real `node test.js` really did fail — the summary's claim of success changed nothing");
});
