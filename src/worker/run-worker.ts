import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildPlatformFromEnv } from "../env-platform.js";
import { Worker } from "./worker.js";

/**
 * Standalone worker process entrypoint (`npm run worker`). Deliberately
 * separate from the API server (src/api/server.ts) — the HTTP process must
 * never be responsible for long-running agent execution. See
 * /docs/ARCHITECTURE.md and TECHNICAL_DECISIONS.md TD-16.
 */
async function main() {
  const dbPath = process.env.DB_PATH ?? "./.data/platform.sqlite";
  await mkdir(dirname(dbPath), { recursive: true });

  const platform = buildPlatformFromEnv();
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs }, (taskId, err) => {
    console.error(`[worker] task ${taskId} raised an unexpected error outside the Orchestrator's own handling:`, err);
  });

  console.log(`[worker] starting, poll interval ${pollIntervalMs}ms, db=${dbPath}`);
  worker.start();

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, finishing in-flight work before exit...`);
    await worker.stop();
    platform.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal startup error:", err);
  process.exitCode = 1;
});
