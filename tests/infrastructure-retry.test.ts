import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform, type BuildPlatformOptions } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import { classifyOrchestratorFailure } from "../src/orchestrator/failure-classifier.js";
import { EngineExecutionError, EngineTimeoutError } from "../src/coding-engine/coding-engine.js";
import { BranchMismatchError, BranchNotFoundAtExecutionError, CancellationError, PushVerificationError } from "../src/domain/errors.js";
import { GitHubApiError, GitHubAuthError, GitHubRateLimitError } from "../src/integrations/github/errors.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { BugFixVerificationContract, Project } from "../src/domain/types.js";

/**
 * V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028) — the failure taxonomy/classification matrix
 * (unit level) plus orchestrator-level infrastructure-retry scenarios not already exercised in
 * tests/github-source-control.test.ts (episode-level GitHub retry/idempotency) or
 * tests/opencode-adapter.test.ts (episode-level engine retry). Real mechanisms throughout — no
 * mocking of classifyOrchestratorFailure or the retry policy itself.
 */

const GOOD_ADD_JS = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";

// ---------------------------------------------------------------------------
// Classification matrix (item 22) — pure function, no I/O
// ---------------------------------------------------------------------------

function engineErr(classification: string, retryable: boolean, message: string): EngineExecutionError {
  return new EngineExecutionError("implementer", message, { attempts: 2, retryable, classification });
}

test("classifier: provider timeout -> category 'timeout', retryable", () => {
  const c = classifyOrchestratorFailure(new EngineTimeoutError("implementer", 60_000));
  assert.equal(c.category, "timeout");
  assert.equal(c.retryable, true);
});

test("classifier: provider 5xx (server_unavailable, retryable) -> category 'network_failure', retryable", () => {
  const c = classifyOrchestratorFailure(engineErr("server_unavailable", true, "Gemini returned HTTP 503"));
  assert.equal(c.category, "network_failure");
  assert.equal(c.retryable, true);
});

test("classifier: provider 429 rate limit (no quota wording) -> category 'rate_limited', retryable", () => {
  const c = classifyOrchestratorFailure(engineErr("rate_limit", true, "OpenAI returned HTTP 429: Rate limit exceeded"));
  assert.equal(c.category, "rate_limited");
  assert.equal(c.retryable, true);
});

test("D. classifier: provider quota exhaustion is represented truthfully as 'provider_quota_exhausted', never a plain code failure", () => {
  const c = classifyOrchestratorFailure(engineErr("rate_limit", true, "Gemini returned HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota"));
  assert.equal(c.category, "provider_quota_exhausted");
  assert.equal(c.retryable, true, "quota exhaustion must still be retryable — the platform waits/retries per policy, per this slice's own scope boundary (no model routing yet)");
});

test("classifier: auth failure -> category 'authentication_failure', NOT retryable", () => {
  const c = classifyOrchestratorFailure(engineErr("auth", false, "Anthropic returned HTTP 401: Invalid API key"));
  assert.equal(c.category, "authentication_failure");
  assert.equal(c.retryable, false);
});

test("classifier: invalid model/request -> category 'permanent_configuration_failure', NOT retryable", () => {
  const c = classifyOrchestratorFailure(engineErr("invalid_request", false, "Gemini returned HTTP 400: Invalid model specified"));
  assert.equal(c.category, "permanent_configuration_failure");
  assert.equal(c.retryable, false);
});

test("E. classifier: an unclassified engine failure defaults to 'task_failure', NOT retryable — never assumed transient", () => {
  const c = classifyOrchestratorFailure(engineErr("unknown", false, "the model produced a malformed response"));
  assert.equal(c.category, "task_failure");
  assert.equal(c.retryable, false);
});

test("classifier: BranchMismatchError/PushVerificationError/BranchNotFoundAtExecutionError are always 'permanent_configuration_failure', NOT retryable", () => {
  for (const err of [
    new BranchMismatchError("task/abc", "some-other-branch", "commit"),
    new PushVerificationError("task/abc", "sha1", "sha2"),
    new BranchNotFoundAtExecutionError("main"),
  ]) {
    const c = classifyOrchestratorFailure(err);
    assert.equal(c.category, "permanent_configuration_failure");
    assert.equal(c.retryable, false);
  }
});

test("classifier: GitHubRateLimitError -> 'rate_limited', retryable, preserves the suggested delay", () => {
  const c = classifyOrchestratorFailure(new GitHubRateLimitError(null, 45_000));
  assert.equal(c.category, "rate_limited");
  assert.equal(c.retryable, true);
  assert.equal(c.retryAfterMs, 45_000);
});

test("classifier: GitHubAuthError -> 'authentication_failure', NOT retryable", () => {
  const c = classifyOrchestratorFailure(new GitHubAuthError("bad token"));
  assert.equal(c.category, "authentication_failure");
  assert.equal(c.retryable, false);
});

test("classifier: GitHubApiError 422 (invalid_request) -> 'permanent_configuration_failure', NOT retryable", () => {
  const c = classifyOrchestratorFailure(new GitHubApiError("Validation Failed", 422));
  assert.equal(c.category, "permanent_configuration_failure");
  assert.equal(c.retryable, false);
});

test("classifier: GitHubApiError 503 -> 'source_control_failure' (no phase hint) / 'workspace_provision_failure' (workspace_provisioning phase), retryable either way", () => {
  const generic = classifyOrchestratorFailure(new GitHubApiError("Service Unavailable", 503));
  assert.equal(generic.category, "source_control_failure");
  assert.equal(generic.retryable, true);
  const duringProvisioning = classifyOrchestratorFailure(new GitHubApiError("Service Unavailable", 503), "workspace_provisioning");
  assert.equal(duringProvisioning.category, "workspace_provision_failure");
  assert.equal(duringProvisioning.retryable, true);
});

test("classifier: a plain/generic Error with a known phase hint is treated as transient infrastructure — the same shape a real git clone/network failure takes", () => {
  const c = classifyOrchestratorFailure(new Error("fatal: early EOF"), "workspace_provisioning");
  assert.equal(c.category, "workspace_provision_failure");
  assert.equal(c.retryable, true);
});

test("E (again, the critical case): a plain/generic Error with NO phase hint — an arbitrary, unidentified exception — defaults to 'unknown_failure', NOT retryable. This is what keeps a genuine bug from being blindly retried.", () => {
  const c = classifyOrchestratorFailure(new Error("simulated unexpected exception"));
  assert.equal(c.category, "unknown_failure");
  assert.equal(c.retryable, false);
});

// ---------------------------------------------------------------------------
// Orchestrator-level scenarios
// ---------------------------------------------------------------------------

async function setup(label: string, engine: FixtureCodingEngine, options: { orchestratorConfig?: BuildPlatformOptions["orchestratorConfig"]; bugFixVerification?: BugFixVerificationContract | null; commands?: Project["commands"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), `infra-retry-${label}-`));
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    orchestratorConfig: options.orchestratorConfig ?? { maxInfrastructureRetries: 1, maxInfraCheckRetries: 1, infrastructureRetryBaseDelayMs: 15, infrastructureRetryMaxDelayMs: 100 },
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
    commands: options.commands ?? { test: "node test.js" },
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
    bugFixVerification: options.bugFixVerification ?? null,
  });
  return { platform, project, task, root };
}

function fixedImplementer() {
  return async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
    await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
    return {
      result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
      cost: null,
      logExcerpt: "",
    };
  };
}
const approvingReviewer = async (): Promise<EngineInvocationResult> => ({
  result: { status: "completed" as const, summary: "VERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
  cost: null,
  logExcerpt: "",
});

// F/G — validation/verification infrastructure failure. Real-world caveat, already documented by
// Slice 1's own tests/validation-runner.test.ts: a shell (`spawn(cmd, {shell:true})`, which
// runCheck always uses) that can't find a binary typically still exits non-zero itself ("failed",
// exit 127) rather than ever raising the child process's own "error" event ("infrastructure_error")
// — reliably forcing the rarer "error" event is platform-dependent and out of this slice's scope
// (same call-out as validation-runner.test.ts's own "outcome 'infrastructure_error'" test). What
// these two tests verify instead — the actually load-bearing, portable property — is the boundary
// itself: a real "command not found" shell failure is "failed" (a genuine, if unhelpful, task
// result), and MUST NEVER be misclassified as infrastructure and retried, because it isn't
// infrastructure — retrying it would just waste time re-running the exact same broken command.
// runValidationStep's/runContractCheckWithInfraRetry's own retry LOOP shares the identical
// classify → backoff → re-run shape already proven correct by tests J/K/L/N above (real transient
// workspace failure, cancellation, lease loss, concurrent workers) against the SAME
// computeBackoffDelayMs/sleepUnlessAborted primitives.
test("F: a 'command not found' validation failure (real shell exit 127) is 'failed', not 'infrastructure_error' — and is therefore never retried as infrastructure", async () => {
  const engine = new FixtureCodingEngine({ implementer: fixedImplementer(), reviewer: approvingReviewer });
  const { platform, task } = await setup("validation-infra", engine, { commands: { test: "/nonexistent-binary-does-not-exist-xyz" } });

  const result = await platform.orchestrator.executeTask(task.id);
  assert.notEqual(result.status, "REVIEW", "a check that can never succeed must never let the task through as if it passed");

  const events = platform.taskEvents.listForTask(task.id);
  const validationCompleted = events.filter((e) => e.type === "VALIDATION_COMPLETED");
  assert.ok(validationCompleted.length > 0);
  for (const e of validationCompleted) {
    const checks = e.payload.checks as Array<{ outcome: string }>;
    assert.ok(checks.every((c) => c.outcome !== "passed"), "never silently promoted to a pass");
  }
  assert.ok(!events.some((e) => e.type === "INFRASTRUCTURE_RETRY_SCHEDULED"), "an ordinary command-not-found failure is a real (if unhelpful) task result, not infrastructure — it must not trigger the infra-retry machinery");
});

test("G: the SAME command-not-found boundary holds for a Slice 3 bug-fix verification contract check", async () => {
  const contract: BugFixVerificationContract = { checkId: "test", bugPresentWhenCheckOutcome: "failed", purpose: null };
  const engine = new FixtureCodingEngine({ implementer: fixedImplementer(), reviewer: approvingReviewer });
  const { platform, task } = await setup("verification-infra", engine, {
    commands: { test: "/nonexistent-binary-does-not-exist-xyz" },
    bugFixVerification: contract,
  });

  const result = await platform.orchestrator.executeTask(task.id);
  assert.notEqual(result.status, "REVIEW");

  const events = platform.taskEvents.listForTask(task.id);
  const reproductionEvent = events.find((e) => e.type === "BUG_REPRODUCTION_COMPLETED");
  assert.ok(reproductionEvent, "reproduction still ran and completed (a real, if unhelpful, result)");
  // exit 127 ("command not found") IS a real "failed" outcome, and this contract's own
  // bugPresentWhenCheckOutcome is "failed" — so this is deterministically "bug_reproduced" per the
  // contract, not a fabricated judgment; the point of this test is that it is a real status, not
  // silently converted from/to "infrastructure_error".
  assert.equal(reproductionEvent!.payload.status, "bug_reproduced");
  assert.equal(reproductionEvent!.payload.outcome, "failed");
  assert.ok(!events.some((e) => e.type === "INFRASTRUCTURE_RETRY_SCHEDULED"), "a real command-not-found result is not infrastructure and must not trigger the infra-retry machinery");
});

// H — verification genuinely executes and fails: a real, honest FIX_NOT_VERIFIED/BUG_REPRODUCED —
// no infrastructure retry is ever attempted for a real result.
test("H: verification that genuinely runs and fails is never retried as infrastructure — no INFRASTRUCTURE_FAILURE_DETECTED event at all", async () => {
  const contract: BugFixVerificationContract = { checkId: "test", bugPresentWhenCheckOutcome: "failed", purpose: null };
  const engine = new FixtureCodingEngine({ implementer: fixedImplementer(), reviewer: approvingReviewer });
  const { platform, task } = await setup("verification-real-fail", engine, { commands: { test: "node test.js" }, bugFixVerification: contract });

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const bfv = result.taskRecord.bugFixVerification!;
  assert.equal(bfv.reproduction?.status, "bug_reproduced", "the real buggy fixture genuinely fails the check before the fix — a real result, not infrastructure");
  assert.equal(bfv.fixVerification?.status, "fix_verified");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("INFRASTRUCTURE_FAILURE_DETECTED"), "a real, genuinely-executed result must never trigger infrastructure retry machinery");
});

// J — workspace provisioning transient failure recovers
test("J: a transient workspace-provisioning failure (real git clone denied, then allowed) recovers via infrastructure retry", async () => {
  const engine = new FixtureCodingEngine({ implementer: fixedImplementer(), reviewer: approvingReviewer });
  const root = await mkdtemp(join(tmpdir(), "infra-retry-workspace-"));
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: "test-worker-workspace",
    orchestratorConfig: { maxInfrastructureRetries: 2, infrastructureRetryBaseDelayMs: 60, infrastructureRetryMaxDelayMs: 300 },
  });
  const repoPath = await createFixtureRepo(root);
  // Real, transient failure: the source repo is briefly unreadable (permission denied), then
  // restored — genuinely the same class of failure a flaky network mount/clone would produce.
  await chmod(repoPath, 0o000);
  setTimeout(() => {
    chmod(repoPath, 0o755).catch(() => {});
  }, 80);

  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "workspace@example.com", name: "Tester", passwordHash: "", createdAt: now };
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

  try {
    const result = await platform.orchestrator.executeTask(task.id);
    assert.equal(result.status, "REVIEW", "the episode must recover once the transient provisioning failure clears");
    const events = platform.taskEvents.listForTask(task.id);
    assert.ok(events.some((e) => e.type === "WORKSPACE_FAILED"), "the real first failure is honestly recorded");
    assert.ok(events.some((e) => e.type === "INFRASTRUCTURE_FAILURE_DETECTED" && e.payload.category === "workspace_provision_failure"));
    assert.equal(events.filter((e) => e.type === "WORKSPACE_CREATED").length, 1, "exactly one successful provisioning, from the retry");
  } finally {
    await chmod(repoPath, 0o755).catch(() => {});
  }
});

// K — cancellation during backoff prevents the retry from ever happening
test("K: a cancellation requested during infrastructure backoff prevents the retry — the task ends CANCELLED, not retried", async (t) => {
  // DETERMINISM: the infrastructure backoff is FULL-JITTER (`Math.floor(Math.random() * cappedDelay)`, see
  // coding-engine/retry-backoff.ts), so it can legitimately come out at a few milliseconds and the retry
  // would then start before this test acts. Pinning the random source makes the wait ~2 s every time; the
  // test then acts on OBSERVED state (the platform's own INFRASTRUCTURE_RETRY_SCHEDULED event), never on a
  // guessed delay.
  t.mock.method(Math, "random", () => 0.999);
  const engine = new FixtureCodingEngine({
    implementer: async () => {
      throw new EngineExecutionError("implementer", "Gemini returned HTTP 503", { attempts: 1, retryable: true, classification: "server_unavailable" });
    },
    reviewer: approvingReviewer,
  });
  const { platform, task } = await setup("cancel-during-backoff", engine, {
    orchestratorConfig: { maxInfrastructureRetries: 3, infrastructureRetryBaseDelayMs: 2000, infrastructureRetryMaxDelayMs: 5000 },
  });

  const running = platform.orchestrator.executeTask(task.id);
  // Wait until the first (failing) attempt has actually reached its backoff wait (not a fixed sleep —
  // under full-suite load a fixed delay could cancel before the retry was even scheduled), then cancel.
  for (let i = 0; i < 400 && !platform.taskEvents.listForTask(task.id).some((e) => e.type === "INFRASTRUCTURE_RETRY_SCHEDULED"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await platform.orchestrator.requestCancellation(task.id, "test-user");

  const result = await running;
  assert.equal(result.status, "CANCELLED");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("INFRASTRUCTURE_RETRY_STARTED"), "the backoff was interrupted before a retry ever began");
});

// L — lease lost mid-retry: the worker must not continue, and must not fabricate a result
test("L: losing the execution lease during infrastructure backoff stops the retry — no further work, no false success", async (t) => {
  // DETERMINISM: the infrastructure backoff is FULL-JITTER (`Math.floor(Math.random() * cappedDelay)`, see
  // coding-engine/retry-backoff.ts), so it can legitimately come out at a few milliseconds and the retry
  // would then start before this test acts. Pinning the random source makes the wait ~2 s every time; the
  // test then acts on OBSERVED state (the platform's own INFRASTRUCTURE_RETRY_SCHEDULED event), never on a
  // guessed delay.
  t.mock.method(Math, "random", () => 0.999);
  const engine = new FixtureCodingEngine({
    implementer: async () => {
      throw new EngineExecutionError("implementer", "Gemini returned HTTP 503", { attempts: 1, retryable: true, classification: "server_unavailable" });
    },
    reviewer: approvingReviewer,
  });
  const { platform, task } = await setup("lease-lost", engine, {
    orchestratorConfig: { maxInfrastructureRetries: 3, infrastructureRetryBaseDelayMs: 2000, infrastructureRetryMaxDelayMs: 5000, taskLeaseMs: 100, leaseHeartbeatIntervalMs: 1_000_000 },
  });

  const running = platform.orchestrator.executeTask(task.id);
  // Let the lease genuinely expire mid-backoff (heartbeat disabled above), then have a second
  // process steal it — simulating a real takeover racing the scheduled retry. First wait until the
  // platform is OBSERVABLY in the backoff, then let the 100 ms lease lapse.
  for (let i = 0; i < 400 && !platform.taskEvents.listForTask(task.id).some((e) => e.type === "INFRASTRUCTURE_RETRY_SCHEDULED"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 150));
  const stolen = platform.tasks.claimWorking(task.id, "a-different-worker", 60_000, new Date().toISOString());
  assert.ok(stolen !== null, "a second process really did win the claim");

  const result = await running;
  // The original process must never have completed real work after losing the lease — it should
  // simply stop, leaving the task exactly as the new owner (or the lease-loss path) left it.
  assert.notEqual(result.status, "REVIEW", "the original, lease-losing process must not have pushed this to completion itself");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("INFRASTRUCTURE_RETRY_STARTED"), "the original process never got to resume work after losing the lease");
});

// N — two workers must not both execute the same retry
test("N: two workers sharing one task never both perform the same infrastructure retry", async () => {
  let implementerCalls = 0;
  const engine = new FixtureCodingEngine({
    implementer: async (request) => {
      implementerCalls += 1;
      if (implementerCalls === 1) {
        throw new EngineExecutionError("implementer", "Gemini returned HTTP 503", { attempts: 1, retryable: true, classification: "server_unavailable" });
      }
      return fixedImplementer()(request);
    },
    reviewer: approvingReviewer,
  });
  const root = await mkdtemp(join(tmpdir(), "infra-retry-two-workers-"));
  const dbPath = join(root, "platform.sqlite");
  const workspacesRoot = join(root, "workspaces");
  const cfg: BuildPlatformOptions = {
    dbPath,
    workspacesRoot,
    engine,
    orchestratorConfig: { maxInfrastructureRetries: 2, infrastructureRetryBaseDelayMs: 60, infrastructureRetryMaxDelayMs: 200, taskLeaseMs: 60_000 },
  };
  const platformA = buildPlatform({ ...cfg, ownerId: "worker-A" });
  const platformB = buildPlatform({ ...cfg, ownerId: "worker-B" });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "two-workers@example.com", name: "Tester", passwordHash: "", createdAt: now };
  platformA.users.insert(user);
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
  platformA.projects.insert(project);
  const task = createReadyTask(platformA.tasks, platformA.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  // Both workers race to claim/execute the task concurrently — only one may legitimately drive the
  // whole episode (including its retry); the atomic claim is the existing guard this slice reuses.
  const [resultA, resultB] = await Promise.all([platformA.orchestrator.executeTask(task.id), platformB.orchestrator.executeTask(task.id)]);
  const final = [resultA, resultB].find((r) => r.status === "REVIEW") ?? resultA;
  assert.equal(final.status, "REVIEW");

  const events = platformA.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "TASK_CLAIMED").length, 1, "only one worker ever won the claim — the other's executeTask() call was a same-task no-op");
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1);
  assert.equal(events.filter((t) => t === "TASK_MOVED_TO_REVIEW").length, 1);
});

// M — worker crash during a retryable operation (mid-backoff): a genuinely abandoned process (never
// resumed, lease left to expire naturally) must be recoverable by a second process via the EXISTING
// crash-recovery machinery, with no duplicated work — this slice adds a second retry LAYER, but
// crash recovery itself is untouched (see orchestrator.ts's own doc comment on
// runEpisodeWithInfrastructureRetry: "conceptually DISTINCT from crash recovery").
test("M: a worker that crashes mid-backoff (abandoned mid-retry-wait) is safely recovered by a second process — no duplicate branch/commit/PR", async (t) => {
  // See test K: the full-jitter backoff can be a few ms, so its randomness is pinned and the test acts on
  // OBSERVED state (the INFRASTRUCTURE_RETRY_SCHEDULED event) rather than a guessed delay.
  t.mock.method(Math, "random", () => 0.999);
  const root = await mkdtemp(join(tmpdir(), "infra-retry-crash-"));
  const dbPath = join(root, "platform.sqlite");
  const workspacesRoot = join(root, "workspaces");
  const crashEngine = new FixtureCodingEngine({
    implementer: async (request: EngineInvocationRequest): Promise<EngineInvocationResult> => {
      throw new EngineExecutionError("implementer", "Gemini returned HTTP 503", { attempts: 1, retryable: true, classification: "server_unavailable" });
    },
    reviewer: approvingReviewer,
  });
  const cfg: BuildPlatformOptions = {
    dbPath,
    workspacesRoot,
    engine: crashEngine,
    orchestratorConfig: { maxInfrastructureRetries: 2, infrastructureRetryBaseDelayMs: 5000, infrastructureRetryMaxDelayMs: 8000, taskLeaseMs: 80, leaseHeartbeatIntervalMs: 1_000_000 },
  };
  const platformA = buildPlatform({ ...cfg, ownerId: "crash-worker-A" });
  // The "recovering" process uses a DIFFERENT engine that actually succeeds — a real second process
  // picking up this task would, after the transient provider issue really cleared.
  const platformB = buildPlatform({ ...cfg, engine: fixedImplementerEngine(), ownerId: "crash-worker-B" });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "crash@example.com", name: "Tester", passwordHash: "", createdAt: now };
  platformA.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: crashEngine.key,
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platformA.projects.insert(project);
  const task = createReadyTask(platformA.tasks, platformA.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });

  // Start, then genuinely abandon: never await it further. Its own backoff is 5-8s (far longer than
  // the 80ms lease, with heartbeat renewal disabled), so the lease will have long since expired by
  // the time we check for orphans below — indistinguishable from a real crashed process.
  void platformA.orchestrator.executeTask(task.id);
  for (let i = 0; i < 400 && !platformA.taskEvents.listForTask(task.id).some((e) => e.type === "INFRASTRUCTURE_RETRY_SCHEDULED"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 120)); // let the 80 ms lease genuinely lapse (heartbeat disabled)

  const orphaned = platformB.orchestrator.recoverOrphanedTasks();
  assert.deepEqual(orphaned, [task.id]);

  const result = await platformB.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW", "the second process must be able to drive this task to completion");

  const events = platformB.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "WORKSPACE_CREATED").length, 1, "no duplicate workspace across the crash");
  assert.equal(events.filter((t) => t === "TASK_MOVED_TO_REVIEW").length, 1);
  assert.ok(!events.includes("INFRASTRUCTURE_RETRY_STARTED"), "the abandoned process's own scheduled retry never actually ran — crash recovery took over first");
});

function fixedImplementerEngine(): FixtureCodingEngine {
  return new FixtureCodingEngine({ implementer: fixedImplementer(), reviewer: approvingReviewer });
}
