import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { AdjudicationImportSchema, AdjudicationSampleQuerySchema, CreateBaselineSchema, ItemJudgmentSchema, RelationshipJudgmentSchema } from "../schemas.js";
import { InvalidRequestError } from "../../application/errors.js";
import { asyncHandler } from "../async-handler.js";

/**
 * Phase 4B.1 — human ground-truth adjudication routes (see /docs/API.md "Adjudication"). Owner-only; every judgment body is
 * `{ label, note? }` (or `{ category, label, note? }` for items) — never an analysisId or revision, so a client cannot bind
 * a judgment onto an analysis/revision it never reviewed (the server always uses whatever is CURRENT).
 */
export function backlogAdjudicationRouter(services: ApplicationServices): Router {
  const router = Router();
  const adj = services.adjudication;

  const sampleQuery = (req: { query: unknown }) => {
    const parsed = AdjudicationSampleQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new InvalidRequestError("seed (1-100 chars) and size (1-500) are required", parsed.error.flatten());
    return parsed.data;
  };

  router.get(
    "/projects/:projectId/backlog/adjudication/sample/duplicates",
    asyncHandler(async (req, res) => {
      const { seed, size, runId } = sampleQuery(req);
      res.json(adj.sampleDuplicateGroups(req.params.projectId!, req.user!.id, seed, size, runId));
    }),
  );

  router.get(
    "/projects/:projectId/backlog/adjudication/sample/clarification",
    asyncHandler(async (req, res) => {
      const { seed, size, runId } = sampleQuery(req);
      res.json(adj.sampleClarification(req.params.projectId!, req.user!.id, seed, size, runId));
    }),
  );

  router.get(
    "/projects/:projectId/backlog/adjudication/sample/proposal-ready",
    asyncHandler(async (req, res) => {
      const { seed, size, runId } = sampleQuery(req);
      res.json(adj.sampleProposalReady(req.params.projectId!, req.user!.id, seed, size, runId));
    }),
  );

  router.post(
    "/backlog/relationships/:relationshipId/judgments",
    asyncHandler(async (req, res) => {
      const b = RelationshipJudgmentSchema.parse(req.body);
      res.status(201).json({ judgment: adj.judgeRelationship(req.params.relationshipId!, req.user!.id, b.label, b.note) });
    }),
  );

  router.get(
    "/backlog/relationships/:relationshipId/judgments",
    asyncHandler(async (req, res) => {
      res.json({ judgments: adj.listRelationshipJudgments(req.params.relationshipId!, req.user!.id) });
    }),
  );

  router.post(
    "/backlog/items/:itemId/judgments",
    asyncHandler(async (req, res) => {
      const b = ItemJudgmentSchema.parse(req.body);
      res.status(201).json({ judgment: adj.judgeItem(req.params.itemId!, req.user!.id, b.category, b.label, b.note) });
    }),
  );

  router.get(
    "/backlog/items/:itemId/judgments",
    asyncHandler(async (req, res) => {
      const category = req.query.category === "PROPOSAL_READINESS" ? "PROPOSAL_READINESS" : "CLARIFICATION";
      res.json({ judgments: adj.listItemJudgments(req.params.itemId!, req.user!.id, category) });
    }),
  );

  router.get(
    "/projects/:projectId/backlog/adjudication/label-counts",
    asyncHandler(async (req, res) => {
      res.json(adj.labelCounts(req.params.projectId!, req.user!.id));
    }),
  );

  router.get(
    "/projects/:projectId/backlog/adjudication/metrics",
    asyncHandler(async (req, res) => {
      res.json(adj.metrics(req.params.projectId!, req.user!.id));
    }),
  );

  router.post(
    "/projects/:projectId/backlog/adjudication/import",
    asyncHandler(async (req, res) => {
      const b = AdjudicationImportSchema.parse(req.body);
      res.status(200).json(adj.importCsv(req.params.projectId!, req.user!.id, b.csv));
    }),
  );

  router.post(
    "/projects/:projectId/backlog/adjudication/baselines",
    asyncHandler(async (req, res) => {
      const b = CreateBaselineSchema.parse(req.body);
      res.status(201).json({ baseline: adj.createBaseline(req.params.projectId!, req.user!.id, b) });
    }),
  );

  router.get(
    "/projects/:projectId/backlog/adjudication/baselines",
    asyncHandler(async (req, res) => {
      res.json({ baselines: adj.listBaselines(req.params.projectId!, req.user!.id) });
    }),
  );

  router.get(
    "/backlog/adjudication/baselines/:baselineId",
    asyncHandler(async (req, res) => {
      res.json({ baseline: adj.getBaseline(req.params.baselineId!, req.user!.id) });
    }),
  );

  router.get(
    "/projects/:projectId/backlog/adjudication/export",
    asyncHandler(async (req, res) => {
      const csv = adj.exportCsv(req.params.projectId!, req.user!.id);
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="adjudication-${req.params.projectId}.csv"`);
      res.send(csv);
    }),
  );

  return router;
}
