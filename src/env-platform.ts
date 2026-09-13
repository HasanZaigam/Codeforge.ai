import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "./platform.js";
import { ClaudeCodeAdapter } from "./coding-engine/claude-code-adapter.js";
import { OpenCodeAdapter } from "./coding-engine/opencode-adapter.js";
import { createSelfFixDemoEngine } from "./cli/fixture-engine-handlers.js";
import type { CodingEngine } from "./coding-engine/coding-engine.js";
import { validateSharedConfig, parsePositiveIntEnv } from "./config/startup-config.js";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "./orchestrator/config.js";

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
  });
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
