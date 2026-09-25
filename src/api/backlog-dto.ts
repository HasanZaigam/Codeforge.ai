import type {
  AnalysisContextSummary,
  AnalysisFailureCategory,
  AnalysisJobStatus,
  AnalysisResult,
  AnalysisStatus,
  BacklogEvent,
  BacklogEventType,
  BacklogItem,
  BacklogItemStatus,
  BacklogRelationshipKind,
  BacklogRelationshipStatus,
  BacklogSource,
  BacklogAnalysis,
  BacklogAnalysisJob,
  ConfidenceLevel,
  PlatformChecks,
  TaskProposal,
  TaskProposalContent,
  TaskProposalStatus,
} from "../backlog/backlog-types.js";
import type { CostMetadata, EstimatedCost } from "../domain/types.js";
import type { BacklogItemDetail, BacklogItemSummary, RelationshipView } from "../application/backlog-service.js";

/**
 * Phase 4A read models. Same rule as dto.ts: the web UI depends only on these, never on a raw row
 * (no `createdBy` id leak, no analysis claim/lease columns, no reserved task id). See /docs/API.md
 * "Backlog".
 */

export interface BacklogItemDTO {
  id: string;
  projectId: string;
  externalRef: string | null;
  title: string;
  description: string;
  source: BacklogSource;
  status: BacklogItemStatus;
  createdAt: string;
  updatedAt: string;
}

export function toBacklogItemDTO(item: BacklogItem): BacklogItemDTO {
  return {
    id: item.id,
    projectId: item.projectId,
    externalRef: item.externalRef,
    title: item.title,
    description: item.description,
    source: item.source,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export interface BacklogItemSummaryDTO extends BacklogItemDTO {
  latestAnalysis: { id: string; status: AnalysisStatus; completedAt: string } | null;
  proposal: { id: string; status: TaskProposalStatus; taskId: string | null } | null;
}

export function toBacklogItemSummaryDTO(summary: BacklogItemSummary): BacklogItemSummaryDTO {
  return { ...toBacklogItemDTO(summary.item), latestAnalysis: summary.latestAnalysis, proposal: summary.proposal };
}

/**
 * An analysis JOB — the asynchronous unit of work behind "Analyze" (executed by a worker). The UI
 * polls this to show queued / running / retry-scheduled / finished. No claim owner, lease or lock
 * generation is exposed.
 */
export interface BacklogAnalysisJobDTO {
  id: string;
  status: AnalysisJobStatus;
  attemptCount: number;
  maxAttempts: number;
  /** For a QUEUED job: the earliest time a worker will pick it up. In the future ⇒ a retry backoff is in progress. */
  availableAt: string;
  /** True once a cancel was requested for a RUNNING job (the worker stops at its next heartbeat). */
  cancelRequested: boolean;
  /** Most recent failure — the cause of a scheduled retry, or of the terminal failure. */
  failureCategory: AnalysisFailureCategory | null;
  failureReason: string | null;
  modelId: string | null;
  providerId: string | null;
  /** The result row, once terminal. */
  analysisId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function toBacklogAnalysisJobDTO(j: BacklogAnalysisJob): BacklogAnalysisJobDTO {
  return {
    id: j.id,
    status: j.status,
    attemptCount: j.attemptCount,
    maxAttempts: j.maxAttempts,
    availableAt: j.availableAt,
    cancelRequested: j.cancelRequestedAt !== null,
    failureCategory: j.failureCategory,
    failureReason: j.failureReason,
    modelId: j.modelId,
    providerId: j.providerId,
    analysisId: j.analysisId,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
  };
}

export interface BacklogAnalysisDTO {
  id: string;
  backlogItemId: string;
  status: AnalysisStatus;
  failureCategory: AnalysisFailureCategory | null;
  failureReason: string | null;
  /** The model's validated PROPOSAL. Claims, not facts — see `platformChecks` for what the platform itself verified. */
  result: AnalysisResult | null;
  platformChecks: PlatformChecks | null;
  /** Bounded, redacted diagnostics of a failed analysis (e.g. a malformed-output excerpt). */
  diagnostics: Record<string, unknown> | null;
  modelId: string | null;
  providerId: string | null;
  engineKey: string | null;
  fallbackIndex: number;
  routingReason: string | null;
  /**
   * Raw usage the engine/provider REPORTED for the model call — each field `null` when it was not
   * reported (never `0` for "unknown"); the whole object `null` when nothing was reported at all.
   * Provider-agnostic: the adapter normalizes its own format before it gets here.
   */
  usage: BacklogAnalysisUsageDTO | null;
  /** A monetary estimate, SEPARATE from usage — present only when the engine supplied one (see EstimatedCost); `null` otherwise. Never `0` for "unknown". */
  estimatedCost: EstimatedCost | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface BacklogAnalysisUsageDTO {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** Splits stored cost metadata into reported usage and the (separate) estimated cost. */
export function toUsageDTO(cost: CostMetadata | null): { usage: BacklogAnalysisUsageDTO | null; estimatedCost: EstimatedCost | null } {
  if (!cost) return { usage: null, estimatedCost: null };
  const n = (v: number | undefined): number | null => (typeof v === "number" ? v : null);
  const usage = {
    inputTokens: n(cost.inputTokens),
    outputTokens: n(cost.outputTokens),
    reasoningTokens: n(cost.reasoningTokens),
    cacheReadTokens: n(cost.cacheReadTokens),
    cacheWriteTokens: n(cost.cacheWriteTokens),
  };
  const anyUsage = Object.values(usage).some((v) => v !== null);
  return { usage: anyUsage ? usage : null, estimatedCost: cost.estimatedCost ?? null };
}

export function toBacklogAnalysisDTO(a: BacklogAnalysis): BacklogAnalysisDTO {
  return {
    id: a.id,
    backlogItemId: a.backlogItemId,
    status: a.status,
    failureCategory: a.failureCategory,
    failureReason: a.failureReason,
    result: a.result,
    platformChecks: a.platformChecks,
    diagnostics: a.diagnostics,
    modelId: a.modelId,
    providerId: a.providerId,
    engineKey: a.engineKey,
    fallbackIndex: a.fallbackIndex,
    routingReason: a.routingReason,
    ...toUsageDTO(a.cost),
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    durationMs: a.durationMs,
  };
}

export interface BacklogRelationshipDTO {
  id: string;
  kind: BacklogRelationshipKind;
  status: BacklogRelationshipStatus;
  direction: "outgoing" | "incoming";
  confidence: ConfidenceLevel;
  rationale: string;
  other: { id: string; ref: string | null; title: string; status: BacklogItemStatus };
  createdAt: string;
}

export function toBacklogRelationshipDTO(view: RelationshipView): BacklogRelationshipDTO {
  const r = view.relationship;
  return { id: r.id, kind: r.kind, status: r.status, direction: view.direction, confidence: r.confidence, rationale: r.rationale, other: view.other, createdAt: r.createdAt };
}

export interface TaskProposalDTO {
  id: string;
  backlogItemId: string;
  analysisId: string;
  status: TaskProposalStatus;
  /** `null` only for a stored proposal whose content no longer validates — it can be rejected but never approved/converted. */
  content: TaskProposalContent | null;
  decidedAt: string | null;
  /** Set once CONVERTED. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toTaskProposalDTO(p: TaskProposal): TaskProposalDTO {
  return {
    id: p.id,
    backlogItemId: p.backlogItemId,
    analysisId: p.analysisId,
    status: p.status,
    content: p.content,
    decidedAt: p.decidedAt,
    taskId: p.taskId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export interface BacklogEventDTO {
  id: string;
  type: BacklogEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function toBacklogEventDTO(e: BacklogEvent): BacklogEventDTO {
  return { id: e.id, type: e.type, payload: e.payload, createdAt: e.createdAt };
}

export interface BacklogItemDetailDTO {
  item: BacklogItemDTO;
  latestAnalysis: BacklogAnalysisDTO | null;
  /** The most recent analysis job (queued / running / finished); `null` if never analyzed. */
  analysisJob: BacklogAnalysisJobDTO | null;
  analysisCount: number;
  relationships: BacklogRelationshipDTO[];
  proposal: TaskProposalDTO | null;
  events: BacklogEventDTO[];
}

export function toBacklogItemDetailDTO(d: BacklogItemDetail): BacklogItemDetailDTO {
  return {
    item: toBacklogItemDTO(d.item),
    latestAnalysis: d.latestAnalysis ? toBacklogAnalysisDTO(d.latestAnalysis) : null,
    analysisJob: d.analysisJob ? toBacklogAnalysisJobDTO(d.analysisJob) : null,
    analysisCount: d.analysisCount,
    relationships: d.relationships.map(toBacklogRelationshipDTO),
    proposal: d.proposal ? toTaskProposalDTO(d.proposal) : null,
    events: d.events.map(toBacklogEventDTO),
  };
}

export type { AnalysisContextSummary };
