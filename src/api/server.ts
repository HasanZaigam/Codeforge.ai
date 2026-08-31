import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildPlatformFromEnv } from "../env-platform.js";
import { buildApp } from "./app.js";

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
  const port = Number(process.env.PORT ?? 3000);

  const server = app.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port} (db=${dbPath})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[api] received ${signal}, shutting down...`);
    server.close(() => {
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
