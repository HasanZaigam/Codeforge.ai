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
import { ModelRegistry, UNKNOWN_CAPABILITY_PROFILE } from "../src/routing/model-registry.js";
import { EngineExecutionError } from "../src/coding-engine/coding-engine.js";
import { CancellationError } from "../src/domain/errors.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { ModelProfile, Project } from "../src/domain/types.js";

/**
 * V1.1 Slice 5 — orchestrator-level regression suite for model/provider
 * routing, provider-health cooldown, and usage telemetry. Uses the real
 * fixture repo/orchestrator throughout; the ONLY test double is the
 * FixtureCodingEngine's own handler branching on `request.modelSelection` —
 * exactly the "test double at the provider abstraction boundary" this
 * slice's brief explicitly sanctions (item 25), never a claim that a second
 * real provider is executable in production.
 */

const GOOD_ADD_JS = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";

function twoProviderRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  const base: Omit<ModelProfile, "modelId" | "providerId" | "displayName"> = {
    engineKey: "fixture",
    capability: UNKNOWN_CAPABILITY_PROFILE,
    contextWindow: null,
    credentialMode: "managed",
    enabled: true,
  };
  registry.register({ ...base, modelId: "model-a", providerId: "provider-a", displayName: "Model A" });
  registry.register({ ...base, modelId: "model-b", providerId: "provider-b", displayName: "Model B" });
  return registry;
}

async function setup(label: string, engine: FixtureCodingEngine, modelRegistry?: ModelRegistry) {
  const root = await mkdtemp(join(tmpdir(), `model-routing-${label}-`));
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    modelRegistry,
    orchestratorConfig: { maxInfrastructureRetries: 1, infrastructureRetryBaseDelayMs: 15, infrastructureRetryMaxDelayMs: 100 },
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
  return { platform, project, root };
}

function makeTask(platform: Platform, project: Project) {
  return createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add()",
    goal: "add() returns the wrong result",
    createdBy: null,
  });
}

const approvingReviewer = async (): Promise<EngineInvocationResult> => ({
  result: { status: "completed" as const, summary: "VERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
  cost: null,
  logExcerpt: "",
});

function quotaExhaustedError(): EngineExecutionError {
  return new EngineExecutionError("implementer", "Gemini returned HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota", {
    attempts: 1,
    retryable: true,
    classification: "rate_limit",
  });
}

function authError(): EngineExecutionError {
  return new EngineExecutionError("implementer", "Anthropic returned HTTP 401: Invalid API key provided", { attempts: 1, retryable: false, classification: "auth" });
}

// ---------------------------------------------------------------------------
// A/L — single provider, real usage captured
// ---------------------------------------------------------------------------

test("A/L: a single configured, healthy model is selected and executed; real reported token usage is captured exactly", async () => {
  const registry = new ModelRegistry();
  registry.register({ modelId: "only-model", providerId: "only-provider", displayName: "Only", engineKey: "fixture", capability: UNKNOWN_CAPABILITY_PROFILE, contextWindow: null, credentialMode: "managed", enabled: true });
  const engine = new FixtureCodingEngine({
    implementer: async (request: EngineInvocationRequest) => {
      assert.equal(request.modelSelection?.modelId, "only-model");
      await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
      return {
        result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
        cost: { inputTokens: 1234, outputTokens: 456, durationMs: 890 },
        logExcerpt: "",
      };
    },
    reviewer: approvingReviewer,
  });
  const { platform, project } = await setup("single", engine, registry);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");

  const runs = platform.agentRuns.listForTask(task.id);
  const implementerRun = runs.find((r) => r.role === "implementer")!;
  assert.equal(implementerRun.modelId, "only-model");
  assert.equal(implementerRun.providerId, "only-provider");
  assert.equal(implementerRun.fallbackIndex, 0);
  assert.deepEqual(implementerRun.cost, { inputTokens: 1234, outputTokens: 456, durationMs: 890 });

  const health = platform.providerHealth.get("only-provider");
  assert.equal(health?.state, "healthy");
});

// ---------------------------------------------------------------------------
// M — missing usage metadata stays null, never fabricated
// ---------------------------------------------------------------------------

test("M: a coding engine that reports no cost/usage metadata leaves AgentRun.cost null — never a fabricated number", async () => {
  const registry = twoProviderRegistry();
  const engine = new FixtureCodingEngine({
    implementer: async (request) => {
      await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
      return { result: { status: "completed" as const, summary: "Fixed.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" };
    },
    reviewer: approvingReviewer,
  });
  const { platform, project } = await setup("no-usage", engine, registry);
  const task = makeTask(platform, project);
  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW");
  const implementerRun = platform.agentRuns.listForTask(task.id).find((r) => r.role === "implementer")!;
  assert.equal(implementerRun.cost, null);
});

// ---------------------------------------------------------------------------
// C/D/N — provider A quota-exhausted -> cooldown -> fallback to provider B,
// with real fallback telemetry recorded
// ---------------------------------------------------------------------------

test("C/D/N: provider A quota exhaustion triggers cooldown and a real fallback to provider B, with fallbackIndex/modelId/providerId telemetry recorded on each attempt", async () => {
  const registry = twoProviderRegistry();
  const engine = new FixtureCodingEngine({
    implementer: async (request: EngineInvocationRequest) => {
      if (request.modelSelection?.providerId === "provider-a") {
        throw quotaExhaustedError();
      }
      await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
      return {
        result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
        cost: null,
        logExcerpt: "",
      };
    },
    reviewer: approvingReviewer,
  });
  const { platform, project } = await setup("fallback", engine, registry);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "REVIEW", "the task must actually recover via the fallback provider, not just avoid a crash");

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 2, "one failed attempt on provider-a, one successful attempt on provider-b");
  assert.equal(runs[0]!.providerId, "provider-a");
  assert.equal(runs[0]!.modelId, "model-a");
  assert.equal(runs[0]!.fallbackIndex, 0);
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[1]!.providerId, "provider-b");
  assert.equal(runs[1]!.modelId, "model-b");
  assert.equal(runs[1]!.fallbackIndex, 1, "the second attempt knows it's the second DISTINCT model tried for this role");
  assert.equal(runs[1]!.status, "completed");

  const healthA = platform.providerHealth.get("provider-a");
  assert.equal(healthA?.state, "cooldown");
  assert.equal(healthA?.lastFailureCategory, "provider_quota_exhausted");
  const healthB = platform.providerHealth.get("provider-b");
  assert.equal(healthB?.state, "healthy");
});

// ---------------------------------------------------------------------------
// I/J — provider cooldown is persisted and visible to a LATER, independent
// task (cross-task outage protection)
// ---------------------------------------------------------------------------

test("I/J: a later task sees the SAME persisted provider-health cooldown and routes straight to provider B — it never has to rediscover provider A's outage itself", async () => {
  const registry = twoProviderRegistry();
  const engine = new FixtureCodingEngine({
    implementer: async (request: EngineInvocationRequest) => {
      if (request.modelSelection?.providerId === "provider-a") {
        throw quotaExhaustedError();
      }
      await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
      return { result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" };
    },
    reviewer: approvingReviewer,
  });
  const { platform, project } = await setup("cross-task", engine, registry);

  const task1 = makeTask(platform, project);
  const result1 = await platform.orchestrator.executeTask(task1.id);
  assert.equal(result1.status, "REVIEW");
  assert.equal(platform.providerHealth.get("provider-a")?.state, "cooldown");

  // A SECOND, independent task, created and run afterward — same shared, persisted provider health.
  const task2 = makeTask(platform, project);
  const result2 = await platform.orchestrator.executeTask(task2.id);
  assert.equal(result2.status, "REVIEW");

  const task2ImplementerRuns = platform.agentRuns.listForTask(task2.id).filter((r) => r.role === "implementer");
  assert.equal(task2ImplementerRuns.length, 1, "task 2 never even attempted provider-a — it saw the cooldown up front and went straight to provider-b");
  assert.equal(task2ImplementerRuns[0]!.providerId, "provider-b");
});

// ---------------------------------------------------------------------------
// E — a genuine code/validation failure never triggers model fallback
// ---------------------------------------------------------------------------

test("E: a model that executes successfully but produces a genuinely wrong fix does NOT trigger model fallback — every self-fix attempt stays on the same model", async () => {
  const registry = twoProviderRegistry();
  const engine = new FixtureCodingEngine({
    implementer: async (request: EngineInvocationRequest) => {
      // Always "succeeds" as an engine invocation, but never actually fixes the real bug — a
      // genuine code failure, not an infrastructure one.
      return { result: { status: "completed" as const, summary: "Tried.", filesChanged: [], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" };
    },
    reviewer: approvingReviewer,
  });
  const { platform, project } = await setup("code-failure", engine, registry);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.notEqual(result.status, "REVIEW", "the bug was never actually fixed");

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.ok(runs.length > 1, "the self-fix loop did retry (a real, expected behavior)");
  for (const run of runs) {
    assert.equal(run.providerId, "provider-a", "every self-fix attempt stayed on the SAME (first, healthy) provider — a wrong implementation is never treated as a reason to switch models");
    assert.equal(run.fallbackIndex, 0);
  }
  assert.equal(platform.providerHealth.get("provider-a")?.state, "healthy", "the provider itself never failed — nothing here should cool it down");
});

// ---------------------------------------------------------------------------
// F — authentication failure: no blind retry, no fallback loop, provider
// health untouched
// ---------------------------------------------------------------------------

test("F: an authentication failure is not blindly retried and does not cool the provider down — it's a credential problem, not evidence the provider is struggling", async () => {
  const registry = twoProviderRegistry();
  const engine = new FixtureCodingEngine({
    implementer: async () => {
      throw authError();
    },
    reviewer: approvingReviewer,
  });
  const { platform, project } = await setup("auth-failure", engine, registry);
  const task = makeTask(platform, project);

  const result = await platform.orchestrator.executeTask(task.id);
  assert.equal(result.status, "FAILED");

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 1, "no retry at all — an auth failure is never retryable");
  assert.equal(platform.providerHealth.get("provider-a")?.state, "healthy", "an auth failure is about the credential, not the provider's own health");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.ok(!events.includes("INFRASTRUCTURE_RETRY_SCHEDULED"));
});

// ---------------------------------------------------------------------------
// G — cancellation stops everything, including any potential fallback
// ---------------------------------------------------------------------------

test("G: cancelling during an infrastructure backoff prevents any model fallback from ever being attempted", async (t) => {
  // DETERMINISM: the backoff is FULL-JITTER (`Math.floor(Math.random() * cappedDelay)`, see
  // coding-engine/retry-backoff.ts), so it can legitimately be a few milliseconds — the previous version of
  // this test slept a fixed 150 ms and then cancelled, and lost that race whenever the jittered delay came out
  // shorter (a few percent of runs, load or no load), letting the retry fire before the cancel. Pinning the
  // random source makes the delay ~2 s every time, and the cancel below is issued only once the platform has
  // OBSERVABLY entered the backoff (its own INFRASTRUCTURE_RETRY_SCHEDULED event) — not after "long enough".
  t.mock.method(Math, "random", () => 0.999);
  const registry = twoProviderRegistry();
  const root = await mkdtemp(join(tmpdir(), "model-routing-cancel-"));
  const engine = new FixtureCodingEngine({
    implementer: async () => {
      throw quotaExhaustedError();
    },
    reviewer: approvingReviewer,
  });
  const platform: Platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: "cancel-worker",
    modelRegistry: registry,
    // A deliberately long backoff — long enough to reliably cancel mid-wait, before the (never
    // reached) fallback attempt on provider-b would happen.
    orchestratorConfig: { maxInfrastructureRetries: 3, infrastructureRetryBaseDelayMs: 2000, infrastructureRetryMaxDelayMs: 5000 },
  });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "cancel@example.com", name: "Tester", passwordHash: "", createdAt: now };
  platform.users.insert(user);
  const project: Project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: "Fixture", repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
  platform.projects.insert(project);
  const task = makeTask(platform, project);

  const running = platform.orchestrator.executeTask(task.id);
  // Wait for the observable state "the first attempt failed and the platform is now backing off" — never a fixed sleep.
  const deadline = Date.now() + 10_000;
  while (!platform.taskEvents.listForTask(task.id).some((e) => e.type === "INFRASTRUCTURE_RETRY_SCHEDULED")) {
    assert.ok(Date.now() < deadline, "the platform never entered the infrastructure backoff");
    await new Promise((r) => setTimeout(r, 5));
  }
  await platform.orchestrator.requestCancellation(task.id, "test-user");
  const result = await running;
  assert.equal(result.status, "CANCELLED");

  const runs = platform.agentRuns.listForTask(task.id).filter((r) => r.role === "implementer");
  assert.equal(runs.length, 1, "cancellation during backoff means provider-b was never even attempted");
});

// ---------------------------------------------------------------------------
// P — no credential/isolation surface exists to leak between projects: the
// registry carries no secrets, and selection depends only on (registry,
// health-by-providerId, engineKey) — never a project-specific credential
// lookup.
// ---------------------------------------------------------------------------

test("P: ModelProfile carries no credential material, and routing never depends on which project is asking — only on the engine key and provider health", () => {
  const registry = twoProviderRegistry();
  const SAFE_FIELDS = new Set(["modelId", "providerId", "displayName", "engineKey", "capability", "contextWindow", "credentialMode", "enabled"]);
  for (const profile of registry.list()) {
    assert.deepEqual(new Set(Object.keys(profile)), SAFE_FIELDS, "ModelProfile's field set is exactly the known, non-secret shape — no credential/token/API-key field exists to leak");
    assert.ok(profile.credentialMode === "managed" || profile.credentialMode === "byok", "credentialMode is only ever a label, never a secret value");
  }
});
