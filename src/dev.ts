import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * `npm run dev` — runs the API and worker as two watched child processes sharing
 * the same environment (so they point at the same DB_PATH/WORKSPACES_ROOT),
 * for local development convenience only. Backend source changes under `src/`
 * automatically restart the API/worker process so the dev server never executes
 * stale code. Production deployment runs them as genuinely separate processes/services —
 * see /docs/ARCHITECTURE.md and TECHNICAL_DECISIONS.md TD-16.
 */
const children: ChildProcess[] = [];
let isShuttingDown = false;

const tsxCliPath = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

function spawnWatchedProcess(label: string, entry: string): ChildProcess {
  const child = spawn(process.execPath, [tsxCliPath, "watch", "--clear-screen=false", entry], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (!isShuttingDown) {
      console.log(`[dev] ${label} process exited unexpectedly (code ${code}, signal ${signal})`);
      shutdown();
    }
  });
  return child;
}

function shutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("[dev] shutting down development processes...");
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(0);
  }, 5000).unref();
}

console.log("[dev] starting API and worker with auto-reload watcher (tsx watch)");
children.push(spawnWatchedProcess("api", "src/api/server.ts"));
children.push(spawnWatchedProcess("worker", "src/worker/run-worker.ts"));

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
