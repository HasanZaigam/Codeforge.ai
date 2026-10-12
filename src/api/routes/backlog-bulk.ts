import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { REVIEW_FILTERS, type ReviewFilter } from "../../application/backlog-bulk-service.js";
import { BulkActionSchema, EmptyActionBodySchema, ImportBodySchema, ReviewRelationshipSchema, StartBulkAnalysisSchema } from "../schemas.js";
import { InvalidRequestError } from "../../application/errors.js";
import { asyncHandler } from "../async-handler.js";

/**
 * Phase 4B — bulk backlog routes (see /docs/API.md "Bulk backlog"). Mounted behind requireAuth; every handler delegates to
 * BacklogBulkService, which enforces project ownership (404 for anyone else) — nothing here writes state. Deliberately absent:
 * any endpoint that starts a task, schedules work or merges anything.
 */
export function backlogBulkRouter(services: ApplicationServices): Router {
  const router = Router();
  const bulk = services.bulk;

  router.post(
    "/projects/:projectId/backlog/imports/preview",
    asyncHandler(async (req, res) => {
      const b = ImportBodySchema.parse(req.body);
      res.json({ preview: bulk.preview(req.params.projectId!, b.csv, { sourceName: b.sourceName, mapping: b.mapping }, req.user!.id) });
    }),
  );

  router.post(
    "/projects/:projectId/backlog/imports",
    asyncHandler(async (req, res) => {
      const b = ImportBodySchema.parse(req.body);
      res.status(201).json(bulk.confirmImport(req.params.projectId!, b.csv, { sourceName: b.sourceName, mapping: b.mapping, repositoryId: b.repositoryId }, req.user!.id));
    }),
  );

  router.get(
    "/projects/:projectId/backlog/imports",
    asyncHandler(async (req, res) => {
      res.json({ imports: bulk.listImports(req.params.projectId!, req.user!.id) });
    }),
  );

  router.get(
    "/backlog/imports/:importId",
    asyncHandler(async (req, res) => {
      res.json(bulk.getImport(req.params.importId!, req.user!.id));
    }),
  );

  // 202: only ENQUEUES the existing per-item analysis jobs; the worker runs them under the existing global cap.
  router.post(
    "/projects/:projectId/backlog/bulk-analysis",
    asyncHandler(async (req, res) => {
      const b = StartBulkAnalysisSchema.parse(req.body);
      const out = bulk.startAnalysis(req.params.projectId!, { importId: b.importId, itemIds: b.itemIds }, req.user!.id);
      res.status(202).json(out);
    }),
  );

  router.get(
    "/projects/:projectId/backlog/bulk-analysis",
    asyncHandler(async (req, res) => {
      res.json({ bulkAnalyses: bulk.listBulk(req.params.projectId!, req.user!.id) });
    }),
  );

  router.get(
    "/backlog/bulk-analysis/:bulkId",
    asyncHandler(async (req, res) => {
      res.json({ bulk: bulk.getBulk(req.params.bulkId!, req.user!.id) });
    }),
  );

  router.post(
    "/backlog/bulk-analysis/:bulkId/cancel",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      res.status(202).json({ bulk: bulk.cancelBulk(req.params.bulkId!, req.user!.id) });
    }),
  );

  router.get(
    "/projects/:projectId/backlog/review",
    asyncHandler(async (req, res) => {
      const filter = (typeof req.query.filter === "string" ? req.query.filter : "all") as ReviewFilter;
      if (!REVIEW_FILTERS.includes(filter)) throw new InvalidRequestError(`filter must be one of ${REVIEW_FILTERS.join(", ")}`);
      const importId = typeof req.query.importId === "string" ? req.query.importId : undefined;
      const out = bulk.reviewRows(req.params.projectId!, { filter, importId }, req.user!.id);
      res.json({ ...out, usage: bulk.usageAggregate(out.rows) });
    }),
  );

  router.get(
    "/projects/:projectId/backlog/groups",
    asyncHandler(async (req, res) => {
      res.json(bulk.groups(req.params.projectId!, req.user!.id));
    }),
  );

  router.post(
    "/backlog/relationships/:relationshipId/review",
    asyncHandler(async (req, res) => {
      const b = ReviewRelationshipSchema.parse(req.body);
      res.json({ relationship: bulk.reviewRelationship(req.params.relationshipId!, b.decision, req.user!.id) });
    }),
  );

  router.post(
    "/projects/:projectId/backlog/actions",
    asyncHandler(async (req, res) => {
      const b = BulkActionSchema.parse(req.body);
      res.json(await bulk.bulkAction(req.params.projectId!, { action: b.action, itemIds: b.itemIds }, req.user!.id));
    }),
  );

  return router;
}
