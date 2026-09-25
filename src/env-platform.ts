import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "./platform.js";
import { ClaudeCodeAdapter } from "./coding-engine/claude-code-adapter.js";
import { OpenCodeAdapter } from "./coding-engine/opencode-adapter.js";
import { createSelfFixDemoEngine } from "./cli/fixture-engine-handlers.js";
import type { CodingEngine } from "./coding-engine/coding-engine.js";
import { validateSharedConfig, parsePositiveIntEnv } from "./config/startup-config.js";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "./orchestrator/config.js";
import { ModelRegistry, UNKNOWN_CAPABILITY_PROFILE, inferProviderId } from "./routing/model-registry.js";
import { DEFAULT_MAX_ANALYSIS_CONCURRENCY } from "./worker/backlog-analysis-runner.js";

/**
 * Shared environment-driven Platform construction for the standalone API
 * server and worker processes (src/api/server.ts, src/worker/run-worker.ts)
 * so both point at the same SQLite file and workspace root during local
 * development. See CLAUDE.md "Running this repo".
 */
export function buildPlatformFromEnv(ownerId?: string): Platform {
  validateSharedConfig(process.env);
  const dbPath = process.env.DB_PATH ?? "./.data/platform.sqlite";
  const workspacesRoot = process.env.WORKSPACES_ROOT ?? "./.data/workspaces";
  // Deliberately separate from workspacesRoot (the existing, unrelated per-task execution
  // Workspace) — see project-workspace/project-workspace-fs-manager.ts's own doc comment.
  const projectWorkspacesRoot = process.env.PROJECT_WORKSPACE_ROOT ?? "./.data/project-workspaces";
  const engine = resolveEngineFromEnv();

  return buildPlatform({
    dbPath,
    workspacesRoot,
    projectWorkspacesRoot,
    engine,
    ownerId: ownerId ?? process.env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
    orchestratorConfig: resolveOrchestratorConfigFromEnv(),
    modelRegistry: buildModelRegistryFromEnv(engine.key),
    backlogOptions: { maxAnalysisConcurrency: resolveBacklogAnalysisConcurrency(process.env) },
  });
}

/**
 * `MAX_BACKLOG_ANALYSIS_CONCURRENCY` — the GLOBAL cap on concurrently running backlog analyses
 * across every worker process sharing the database (see docs/BACKLOG_INTELLIGENCE.md "Global
 * concurrency cap"). Validated at startup (by validateSharedConfig too), with a safe default.
 */
function resolveBacklogAnalysisConcurrency(env: NodeJS.ProcessEnv): number {
  const value = parsePositiveIntEnv("MAX_BACKLOG_ANALYSIS_CONCURRENCY", env.MAX_BACKLOG_ANALYSIS_CONCURRENCY, DEFAULT_MAX_ANALYSIS_CONCURRENCY);
  console.log(`[config] backlog analysis global concurrency cap=${value}`);
  return value;
}

/**
 * V1.1 Slice 5 — the ONLY model profile production wiring ever registers:
 * whatever `OPENCODE_MODEL` actually names, for the engine this process
 * actually resolved (see resolveEngineFromEnv). Deliberately does not
 * pre-populate profiles for models/providers this environment cannot
 * actually execute (see this slice's brief, item 25) — when `OPENCODE_MODEL`
 * is unset, the registry stays empty and the platform routes nothing,
 * exactly preserving pre-Slice-5 behavior (the coding engine uses its own
 * construction-time default — see OpenCodeAdapter's own `this.model`
 * fallback).
 */
function buildModelRegistryFromEnv(engineKey: string): ModelRegistry {
  const registry = new ModelRegistry();
  const modelId = process.env.OPENCODE_MODEL?.trim();
  if (engineKey === "opencode" && modelId) {
    registry.register({
      modelId,
      providerId: inferProviderId(modelId),
      displayName: modelId,
      engineKey,
      capability: UNKNOWN_CAPABILITY_PROFILE,
      contextWindow: null,
      credentialMode: "managed",
      enabled: true,
    });
  }
  return registry;
}

/**
 * TASK_LEASE_MS / LEASE_HEARTBEAT_MS: optional overrides of DEFAULT_ORCHESTRATOR_CONFIG's
 * taskLeaseMs/leaseHeartbeatIntervalMs (see orchestrator/config.ts for what each controls).
 * Undocumented/unset by default — production deployments should leave these at their defaults;
 * they exist so a local dev/test environment can shorten lease expiry to exercise crash-recovery
 * behavior manually in realistic wall-clock time, without touching any code. Only the two fields a
 * manual tester would actually want to shorten together are exposed here — every other
 * OrchestratorConfig field stays code-only, unchanged from DEFAULT_ORCHESTRATOR_CONFIG.
 */
function resolveOrchestratorConfigFromEnv(): Partial<OrchestratorConfig> {
  const overrides: Partial<OrchestratorConfig> = {};
  if (process.env.TASK_LEASE_MS !== undefined) {
    overrides.taskLeaseMs = parsePositiveIntEnv("TASK_LEASE_MS", process.env.TASK_LEASE_MS, 5 * 60 * 1000);
  }
  if (process.env.LEASE_HEARTBEAT_MS !== undefined) {
    overrides.leaseHeartbeatIntervalMs = parsePositiveIntEnv("LEASE_HEARTBEAT_MS", process.env.LEASE_HEARTBEAT_MS, 60 * 1000);
  }
  // Unlike TASK_LEASE_MS/LEASE_HEARTBEAT_MS above (manual-testing-only overrides, left at their
  // code defaults in real deployments), REVIEW_POLL_INTERVAL_MS is a real, always-applicable
  // production knob (see docs/DEPLOYMENT.md and .env.example) — always resolved, with its own
  // documented default, not merely overridden when set. See GITHUB_INTEGRATION.md "REVIEW polling".
  overrides.reviewPollIntervalMs = parsePositiveIntEnv(
    "REVIEW_POLL_INTERVAL_MS",
    process.env.REVIEW_POLL_INTERVAL_MS,
    DEFAULT_ORCHESTRATOR_CONFIG.reviewPollIntervalMs,
  );
  console.log(`[config] review poll interval=${overrides.reviewPollIntervalMs}ms`);

  // V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028) — real, always-applicable production knobs
  // for infrastructure-failure retry, same treatment as REVIEW_POLL_INTERVAL_MS above (always
  // resolved with its own documented default, not merely a manual-testing override).
  overrides.maxInfrastructureRetries = parsePositiveIntEnv(
    "INFRA_MAX_EPISODE_RETRIES",
    process.env.INFRA_MAX_EPISODE_RETRIES,
    DEFAULT_ORCHESTRATOR_CONFIG.maxInfrastructureRetries,
  );
  overrides.maxInfraCheckRetries = parsePositiveIntEnv(
    "INFRA_MAX_CHECK_RETRIES",
    process.env.INFRA_MAX_CHECK_RETRIES,
    DEFAULT_ORCHESTRATOR_CONFIG.maxInfraCheckRetries,
  );
  overrides.infrastructureRetryBaseDelayMs = parsePositiveIntEnv(
    "INFRA_RETRY_BASE_DELAY_MS",
    process.env.INFRA_RETRY_BASE_DELAY_MS,
    DEFAULT_ORCHESTRATOR_CONFIG.infrastructureRetryBaseDelayMs,
  );
  overrides.infrastructureRetryMaxDelayMs = parsePositiveIntEnv(
    "INFRA_RETRY_MAX_DELAY_MS",
    process.env.INFRA_RETRY_MAX_DELAY_MS,
    DEFAULT_ORCHESTRATOR_CONFIG.infrastructureRetryMaxDelayMs,
  );
  console.log(
    `[config] infrastructure retry: episode max=${overrides.maxInfrastructureRetries} check max=${overrides.maxInfraCheckRetries} backoff=${overrides.infrastructureRetryBaseDelayMs}-${overrides.infrastructureRetryMaxDelayMs}ms`,
  );
  return overrides;
}

function resolveEngineFromEnv(): CodingEngine {
  const key = (process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim();
  if (key === "fixture") {
    // Deterministic, no external CLI/credentials — see claude-code-adapter.ts's documented
    // boundary. Intended for local development/demo only, never set in a real deployment.
    console.log("[config] coding engine=fixture (deterministic, no live model)");
    return createSelfFixDemoEngine();
  }
  if (key === "claude-code" || key === "claude") {
    console.log("[config] coding engine=claude-code");
    return new ClaudeCodeAdapter();
  }
  // Startup-visible, secret-free: shows exactly which model every task invocation will request —
  // see /docs/CODING_ENGINE.md "Configuration" for why this exists (a wrong/stale model, e.g. an
  // unset OPENCODE_MODEL silently falling back to opencode's own default, was previously only
  // discoverable by reading a live task's failure output).
  const model = process.env.OPENCODE_MODEL?.trim();
  console.log(`[config] coding engine=opencode model=${model || "(unset — opencode's own default, see OPENCODE_MODEL)"}`);
  return new OpenCodeAdapter();
}
