import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import http from "node:http";
import { setDefaultResultOrder } from "node:dns";
import { buildPlatformFromEnv } from "../env-platform.js";
import { buildApp, getGitSha, getRuntimeSourceFingerprint } from "./app.js";
import { parsePositiveIntEnv } from "../config/startup-config.js";

// Model Gateway provider adapters (src/providers/provider-adapter.ts) make real outbound `fetch`
// calls to Google/Anthropic/OpenAI. Node's `fetch` (undici) can attempt an IPv6 route first and
// fail outright on a network where IPv6 is advertised but not actually routed — surfacing as a bare
// "fetch failed" even though the SAME host is reachable over IPv4 (e.g. via `curl`, which orders
// differently). Forcing IPv4-first DNS resolution, same as Node's own documented fix for this class
// of flake, applies to every outbound fetch this process makes — not a provider-specific workaround.
setDefaultResultOrder("ipv4first");

/** Upper bound on graceful shutdown before forcing exit — see "shutdown" below. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function checkPortOccupiedByCodeForge(port: number): Promise<{ occupied: boolean; isCodeForge: boolean }> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json && (json.service === "codeforge-api" || json.status === "ok")) {
            return resolve({ occupied: true, isCodeForge: true });
          }
        } catch {
          // Response wasn't JSON or from another service
        }
        return resolve({ occupied: true, isCodeForge: false });
      });
    });
    req.on("error", () => resolve({ occupied: false, isCodeForge: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ occupied: true, isCodeForge: false });
    });
  });
}

/**
 * Standalone API process entrypoint (`npm run api`). Never executes tasks
 * itself — see src/worker/run-worker.ts, which must be run alongside it for
 * tasks to actually progress past TODO. See CLAUDE.md "Running this repo".
 */
async function main() {
  const dbPath = process.env.DB_PATH ?? "./.data/platform.sqlite";
  await mkdir(dirname(dbPath), { recursive: true });

  const port = parsePositiveIntEnv("PORT", process.env.PORT, 3000);

  // Duplicate process detection pre-flight check
  const portProbe = await checkPortOccupiedByCodeForge(port);
  if (portProbe.isCodeForge) {
    console.error(`[api] ERROR: CodeForge API cannot start on port ${port}.`);
    console.error(`[api] Another CodeForge process appears to already be using this port.`);
    console.error(`[api] Stop the existing CodeForge API process or choose another port.`);
    process.exit(1);
  }

  const pid = process.pid;
  const startedAt = new Date().toISOString();
  const gitSha = getGitSha();

  const platform = buildPlatformFromEnv("api-process");
  const app = buildApp(platform, { pid, startedAt, gitSha, port });

  const server = app.listen(port);

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[api] ERROR: CodeForge API cannot start on port ${port}.`);
      console.error(`[api] Another process is already using port ${port}.`);
      console.error(`[api] Stop the existing process or set PORT to a different number.`);
      process.exit(1);
    } else {
      console.error("[api] fatal server error:", err);
      process.exit(1);
    }
  });

  server.on("listening", () => {
    const appMeta = buildApp(platform, { pid, startedAt, gitSha, port });
    void appMeta;
    const fingerprint = getRuntimeSourceFingerprint();
    console.log(`[api] CodeForge API starting`);
    console.log(`[api] pid=${pid}`);
    console.log(`[api] port=${port}`);
    console.log(`[api] gitSha=${gitSha ?? "null"}`);
    console.log(`[api] runtimeSourceFingerprint=${fingerprint}`);
    console.log(`[api] startedAt=${startedAt}`);
    console.log(`[api] listening on http://localhost:${port} (db=${dbPath})`);
  });

  // Bounded request lifetimes (Node's defaults are effectively unbounded for a slow client).
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;

  // Expired sessions were only ever filtered at lookup and never deleted, so the table grew
  // forever. Purge once at startup and hourly — cheap single DELETE.
  const purgeExpiredSessions = () => platform.sessions.deleteExpired(new Date().toISOString());
  purgeExpiredSessions();
  const purgeTimer = setInterval(purgeExpiredSessions, 60 * 60 * 1000);
  purgeTimer.unref();

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

const isMain = process.argv[1] ? process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js") : false;
if (isMain) {
  main().catch((err) => {
    console.error("[api] fatal startup error:", err);
    process.exitCode = 1;
  });
}
