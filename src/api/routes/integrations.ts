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

  // On-demand, real GitHub API call — see GitHubIntegrationService.verifyConnection's own doc
  // comment for why GET /integrations/github above deliberately never does this itself. A stale
  // credential this uncovers is never auto-repaired or disconnected here — the user decides what
  // to do next (add a new token, or leave it), same posture as every other read in this router.
  router.post(
    "/integrations/github/verify",
    asyncHandler(async (req, res) => {
      const result = await services.github.verifyConnection(req.user!.id);
      res.json(result);
    }),
  );

  return router;
}
