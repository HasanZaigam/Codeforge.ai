import { Router } from "express";
import type { Platform } from "../../platform.js";
import { asyncHandler } from "../async-handler.js";

/**
 * Settings → AI / Models (Phase 4C). Read-only and deliberately narrow: this platform's ModelRegistry
 * (routing/model-registry.ts) is populated from exactly one operator-configured model per deployment
 * (see env-platform.ts's buildModelRegistryFromEnv) — there is no per-user model selection or
 * multi-provider BYOK execution path today. Reporting anything richer than "here is the one model
 * this deployment can actually run" would be exactly the "do not invent fake provider support" this
 * endpoint's own product brief warns against, so it reports the real registry state as-is.
 */
export function aiModelRouter(platform: Platform): Router {
  const router = Router();

  router.get(
    "/settings/ai-model",
    asyncHandler(async (_req, res) => {
      const profiles = platform.modelRegistry.list().filter((p) => p.enabled);
      res.json({
        configured: profiles.length > 0,
        models: profiles.map((p) => ({ modelId: p.modelId, providerId: p.providerId, engineKey: p.engineKey })),
        // "Auto" is not a routing CHOICE here — every request (Chat and backlog analysis alike) already
        // always uses whichever configured model routing selects; this field exists so the UI can say so
        // truthfully rather than implying a user-facing model picker that doesn't exist yet.
        autoDescription:
          profiles.length > 0
            ? "CodeForge runs every chat message and analysis on this platform's configured model — there's no per-user model choice yet."
            : "No model is currently configured for this deployment.",
      });
    }),
  );

  return router;
}
