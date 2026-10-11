import express, { type Express } from "express";
import type { Platform } from "../platform.js";
import { buildApplicationServices } from "../application/index.js";
import { attachUser, requireAuth } from "./auth.js";
import { errorMiddleware } from "./error-middleware.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { backlogRouter } from "./routes/backlog.js";
import { backlogBulkRouter } from "./routes/backlog-bulk.js";
import { backlogAdjudicationRouter } from "./routes/backlog-adjudication.js";
import { chatRouter } from "./routes/chat.js";
import { chatAttachmentsRouter } from "./routes/chat-attachments.js";
import { opsRouter } from "./routes/ops.js";
import { integrationsRouter } from "./routes/integrations.js";
import { aiModelRouter } from "./routes/ai-model.js";
import { modelGatewayRouter } from "./routes/model-gateway.js";

import fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { parsePositiveIntEnv } from "../config/startup-config.js";

export interface RuntimeMetadata {
  status: "ok";
  service: string;
  environment: string;
  pid: number;
  startedAt: string;
  gitSha: string | null;
  runtimeSourceFingerprint: string;
  port: number | null;
  codingEngine: {
    engine: string;
    model: string | null;
  };
}

export function getGitSha(): string | null {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.trim().slice(0, 7);
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA.trim().slice(0, 7);
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export function getRuntimeSourceFingerprint(): string {
  try {
    const csvImporterPath = join(process.cwd(), "src", "backlog", "import-csv.ts");
    const content = fs.readFileSync(csvImporterPath, "utf8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

/**
 * Builds the Express app. This is the ONLY place the Web UI (or any HTTP
 * client) is allowed to reach the platform through — it talks to
 * application services, never to repositories, the Orchestrator's internals,
 * workspaces, git, or the coding engine directly. See /docs/ARCHITECTURE.md
 * and /docs/API.md.
 *
 * Route groups (see /docs/AUTHENTICATION.md):
 *  - `/health` — public, no session info, no request-time database access
 *    (liveness: "is the process up"). `/health/ready` is the readiness
 *    counterpart — it does touch the database (see below) to answer "can
 *    this process actually serve traffic," per /docs/DEPLOYMENT.md.
 *  - `/auth/*` — public (nothing to authenticate against yet for
 *    register/login); logout/me require a session but 401 cleanly rather
 *    than needing the router-level guard below.
 *  - `/projects/*`, `/tasks/*`, `/backlog/*`, `/task-proposals/*`, `/integrations/*` — every route requires a
 *    valid session (`requireAuth`), enforced here at the router-mount level,
 *    not per-handler — a new route added to any of these routers is
 *    protected by default, not by remembering to add a check.
 */
export function buildApp(platform: Platform, runtimeOverrides?: Partial<RuntimeMetadata>): Express {
  const services = buildApplicationServices(platform);

  const app = express();
  // Behind a reverse proxy (Caddy — see deploy/Caddyfile), req.ip is the proxy's address unless
  // Express is told to trust it; the login rate limiter keys on req.ip. Opt-in via TRUST_PROXY
  // (a hop count, e.g. "1"); unset preserves the previous behavior.
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));
  app.use(express.json({ limit: "1mb" }));
  app.use(attachUser(services.auth));

  const startedAt = runtimeOverrides?.startedAt ?? new Date().toISOString();
  const gitSha = runtimeOverrides?.gitSha !== undefined ? runtimeOverrides.gitSha : getGitSha();
  const runtimeSourceFingerprint = runtimeOverrides?.runtimeSourceFingerprint ?? getRuntimeSourceFingerprint();
  const metadata: RuntimeMetadata = {
    status: "ok",
    service: "codeforge-api",
    environment: process.env.NODE_ENV ?? "development",
    pid: runtimeOverrides?.pid ?? process.pid,
    startedAt,
    gitSha,
    runtimeSourceFingerprint,
    port: runtimeOverrides?.port ?? parsePositiveIntEnv("PORT", process.env.PORT, 3000),
    codingEngine: {
      engine: (process.env.CODING_ENGINE ?? "opencode").toLowerCase().trim(),
      model: process.env.OPENCODE_MODEL?.trim() || null,
    },
    ...runtimeOverrides,
  };

  app.use((_req, res, next) => {
    res.setHeader("x-codeforge-pid", String(metadata.pid));
    res.setHeader("x-codeforge-git-sha", metadata.gitSha ?? "none");
    res.setHeader("x-codeforge-fingerprint", metadata.runtimeSourceFingerprint);
    res.setHeader("x-codeforge-started-at", metadata.startedAt);
    next();
  });

  app.get("/health", (_req, res) => res.json(metadata));

  // Readiness: a cheap, synchronous round-trip to the database (node:sqlite
  // is synchronous — this is not an async query, just a single indexed-free
  // read). Distinct from /health on purpose: a load balancer/orchestrator
  // should stop routing traffic here if the DB is unreachable, but that's a
  // different signal from "should this process be restarted," which is all
  // /health answers. Never includes the db path or any internal detail in
  // the response — only ok/not-ok.
  app.get("/health/ready", (_req, res) => {
    try {
      platform.db.prepare("SELECT 1").get();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });

  app.use(authRouter(services.auth));
  app.use(requireAuth, projectsRouter(services, platform.taskEvents, platform.taskDependencies));
  app.use(requireAuth, tasksRouter(services, platform.taskEvents, platform.taskDependencies));
  app.use(requireAuth, backlogRouter(services, platform.taskEvents, platform.taskDependencies));
  app.use(requireAuth, backlogBulkRouter(services));
  app.use(requireAuth, backlogAdjudicationRouter(services));
  app.use(requireAuth, chatRouter(services));
  app.use(requireAuth, chatAttachmentsRouter());
  app.use(requireAuth, integrationsRouter(services));
  app.use(requireAuth, aiModelRouter(platform));
  app.use(requireAuth, modelGatewayRouter(services));
  app.use(requireAuth, opsRouter(platform));

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorMiddleware);
  return app;
}
