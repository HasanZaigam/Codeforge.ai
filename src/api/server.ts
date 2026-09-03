import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildPlatformFromEnv } from "../env-platform.js";
import { buildApp } from "./app.js";
import { parsePositiveIntEnv } from "../config/startup-config.js";

/** Upper bound on graceful shutdown before forcing exit — see "shutdown" below. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Standalone API process entrypoint (`npm run api`). Never executes tasks
 * itself — see src/worker/run-worker.ts, which must be run alongside it for
 * tasks to actually progress past TODO. See CLAUDE.md "Running this repo".
 */
async function main() {
  const dbPath = process.env.DB_PATH ?? "./.data/platform.sqlite";
  await mkdir(dirname(dbPath), { recursive: true });

  const platform = buildPlatformFromEnv("api-process");
  const app = buildApp(platform);
  const port = parsePositiveIntEnv("PORT", process.env.PORT, 3000);

  const server = app.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port} (db=${dbPath})`);
  });

  // `server.close()` stops accepting new connections and waits for in-flight
  // requests to finish, then this closes the DB and exits — but nothing
  // bounds how long an in-flight request can take. This process holds no
  // task-execution state (TD-16 — only the worker does), so there's nothing
  // here that legitimately needs more than a few seconds; if shutdown
  // hasn't completed by SHUTDOWN_TIMEOUT_MS, force-exit rather than leave
  // an orchestrator (systemd/k8s/etc.) waiting on a hung process.
  const shutdown = (signal: string) => {
    console.log(`[api] received ${signal}, shutting down...`);
    const forceExit = setTimeout(() => {
      console.error(`[api] graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(forceExit);
      platform.db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api] fatal startup error:", err);
  process.exitCode = 1;
});
