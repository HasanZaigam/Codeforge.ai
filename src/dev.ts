import { spawn, type ChildProcess } from "node:child_process";

/**
 * `npm run dev` — runs the API and worker as two child processes sharing
 * the same environment (so they point at the same DB_PATH/WORKSPACES_ROOT),
 * for local development convenience only. Production deployment runs them
 * as genuinely separate processes/services — see /docs/ARCHITECTURE.md and
 * TECHNICAL_DECISIONS.md TD-16 on why the API never executes tasks itself.
 * No process manager dependency is introduced; this is a thin convenience
 * wrapper, not a substitute for real orchestration in production.
 */
const children: ChildProcess[] = [];

function spawnProcess(label: string, entry: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    console.log(`[dev] ${label} exited with code ${code}`);
    shutdown();
  });
  return child;
}

function shutdown(): void {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(0);
}

children.push(spawnProcess("api", "src/api/server.ts"));
children.push(spawnProcess("worker", "src/worker/run-worker.ts"));

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
