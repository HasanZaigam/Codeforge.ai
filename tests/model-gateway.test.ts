import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { openDatabase } from "../src/persistence/db.js";
import { ProviderConnectionRepository } from "../src/persistence/repositories/provider-connection-repository.js";
import { GlobalAiConfigRepository } from "../src/persistence/repositories/global-ai-config-repository.js";
import { ProviderHealthRepository } from "../src/persistence/repositories/provider-health-repository.js";
import { AgentRunRepository } from "../src/persistence/repositories/agent-run-repository.js";
import { UserRepository } from "../src/persistence/repositories/user-repository.js";
import { ModelGatewayService } from "../src/application/model-gateway-service.js";
import type { ProviderAdapter, ProviderValidationResult } from "../src/providers/provider-adapter.js";
import { ModelRegistry, UNKNOWN_CAPABILITY_PROFILE } from "../src/routing/model-registry.js";
import { deriveHealthOnFailure } from "../src/routing/provider-health-policy.js";
import { InvalidRequestError, NotFoundError, ModelGatewayResolutionError } from "../src/application/errors.js";
import { loadEncryptionKey, encryptSecret } from "../src/auth/credential-encryption.js";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { FixtureCodingEngine } from "../src/coding-engine/fixture-coding-engine.js";
import type { EngineInvocationRequest, EngineInvocationResult } from "../src/coding-engine/coding-engine.js";
import type { Project } from "../src/domain/types.js";

// This test file writes `provider_connections` rows directly (bypassing the real network call
// `ModelGatewayService.connectProvider` would make) to exercise ORCHESTRATOR WIRING deterministically
// — those rows must be encrypted with the SAME key `platform.modelGateway` resolves via
// `loadEncryptionKey()` at decrypt time, so this is set once, process-wide, same convention as
// tests/github-integration.test.ts.
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/** A scripted adapter — never a real network call — so these tests are deterministic and need no live API key. */
class ScriptedAdapter implements ProviderAdapter {
  constructor(
    readonly id: "google" | "anthropic" | "openai",
    readonly envVar: string,
    private readonly result: ProviderValidationResult,
  ) {}
  async validateCredentials(): Promise<ProviderValidationResult> {
    return this.result;
  }
  async listModels(): Promise<{ models: string[]; error: string | null }> {
    return { models: [], error: this.result.error };
  }
}

function fixedKey(): Buffer {
  return Buffer.alloc(32, 7);
}

async function setupGatewayOnly(adapters?: Partial<Record<"google" | "anthropic" | "openai", ProviderAdapter>>) {
  const dir = await mkdtemp(join(tmpdir(), "model-gateway-test-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  const users = new UserRepository(db);
  const connections = new ProviderConnectionRepository(db);
  const configs = new GlobalAiConfigRepository(db);
  const providerHealth = new ProviderHealthRepository(db);
  const agentRuns = new AgentRunRepository(db);
  const gateway = new ModelGatewayService(connections, configs, providerHealth, agentRuns, fixedKey, adapters);
  const now = new Date().toISOString();
  const userId = randomUUID();
  users.insert({ id: userId, tenantId: "default", email: "u@example.com", name: "U", passwordHash: "", createdAt: now });
  return { gateway, connections, configs, providerHealth, userId };
}

describe("ModelGatewayService — provider connections", () => {
  test("connect() validates with a REAL adapter call before persisting; failure throws and never stores anything", async () => {
    const { gateway, userId, connections } = await setupGatewayOnly({ google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: false, error: "bad key" }) });
    await assert.rejects(() => gateway.connectProvider(userId, "google", "sk-bad", "gemini-2.0-flash"), InvalidRequestError);
    assert.equal(connections.findByUserAndProvider(userId, "google"), null);
  });

  test("connect() on success persists the connection and NEVER returns the raw key", async () => {
    const { gateway, userId } = await setupGatewayOnly({ google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }) });
    const dto = await gateway.connectProvider(userId, "google", "sk-real-secret-key", "gemini-2.0-flash");
    assert.equal(dto.connected, true);
    assert.equal(dto.model, "gemini-2.0-flash");
    assert.ok(!JSON.stringify(dto).includes("sk-real-secret-key"));
  });

  test("connect() stores the key ENCRYPTED — the raw plaintext never appears anywhere in the stored row", async () => {
    const { gateway, userId, connections } = await setupGatewayOnly({ anthropic: new ScriptedAdapter("anthropic", "ANTHROPIC_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "anthropic", "sk-ant-super-secret", "claude-sonnet-4-5");
    const record = connections.findByUserAndProvider(userId, "anthropic")!;
    assert.ok(!record.secret.ciphertext.includes("sk-ant-super-secret"));
    assert.ok(!JSON.stringify(record).includes("sk-ant-super-secret"));
  });

  test("listConnections() reports all three providers, masked, even when none are connected", async () => {
    const { gateway, userId } = await setupGatewayOnly();
    const list = gateway.listConnections(userId);
    assert.equal(list.length, 3);
    assert.ok(list.every((c) => !c.connected && c.status === "disconnected"));
  });

  test("testConnection() re-validates a REAL (scripted) call and updates status/lastError honestly", async () => {
    let behavior: ProviderValidationResult = { valid: true, error: null };
    const adapter: ProviderAdapter = {
      id: "openai",
      envVar: "OPENAI_API_KEY",
      validateCredentials: async () => behavior,
      listModels: async () => ({ models: [], error: null }),
    };
    const { gateway, userId } = await setupGatewayOnly({ openai: adapter });
    await gateway.connectProvider(userId, "openai", "sk-ok", "gpt-4.1");

    behavior = { valid: false, error: "key was revoked" };
    const result = await gateway.testConnection(userId, "openai");
    assert.equal(result.valid, false);
    const dto = gateway.listConnections(userId).find((c) => c.provider === "openai")!;
    assert.equal(dto.status, "error");
    assert.equal(dto.lastError, "key was revoked");
  });

  test("testConnection() on a never-connected provider throws NotFoundError", async () => {
    const { gateway, userId } = await setupGatewayOnly();
    await assert.rejects(() => gateway.testConnection(userId, "google"), NotFoundError);
  });

  test("disconnectProvider() really deletes the row — not just marks it inactive", async () => {
    const { gateway, userId, connections } = await setupGatewayOnly({ google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "google", "sk-ok", "gemini-2.0-flash");
    gateway.disconnectProvider(userId, "google");
    assert.equal(connections.findByUserAndProvider(userId, "google"), null);
  });

  test("listAvailableModels() returns a REAL, on-demand model list for this key — never persists anything, never a hardcoded catalog", async () => {
    const adapter: ProviderAdapter = {
      id: "google",
      envVar: "GEMINI_API_KEY",
      validateCredentials: async () => ({ valid: true, error: null }),
      listModels: async (apiKey: string) => ({ models: apiKey === "sk-good" ? ["gemini-2.0-flash", "gemini-2.0-pro"] : [], error: apiKey === "sk-good" ? null : "This API key was rejected by Google." }),
    };
    const { gateway, userId, connections } = await setupGatewayOnly({ google: adapter });

    const good = await gateway.listAvailableModels("google", "sk-good");
    assert.deepEqual(good.models, ["gemini-2.0-flash", "gemini-2.0-pro"]);
    assert.equal(good.error, null);

    const bad = await gateway.listAvailableModels("google", "sk-bad");
    assert.deepEqual(bad.models, []);
    assert.equal(bad.error, "This API key was rejected by Google.");

    // Listing models is a read against the provider's own API — it must never persist a connection.
    assert.equal(connections.findByUserAndProvider(userId, "google"), null);
  });
});

describe("ModelGatewayService — Global AI Brain configuration", () => {
  test("setGlobalConfig(fixed) rejects a provider that isn't connected yet — never silently accepted", async () => {
    const { gateway, userId } = await setupGatewayOnly();
    assert.throws(() => gateway.setGlobalConfig(userId, { mode: "fixed", fixedProvider: "anthropic" }), InvalidRequestError);
  });

  test("setGlobalConfig(auto) rejects an allowed-list containing an unconnected provider", async () => {
    const { gateway, userId } = await setupGatewayOnly({ google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "google", "sk-ok", "gemini-2.0-flash");
    assert.throws(() => gateway.setGlobalConfig(userId, { mode: "auto", autoAllowedProviders: ["google", "openai"] }), InvalidRequestError);
  });

  test("setGlobalConfig(fixed) on a connected provider persists and getGlobalConfig reflects it", async () => {
    const { gateway, userId } = await setupGatewayOnly({ anthropic: new ScriptedAdapter("anthropic", "ANTHROPIC_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "anthropic", "sk-ok", "claude-sonnet-4-5");
    const dto = gateway.setGlobalConfig(userId, { mode: "fixed", fixedProvider: "anthropic" });
    assert.equal(dto.mode, "fixed");
    assert.equal(dto.fixedProvider, "anthropic");
    assert.deepEqual(gateway.getGlobalConfig(userId), dto);
  });

  test("getGlobalConfig defaults to Auto with every connected provider allowed when nothing was ever set", async () => {
    const { gateway, userId } = await setupGatewayOnly({ google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "google", "sk-ok", "gemini-2.0-flash");
    const dto = gateway.getGlobalConfig(userId);
    assert.equal(dto.mode, "auto");
    assert.equal(dto.autoAllowed.find((a) => a.provider === "google")?.allowed, true);
  });
});

describe("ModelGatewayService — resolveModelSelection (the actual gateway)", () => {
  test("BACKWARD COMPATIBILITY: zero provider connections falls back EXACTLY to the legacy env-derived registry", async () => {
    const { gateway, userId, providerHealth } = await setupGatewayOnly();
    const legacy = new ModelRegistry();
    legacy.register({ modelId: "env-model", providerId: "env-provider", displayName: "env-model", engineKey: "opencode", capability: UNKNOWN_CAPABILITY_PROFILE, contextWindow: null, credentialMode: "managed", enabled: true });
    const { selection, credentialEnv, hadCandidates } = gateway.resolveModelSelection(userId, "opencode", "implementation", 0, new Date().toISOString(), legacy);
    assert.equal(selection?.modelId, "env-model");
    assert.equal(credentialEnv, null);
    assert.equal(hadCandidates, true);
    void providerHealth;
  });

  test("FIXED mode: resolves the exact connected provider/model and decrypts the real credential under its adapter's env var", async () => {
    const { gateway, userId } = await setupGatewayOnly({ anthropic: new ScriptedAdapter("anthropic", "ANTHROPIC_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "anthropic", "sk-ant-the-real-key", "claude-sonnet-4-5");
    gateway.setGlobalConfig(userId, { mode: "fixed", fixedProvider: "anthropic" });

    const { selection, credentialEnv } = gateway.resolveModelSelection(userId, "opencode", "implementation", 0, new Date().toISOString(), null);
    assert.equal(selection?.providerId, "anthropic");
    assert.equal(selection?.modelId, "anthropic/claude-sonnet-4-5");
    assert.deepEqual(credentialEnv, { ANTHROPIC_API_KEY: "sk-ant-the-real-key" });
  });

  test("FIXED mode: NEVER silently falls back when the fixed provider's connection is unavailable — throws an actionable error", async () => {
    const { gateway, userId } = await setupGatewayOnly({
      google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }),
      anthropic: new ScriptedAdapter("anthropic", "ANTHROPIC_API_KEY", { valid: true, error: null }),
    });
    await gateway.connectProvider(userId, "google", "sk-g", "gemini-2.0-flash");
    await gateway.connectProvider(userId, "anthropic", "sk-a", "claude-sonnet-4-5");
    gateway.setGlobalConfig(userId, { mode: "fixed", fixedProvider: "anthropic" });
    gateway.disconnectProvider(userId, "anthropic"); // connection goes away AFTER being set as fixed

    assert.throws(
      () => gateway.resolveModelSelection(userId, "opencode", "implementation", 0, new Date().toISOString(), null),
      (err: unknown) => err instanceof ModelGatewayResolutionError && /Anthropic.*global AI brain.*unavailable/s.test((err as Error).message),
    );
  });

  test("AUTO mode: skips a provider currently in cooldown and selects the next allowed, connected one", async () => {
    const { gateway, userId, providerHealth } = await setupGatewayOnly({
      google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }),
      anthropic: new ScriptedAdapter("anthropic", "ANTHROPIC_API_KEY", { valid: true, error: null }),
    });
    await gateway.connectProvider(userId, "google", "sk-g", "gemini-2.0-flash");
    await gateway.connectProvider(userId, "anthropic", "sk-a", "claude-sonnet-4-5");
    gateway.setGlobalConfig(userId, { mode: "auto", autoAllowedProviders: ["google", "anthropic"] });

    const now = new Date().toISOString();
    providerHealth.upsert(deriveHealthOnFailure("google", null, "rate_limited", 999_999, now, { defaultCooldownMs: 60_000, maxCooldownMs: 300_000 }));

    const { selection } = gateway.resolveModelSelection(userId, "opencode", "implementation", 0, now, null);
    assert.equal(selection?.providerId, "anthropic");
  });

  test("AUTO mode: a provider the account connected but did NOT allow for Auto is never selected", async () => {
    const { gateway, userId } = await setupGatewayOnly({
      google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }),
      openai: new ScriptedAdapter("openai", "OPENAI_API_KEY", { valid: true, error: null }),
    });
    await gateway.connectProvider(userId, "google", "sk-g", "gemini-2.0-flash");
    await gateway.connectProvider(userId, "openai", "sk-o", "gpt-4.1");
    gateway.setGlobalConfig(userId, { mode: "auto", autoAllowedProviders: ["google"] });

    const { selection } = gateway.resolveModelSelection(userId, "opencode", "implementation", 0, new Date().toISOString(), null);
    assert.equal(selection?.providerId, "google");
    assert.notEqual(selection?.providerId, "openai");
  });

  test("AUTO mode with no allowed/connected providers returns null (truthful 'nothing available'), never throws", async () => {
    const { gateway, userId } = await setupGatewayOnly({ google: new ScriptedAdapter("google", "GEMINI_API_KEY", { valid: true, error: null }) });
    await gateway.connectProvider(userId, "google", "sk-g", "gemini-2.0-flash");
    gateway.setGlobalConfig(userId, { mode: "auto", autoAllowedProviders: [] });
    const { selection } = gateway.resolveModelSelection(userId, "opencode", "implementation", 0, new Date().toISOString(), null);
    assert.equal(selection, null);
  });
});

describe("provider usage rollup — honesty rules (null, never a fabricated zero)", () => {
  test("sums reported token fields per provider, keeps null (not 0) when a provider reported nothing, and groups a null providerId under 'unknown'", async () => {
    const { buildProviderUsageRollup } = await import("../src/reporting/provider-usage-rollup.js");
    const rollup = buildProviderUsageRollup([
      { providerId: "anthropic", modelId: "claude-sonnet-4-5", cost: { inputTokens: 100, outputTokens: 50 } },
      { providerId: "anthropic", modelId: "claude-sonnet-4-5", cost: { inputTokens: 200, outputTokens: 80 } },
      { providerId: "google", modelId: "gemini-2.0-flash", cost: null },
      { providerId: null, modelId: null, cost: { inputTokens: 10 } },
    ]);
    const anthropic = rollup.find((r) => r.providerId === "anthropic")!;
    assert.equal(anthropic.inputTokens, 300);
    assert.equal(anthropic.outputTokens, 130);
    assert.equal(anthropic.totalTokens, 430);
    assert.equal(anthropic.runsWithUsage, 2);

    const google = rollup.find((r) => r.providerId === "google")!;
    assert.equal(google.inputTokens, null, "a provider with zero usage-reporting runs must show null, never a fabricated 0");
    assert.equal(google.runsWithUsage, 0);
    assert.equal(google.runsTotal, 1);

    const unknown = rollup.find((r) => r.providerId === "unknown")!;
    assert.equal(unknown.inputTokens, 10, "a run with no recorded providerId is grouped under 'unknown', never silently dropped");
  });
});

describe("Model Gateway — end-to-end orchestrator wiring", () => {
  const GOOD_ADD_JS = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";

  async function setupOrchestrator(label: string, engine: FixtureCodingEngine) {
    const root = await mkdtemp(join(tmpdir(), `model-gateway-e2e-${label}-`));
    const platform: Platform = buildPlatform({
      dbPath: join(root, "platform.sqlite"),
      workspacesRoot: join(root, "workspaces"),
      engine,
      ownerId: `test-worker-${label}`,
      orchestratorConfig: { maxInfrastructureRetries: 0 },
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
    return { platform, project, user };
  }

  const approvingReviewer = async (): Promise<EngineInvocationResult> => ({
    result: { status: "completed" as const, summary: "VERDICT: APPROVED", filesChanged: [], diffRef: null, confidence: "high" as const, findings: [], needsInput: null },
    cost: null,
    logExcerpt: "",
  });

  test("a FIXED global AI brain resolves through the Orchestrator for a REAL task execution, and the decrypted credential reaches the engine", async () => {
    let capturedCredentialEnv: Record<string, string> | null | undefined;
    const engine = new FixtureCodingEngine({
      implementer: async (request: EngineInvocationRequest) => {
        capturedCredentialEnv = request.credentialEnv;
        assert.equal(request.modelSelection?.providerId, "anthropic");
        await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
        return { result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" };
      },
      reviewer: approvingReviewer,
    });
    // FixtureCodingEngine's key is "fixture" — the gateway needs to register the connection under THIS engine.
    const { platform, project, user } = await setupOrchestrator("fixed", engine);
    // Written directly to the repository (never through `connectProvider`, which would make a REAL
    // network call to Anthropic) — this test exercises ORCHESTRATOR WIRING end-to-end, not
    // provider-adapter validation (already covered deterministically, via a scripted adapter, above).
    platform.providerConnections.upsert({
      id: randomUUID(),
      userId: user.id,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      secret: encryptSecret("sk-ant-real", loadEncryptionKey()),
      status: "connected",
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    platform.globalAiConfig.upsert({ userId: user.id, mode: "fixed", fixedProvider: "anthropic", fixedModel: "claude-sonnet-4-5", autoAllowedProviders: null, updatedAt: new Date().toISOString() });

    const task = createReadyTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Fix add()", goal: "add() returns the wrong result", createdBy: null });
    const result = await platform.orchestrator.executeTask(task.id);
    assert.equal(result.status, "REVIEW");

    const runs = platform.agentRuns.listForTask(task.id);
    const implementerRun = runs.find((r) => r.role === "implementer")!;
    assert.equal(implementerRun.providerId, "anthropic");
    assert.equal(implementerRun.modelId, "anthropic/claude-sonnet-4-5");
  });

  test("a FIXED global AI brain naming a disconnected provider fails the task with an actionable error — never silently runs on a different model", async () => {
    const engine = new FixtureCodingEngine({
      implementer: async () => {
        throw new Error("must never be invoked — resolution should fail before any engine call");
      },
      reviewer: approvingReviewer,
    });
    const { platform, project, user } = await setupOrchestrator("fixed-unavailable", engine);
    platform.globalAiConfig.upsert({ userId: user.id, mode: "fixed", fixedProvider: "anthropic", fixedModel: "claude-sonnet-4-5", autoAllowedProviders: null, updatedAt: new Date().toISOString() });
    // A connection row exists for a DIFFERENT provider only, so "anthropic" resolves as connected=false.
    platform.providerConnections.upsert({
      id: randomUUID(),
      userId: user.id,
      provider: "google",
      model: "gemini-2.0-flash",
      secret: encryptSecret("sk-g", loadEncryptionKey()),
      status: "connected",
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const task = createReadyTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Fix add()", goal: "add() returns the wrong result", createdBy: null });
    const result = await platform.orchestrator.executeTask(task.id);
    assert.equal(result.status, "FAILED");
    const events = platform.taskEvents.listForTask(task.id);
    const failedEvent = events.find((e) => e.type === "TASK_FAILED")!;
    assert.match((failedEvent.payload as { error: string }).error, /Anthropic.*global AI brain.*unavailable/is);
    assert.equal(platform.agentRuns.listForTask(task.id).length, 0, "no AgentRun should be created when resolution fails before the engine is ever invoked");
  });

  test("BACKWARD COMPATIBILITY: an account with zero provider connections behaves EXACTLY as before this feature existed (the legacy env-registry path)", async () => {
    const legacyRegistry = new ModelRegistry();
    legacyRegistry.register({ modelId: "legacy-model", providerId: "legacy-provider", displayName: "legacy-model", engineKey: "fixture", capability: UNKNOWN_CAPABILITY_PROFILE, contextWindow: null, credentialMode: "managed", enabled: true });
    const engine = new FixtureCodingEngine({
      implementer: async (request: EngineInvocationRequest) => {
        assert.equal(request.modelSelection?.modelId, "legacy-model");
        assert.equal(request.credentialEnv, null);
        await writeFile(join(request.workspacePath, "add.js"), GOOD_ADD_JS);
        return { result: { status: "completed" as const, summary: "Fixed it.", filesChanged: ["add.js"], diffRef: null, confidence: "high" as const, findings: [], needsInput: null }, cost: null, logExcerpt: "" };
      },
      reviewer: approvingReviewer,
    });
    const root = await mkdtemp(join(tmpdir(), "model-gateway-e2e-legacy-"));
    const platform: Platform = buildPlatform({ dbPath: join(root, "platform.sqlite"), workspacesRoot: join(root, "workspaces"), engine, ownerId: "test-worker-legacy", modelRegistry: legacyRegistry, orchestratorConfig: { maxInfrastructureRetries: 0 } });
    const repoPath = await createFixtureRepo(root);
    const now = new Date().toISOString();
    const user = { id: randomUUID(), tenantId: "default", email: "legacy@example.com", name: "Tester", passwordHash: "", createdAt: now };
    platform.users.insert(user);
    const project: Project = { id: randomUUID(), tenantId: "default", ownerId: user.id, name: "Fixture", repoUrl: repoPath, defaultBranch: "main", codingEngine: engine.key, sourceControlProvider: "local-git", owner: null, repo: null, commands: { test: "node test.js" }, createdAt: now, updatedAt: now };
    platform.projects.insert(project);

    const task = createReadyTask(platform.tasks, platform.taskEvents, { tenantId: "default", projectId: project.id, title: "Fix add()", goal: "add() returns the wrong result", createdBy: null });
    const result = await platform.orchestrator.executeTask(task.id);
    assert.equal(result.status, "REVIEW");
  });
});
