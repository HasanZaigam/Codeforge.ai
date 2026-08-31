import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { ConnectGitHubSchema } from "../schemas.js";
import { asyncHandler } from "../async-handler.js";
import type { GitHubConnectionDTO } from "../dto.js";

/**
 * GitHub *account* connection — separate from connecting a repository to a
 * Project (see routes/projects.ts and /docs/GITHUB_INTEGRATION.md "Platform
 * auth vs. GitHub authorization"). Mounted behind requireAuth (see app.ts) —
 * every handler here can assume req.user is set. The token itself is never
 * echoed back in any response.
 */
export function integrationsRouter(services: ApplicationServices): Router {
  const router = Router();

  router.get(
    "/integrations/github",
    asyncHandler(async (req, res) => {
      const status: GitHubConnectionDTO = services.github.getStatus(req.user!.id);
      res.json(status);
    }),
  );

  router.post(
    "/integrations/github",
    asyncHandler(async (req, res) => {
      const input = ConnectGitHubSchema.parse(req.body);
      const status: GitHubConnectionDTO = await services.github.connect(req.user!.id, input.token);
      res.status(200).json(status);
    }),
  );

  router.delete(
    "/integrations/github",
    asyncHandler(async (req, res) => {
      services.github.disconnect(req.user!.id);
      res.status(204).end();
    }),
  );

  return router;
}
