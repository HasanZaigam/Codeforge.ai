import { Router } from "express";
import type { Platform } from "../../platform.js";
import { asyncHandler } from "../async-handler.js";

/**
 * Developer Alpha — minimal operational status (docs/INTERNAL_ALPHA.md "Operations"). Mounted behind
 * requireAuth and scoped to the CALLER's own projects/tasks (same isolation rule as every other
 * project/task route — a developer never sees another developer's task counts). Provider health is
 * platform-wide by nature (it is how workers coordinate) but carries no secrets: provider ids,
 * states, timestamps and a failure category only.
 */
export function opsRouter(platform: Platform): Router {
  const router = Router();

  router.get(
    "/ops/summary",
    asyncHandler(async (req, res) => {
      const ownerId = req.user!.id;
      const nowIso = new Date().toISOString();
      const byStatus = platform.db
        .prepare(
          `SELECT t.status AS status, COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
           WHERE p.owner_id = ? GROUP BY t.status`,
        )
        .all(ownerId) as unknown as Array<{ status: string; n: number }>;
      const eventCount = (type: string, sinceIso: string) =>
        (
          platform.db
            .prepare(
              `SELECT COUNT(*) AS n FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
               WHERE p.owner_id = ? AND e.type = ? AND e.created_at >= ?`,
            )
            .get(ownerId, type, sinceIso) as { n: number }
        ).n;
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const activeLeases = (
        platform.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
             WHERE p.owner_id = ? AND t.status = 'WORKING' AND t.lock_expires_at IS NOT NULL AND t.lock_expires_at > ?`,
          )
          .get(ownerId, nowIso) as { n: number }
      ).n;
      const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
      res.json({
        generatedAt: nowIso,
        tasks: {
          byStatus: counts,
          queued: counts.TODO ?? 0,
          active: counts.WORKING ?? 0,
          /** WORKING tasks whose execution lease has lapsed — a worker likely died; the next worker tick recovers them. */
          workingWithExpiredLease: (counts.WORKING ?? 0) - activeLeases,
          failed: counts.FAILED ?? 0,
        },
        last24h: {
          tasksFailed: eventCount("TASK_FAILED", since24h),
          infrastructureFailures: eventCount("INFRASTRUCTURE_FAILURE_DETECTED", since24h),
          infrastructureRetries: eventCount("INFRASTRUCTURE_RETRY_SCHEDULED", since24h),
          leaseLosses: eventCount("EXECUTION_LEASE_LOST", since24h),
        },
        providers: platform.providerHealth.list().map((h) => ({
          providerId: h.providerId,
          state: h.state,
          consecutiveFailures: h.consecutiveFailures,
          lastFailureCategory: h.lastFailureCategory,
          cooldownUntil: h.cooldownUntil,
        })),
      });
    }),
  );

  return router;
}
