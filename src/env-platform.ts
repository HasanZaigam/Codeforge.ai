import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "./platform.js";
import { ClaudeCodeAdapter } from "./coding-engine/claude-code-adapter.js";
import { OpenCodeAdapter } from "./coding-engine/opencode-adapter.js";
import { createSelfFixDemoEngine } from "./cli/fixture-engine-handlers.js";
import type { CodingEngine } from "./coding-engine/coding-engine.js";

/**
 * Shared environment-driven Platform construction for the standalone API
 * server and worker processes (src/api/server.ts, src/worker/run-worker.ts)
 * so both point at the same SQLite file and workspace root during local
 * development. See CLAUDE.md "Running this repo".
 */
export function buildPlatformFromEnv(ownerId?: string): Platform {
  const dbPath = process.env.DB_PATH ?? "./.data/platform.sqlite";
  const workspacesRoot = process.env.WORKSPACES_ROOT ?? "./.data/workspaces";
  const engine = resolveEngineFromEnv();

  return buildPlatform({
    dbPath,
    workspacesRoot,
    engine,
    ownerId: ownerId ?? process.env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
  });
}

function resolveEngineFromEnv(): CodingEngine {
  const key = (process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim();
  if (key === "fixture") {
    // Deterministic, no external CLI/credentials — see claude-code-adapter.ts's documented
    // boundary. Intended for local development/demo only, never set in a real deployment.
    return createSelfFixDemoEngine();
  }
  if (key === "claude-code" || key === "claude") {
    return new ClaudeCodeAdapter();
  }
  return new OpenCodeAdapter();
}
