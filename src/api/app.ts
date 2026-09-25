import express, { type Express } from "express";
import type { Platform } from "../platform.js";
import { buildApplicationServices } from "../application/index.js";
import { attachUser, requireAuth } from "./auth.js";
import { errorMiddleware } from "./error-middleware.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { backlogRouter } from "./routes/backlog.js";
import { opsRouter } from "./routes/ops.js";
import { integrationsRouter } from "./routes/integrations.js";

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
export function buildApp(platform: Platform): Express {
  const services = buildApplicationServices(platform);

  const app = express();
  // Behind a reverse proxy (Caddy — see deploy/Caddyfile), req.ip is the proxy's address unless
  // Express is told to trust it; the login rate limiter keys on req.ip. Opt-in via TRUST_PROXY
  // (a hop count, e.g. "1"); unset preserves the previous behavior.
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));
  app.use(express.json({ limit: "1mb" }));
  app.use(attachUser(services.auth));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

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
  app.use(requireAuth, integrationsRouter(services));
  app.use(requireAuth, opsRouter(platform));

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorMiddleware);
  return app;
}
