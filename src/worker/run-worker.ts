import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildPlatformFromEnv } from "../env-platform.js";
import { Worker } from "./worker.js";
import { parsePositiveIntEnv } from "../config/startup-config.js";

/** Upper bound on graceful shutdown before forcing exit — see "shutdown" below. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

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
  const pollIntervalMs = parsePositiveIntEnv("POLL_INTERVAL_MS", process.env.POLL_INTERVAL_MS, 2000);
  // Bounded per-worker-process concurrency (see /docs/TASK_LIFECYCLE.md "Worker concurrency and
  // lease loss"). A small,
  // conservative default: unbounded dispatch (the pre-Concurrency-V1 behavior) let a single worker
  // process fan out every claimable TODO/WORKING task at once with no cap on live agent
  // invocations/child processes/workspace directories.
  const maxConcurrentTasks = parsePositiveIntEnv("WORKER_MAX_CONCURRENT_TASKS", process.env.WORKER_MAX_CONCURRENT_TASKS, 2);
  // How often a real GitHub call is allowed to happen for a single REVIEW task's PR — a SEPARATE,
  // different cadence from `pollIntervalMs` above (which still governs how often tick() itself runs
  // at all). See WorkerConfig.reviewPollIntervalMs's own doc comment, .env.example, and
  // /docs/TASK_LIFECYCLE.md "REVIEW polling".
  const reviewPollIntervalMs = parsePositiveIntEnv("REVIEW_POLL_INTERVAL_MS", process.env.REVIEW_POLL_INTERVAL_MS, 30_000);

  const worker = new Worker(
    platform.tasks,
    platform.orchestrator,
    { pollIntervalMs, maxConcurrentTasks, reviewPollIntervalMs },
    (taskId, err) => {
      console.error(`[worker] task ${taskId} raised an unexpected error outside the Orchestrator's own handling: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    },
    // Phase 4A.1 — backlog analysis is executed HERE (never in the API process), on this same loop.
    platform.backgroundRunner,
  );

  console.log(
    `[worker] starting, poll interval ${pollIntervalMs}ms, max concurrent tasks ${maxConcurrentTasks}, review poll interval ${reviewPollIntervalMs}ms, backlog analysis global cap ${platform.backlogOptions.maxAnalysisConcurrency}, db=${dbPath}`,
  );
  worker.start();

  // Developer Alpha: a hung worker used to be invisible (it only logged at startup and per task).
  // One line a minute with real counts makes "is the worker alive and seeing work" answerable from
  // journalctl alone. Counts are read-only aggregate queries — no task content, no secrets.
  const heartbeat = setInterval(() => {
    const rows = platform.db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE status IN ('TODO','WORKING','REVIEW') GROUP BY status").all() as unknown as Array<{ status: string; n: number }>;
    const c = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const a = platform.db.prepare("SELECT status, COUNT(*) AS n FROM backlog_analysis_jobs WHERE status IN ('QUEUED','RUNNING') GROUP BY status").all() as unknown as Array<{ status: string; n: number }>;
    const j = Object.fromEntries(a.map((r) => [r.status, r.n]));
    console.log(`[worker] heartbeat worker=${process.env.WORKER_ID ?? "(auto)"} todo=${c.TODO ?? 0} working=${c.WORKING ?? 0} review=${c.REVIEW ?? 0} analysis_queued=${j.QUEUED ?? 0} analysis_running=${j.RUNNING ?? 0}`);
  }, 60_000);
  heartbeat.unref();

  // `worker.stop()` deliberately does not cancel in-flight task execution —
  // it stops scheduling new ticks and waits for whatever's already running
  // to finish naturally (see Worker.stop's own doc comment). That's a
  // conscious choice, not an oversight: a task that's still genuinely
  // executing when SIGTERM arrives is exactly what the existing lease/crash
  // -recovery mechanism (TECHNICAL_DECISIONS.md TD-12, TASK_LIFECYCLE.md
  // "Crash recovery") already exists to handle safely if this process is
  // killed before it finishes — so shutdown here has a bounded grace period
  // rather than an unconditional wait: if it's not done by
  // SHUTDOWN_TIMEOUT_MS, force-exit and let recovery take it from there on
  // the next claim, instead of leaving an orchestrator (systemd/k8s/etc.)
  // waiting indefinitely on a hung process.
  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, finishing in-flight work before exit...`);
    const forceExit = setTimeout(() => {
      console.error(`[worker] graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit; any still-running task's lease will expire and be recovered normally`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    await worker.stop();
    clearTimeout(forceExit);
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
