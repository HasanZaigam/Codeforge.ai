import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";
import type { TaskDependencyRepository } from "../../persistence/repositories/task-dependency-repository.js";
import { CreateBacklogItemSchema, EmptyActionBodySchema, UpdateBacklogItemSchema } from "../schemas.js";
import { toTaskDTO } from "../dto.js";
import {
  toBacklogAnalysisDTO,
  toBacklogAnalysisJobDTO,
  toClaimVerificationJobDTO,
  toBacklogItemDetailDTO,
  toBacklogItemDTO,
  toBacklogItemSummaryDTO,
  toBacklogRelationshipDTO,
  toTaskProposalDTO,
} from "../backlog-dto.js";
import { asyncHandler } from "../async-handler.js";
import { dependenciesFor, latestEventFor } from "./task-helpers.js";

/**
 * Phase 4A — Backlog Intelligence routes (see /docs/API.md "Backlog"). Mounted behind requireAuth
 * (see app.ts) like every other router, so a new route here is authenticated by default. Every
 * handler delegates to BacklogService, which performs the project-ownership check (404, never 403, for
 * "exists but not yours") and owns every status transition — nothing here writes state, and no
 * request body can carry any (see the `.strict()` schemas).
 *
 * Deliberately absent: any endpoint that starts, schedules, or releases a Task. Converting a proposal
 * produces an ordinary BACKLOG Task; POST /tasks/:taskId/start remains the only way to run it.
 */
export function backlogRouter(services: ApplicationServices, taskEvents: TaskEventRepository, taskDependencies: TaskDependencyRepository): Router {
  const router = Router();
  const backlog = services.backlog;

  router.get(
    "/projects/:projectId/backlog",
    asyncHandler(async (req, res) => {
      const items = backlog.listItems(req.params.projectId!, req.user!.id);
      res.json({ items: items.map(toBacklogItemSummaryDTO) });
    }),
  );

  router.post(
    "/projects/:projectId/backlog",
    asyncHandler(async (req, res) => {
      const input = CreateBacklogItemSchema.parse(req.body);
      const item = backlog.createItem(req.params.projectId!, input, req.user!.id);
      res.status(201).json({ item: toBacklogItemDTO(item) });
    }),
  );

  router.get(
    "/backlog/:itemId",
    asyncHandler(async (req, res) => {
      res.json({ ...toBacklogItemDetailDTO(backlog.getItem(req.params.itemId!, req.user!.id)), verificationJobs: services.claimVerifier.list(req.params.itemId!, req.user!.id).map(toClaimVerificationJobDTO) });
    }),
  );

  router.patch(
    "/backlog/:itemId",
    asyncHandler(async (req, res) => {
      const input = UpdateBacklogItemSchema.parse(req.body);
      const item = backlog.updateItem(req.params.itemId!, input, req.user!.id);
      res.json({ item: toBacklogItemDTO(item) });
    }),
  );

  router.post(
    "/backlog/:itemId/reject",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      res.json({ item: toBacklogItemDTO(backlog.rejectItem(req.params.itemId!, req.user!.id)) });
    }),
  );

  // 202: this only ENQUEUES a job — no model is called in the API process. A worker claims and runs it;
  // poll GET /backlog/:itemId (item.status + analysisJob). Idempotent: while a job is already
  // QUEUED/RUNNING the SAME job is returned (`enqueued: false`) and no new one is created.
  router.post(
    "/backlog/:itemId/analyze",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      const { item, job, enqueued } = backlog.requestAnalysis(req.params.itemId!, req.user!.id);
      res.status(202).json({ item: toBacklogItemDTO(item), job: toBacklogAnalysisJobDTO(job), enqueued });
    }),
  );

  // Cancels the live analysis: a QUEUED job at once, a RUNNING one at the owning worker's next heartbeat.
  router.post(
    "/backlog/:itemId/analysis/cancel",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      const { item, job } = backlog.cancelAnalysis(req.params.itemId!, req.user!.id);
      res.status(202).json({ item: toBacklogItemDTO(item), job: toBacklogAnalysisJobDTO(job) });
    }),
  );

  // 202: this only ENQUEUES worker jobs that run the project's own APPROVED check(s) bound to this analysis's behaviour claims at
  // its exact revision — nothing runs in the API process. Idempotent per (analysis, claim, check). `jobs: []` + `note` when no
  // approved check is bound (behaviour stays unverified). A model can neither trigger nor shape this.
  router.post(
    "/backlog/:itemId/verifications",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      const out = services.claimVerifier.request(req.params.itemId!, req.user!.id);
      res.status(202).json({ jobs: out.jobs.map(toClaimVerificationJobDTO), enqueued: out.enqueued, revision: out.revision, note: out.note });
    }),
  );

  router.get(
    "/backlog/:itemId/verifications",
    asyncHandler(async (req, res) => {
      res.json({ jobs: services.claimVerifier.list(req.params.itemId!, req.user!.id).map(toClaimVerificationJobDTO) });
    }),
  );

  router.post(
    "/backlog/:itemId/verifications/:jobId/cancel",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      res.status(202).json({ job: toClaimVerificationJobDTO(services.claimVerifier.cancel(req.params.itemId!, req.params.jobId!, req.user!.id)) });
    }),
  );

  router.get(
    "/backlog/:itemId/analysis",
    asyncHandler(async (req, res) => {
      const analysis = backlog.getLatestAnalysis(req.params.itemId!, req.user!.id);
      res.json({ analysis: analysis ? toBacklogAnalysisDTO(analysis) : null });
    }),
  );

  router.get(
    "/backlog/:itemId/relationships",
    asyncHandler(async (req, res) => {
      const relationships = backlog.getRelationships(req.params.itemId!, req.user!.id);
      res.json({ relationships: relationships.map(toBacklogRelationshipDTO) });
    }),
  );

  // Builds the proposal deterministically from the latest successful analysis. Idempotent: 201 when
  // newly created, 200 with the existing live proposal otherwise. Never approves or executes anything.
  router.post(
    "/backlog/:itemId/proposal",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      const { proposal, created } = backlog.generateProposal(req.params.itemId!, req.user!.id);
      res.status(created ? 201 : 200).json({ proposal: toTaskProposalDTO(proposal), created });
    }),
  );

  router.get(
    "/task-proposals/:proposalId",
    asyncHandler(async (req, res) => {
      res.json({ proposal: toTaskProposalDTO(backlog.getProposal(req.params.proposalId!, req.user!.id)) });
    }),
  );

  router.post(
    "/task-proposals/:proposalId/approve",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      res.json({ proposal: toTaskProposalDTO(backlog.approveProposal(req.params.proposalId!, req.user!.id)) });
    }),
  );

  router.post(
    "/task-proposals/:proposalId/reject",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      res.json({ proposal: toTaskProposalDTO(backlog.rejectProposal(req.params.proposalId!, req.user!.id)) });
    }),
  );

  // Converts an APPROVED proposal into exactly one ordinary Task via TaskService.create (the task
  // lands in BACKLOG). 201 when this call created it, 200 when it had already been converted.
  router.post(
    "/task-proposals/:proposalId/convert",
    asyncHandler(async (req, res) => {
      EmptyActionBodySchema.parse(req.body ?? {});
      const { proposal, task, alreadyConverted } = await backlog.convertProposal(req.params.proposalId!, req.user!.id);
      res.status(alreadyConverted ? 200 : 201).json({
        proposal: toTaskProposalDTO(proposal),
        task: toTaskDTO(task, latestEventFor(taskEvents, task.id), dependenciesFor(taskDependencies, task.id)),
        alreadyConverted,
      });
    }),
  );

  return router;
}
