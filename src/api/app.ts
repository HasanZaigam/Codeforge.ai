import express, { type Express } from "express";
import type { Platform } from "../platform.js";
import { buildApplicationServices } from "../application/index.js";
import { attachUser, requireAuth } from "./auth.js";
import { errorMiddleware } from "./error-middleware.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { integrationsRouter } from "./routes/integrations.js";

/**
 * Builds the Express app. This is the ONLY place the Web UI (or any HTTP
 * client) is allowed to reach the platform through — it talks to
 * application services, never to repositories, the Orchestrator's internals,
 * workspaces, git, or the coding engine directly. See /docs/ARCHITECTURE.md
 * and /docs/API.md.
 *
 * Route groups (see /docs/AUTHENTICATION.md):
 *  - `/health` — public, no session info, no request-time database access.
 *  - `/auth/*` — public (nothing to authenticate against yet for
 *    register/login); logout/me require a session but 401 cleanly rather
 *    than needing the router-level guard below.
 *  - `/projects/*`, `/tasks/*`, `/integrations/*` — every route requires a
 *    valid session (`requireAuth`), enforced here at the router-mount level,
 *    not per-handler — a new route added to any of these routers is
 *    protected by default, not by remembering to add a check.
 */
export function buildApp(platform: Platform): Express {
  const services = buildApplicationServices(platform);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(attachUser(services.auth));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use(authRouter(services.auth));
  app.use(requireAuth, projectsRouter(services, platform.taskEvents));
  app.use(requireAuth, tasksRouter(services, platform.taskEvents));
  app.use(requireAuth, integrationsRouter(services));

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorMiddleware);
  return app;
}
