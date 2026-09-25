/**
 * Deterministic lifecycle rules for backlog items and task proposals. Mirrors
 * domain/task-state-machine.ts: a full, exhaustive transition table, and no LLM output ever sets
 * a status — an analysis result is *evidence* BacklogService evaluates against these rules (see
 * `deriveAnalysisOutcome`). See /docs/BACKLOG_INTELLIGENCE.md "Lifecycle".
 */
import type { AnalysisResult, BacklogItemStatus, EvidenceAssessment, TaskProposalStatus } from "./backlog-types.js";
import { hasConfidentContradiction } from "./evidence.js";

// ---------------------------------------------------------------------------
// BacklogItem
// ---------------------------------------------------------------------------

export type BacklogTrigger =
  | "analysis_requested" // a user asks for (re-)analysis: a job is queued and the item is ANALYZING until the worker settles it
  | "analysis_succeeded" // validated analysis, nothing blocking
  | "analysis_needs_clarification" // validated analysis with blocking missing information, or malformed model output
  | "analysis_aborted" // infrastructure failure — the item returns to the status it had before analysis started
  | "proposal_generated" // a TaskProposal now exists (PENDING)
  | "proposal_rejected" // the human rejected the proposal; the item can be re-proposed
  | "converted" // the approved proposal became a Task
  | "rejected" // a human dismissed the item itself
  | "content_edited"; // title/description/reference changed — any prior analysis is now stale

export interface BacklogTransitionRule {
  from: BacklogItemStatus;
  trigger: BacklogTrigger;
  to: BacklogItemStatus;
}

export const BACKLOG_TRANSITIONS: readonly BacklogTransitionRule[] = [
  { from: "NEW", trigger: "analysis_requested", to: "ANALYZING" },
  { from: "NEEDS_CLARIFICATION", trigger: "analysis_requested", to: "ANALYZING" },
  { from: "ANALYZED", trigger: "analysis_requested", to: "ANALYZING" },
  // No ANALYZING -> ANALYZING row: while an item is ANALYZING it has exactly one live analysis JOB
  // (see BacklogAnalysisJobRepository), and crash recovery / retry / backoff all happen at the JOB
  // level. A repeated request while ANALYZING is answered idempotently with that job.

  { from: "ANALYZING", trigger: "analysis_succeeded", to: "ANALYZED" },
  { from: "ANALYZING", trigger: "analysis_needs_clarification", to: "NEEDS_CLARIFICATION" },
  // `analysis_aborted`'s destination is dynamic (the pre-analysis status) — see `resolveAbortTarget`.

  { from: "ANALYZED", trigger: "proposal_generated", to: "READY_FOR_TASK" },
  { from: "READY_FOR_TASK", trigger: "proposal_rejected", to: "ANALYZED" },
  { from: "READY_FOR_TASK", trigger: "converted", to: "CONVERTED" },

  { from: "NEW", trigger: "rejected", to: "REJECTED" },
  { from: "NEEDS_CLARIFICATION", trigger: "rejected", to: "REJECTED" },
  { from: "ANALYZED", trigger: "rejected", to: "REJECTED" },
  { from: "READY_FOR_TASK", trigger: "rejected", to: "REJECTED" },

  { from: "NEW", trigger: "content_edited", to: "NEW" },
  { from: "NEEDS_CLARIFICATION", trigger: "content_edited", to: "NEW" },
  { from: "ANALYZED", trigger: "content_edited", to: "NEW" },
] as const;

// Deliberately absent:
//  - Nothing leaves CONVERTED or REJECTED: both are terminal.
//  - ANALYZING accepts no edit and no rejection: a live analysis is working from a snapshot of the
//    current content, and racing an edit against it would make the result describe text that no
//    longer exists. Wait for it to finish (or its lease to expire).
//  - READY_FOR_TASK accepts no edit: a proposal was built from the current content and a human may
//    be about to approve it — reject the proposal first.

export class InvalidBacklogTransitionError extends Error {
  constructor(
    public readonly from: BacklogItemStatus,
    public readonly trigger: BacklogTrigger,
  ) {
    super(`Invalid backlog transition: ${from} cannot handle "${trigger}"`);
    this.name = "InvalidBacklogTransitionError";
  }
}

export function nextBacklogStatus(from: BacklogItemStatus, trigger: BacklogTrigger): BacklogItemStatus {
  const rule = BACKLOG_TRANSITIONS.find((r) => r.from === from && r.trigger === trigger);
  if (!rule) throw new InvalidBacklogTransitionError(from, trigger);
  return rule.to;
}

/** Every status a trigger may legally fire from — the single source the repositories build their atomic `WHERE status IN (...)` guards from. */
export function statusesAllowing(trigger: BacklogTrigger): BacklogItemStatus[] {
  if (trigger === "analysis_aborted") return ["ANALYZING"];
  return BACKLOG_TRANSITIONS.filter((r) => r.trigger === trigger).map((r) => r.from);
}

const ABORT_RETURNS_TO: readonly BacklogItemStatus[] = ["NEW", "NEEDS_CLARIFICATION", "ANALYZED"];

/** Where an item whose analysis was aborted by an infrastructure failure goes back to — always the status it was claimed from, never an invented one. */
export function resolveAbortTarget(statusBeforeAnalysis: BacklogItemStatus | null): BacklogItemStatus {
  return statusBeforeAnalysis && ABORT_RETURNS_TO.includes(statusBeforeAnalysis) ? statusBeforeAnalysis : "NEW";
}

/**
 * The ONLY place a validated `AnalysisResult` influences the item's status, and only through fixed
 * rules — the model cannot express a status (the analysis schema is strict, so an extra `status` key
 * makes the whole output malformed; see analysis-schema.ts):
 *   1. any blocking missing-information entry ⇒ a human must clarify first;
 *   2. (Phase 4A.2) the platform's OWN evidence contradicts a claim the model made with `high` or
 *      `medium` confidence ⇒ a human must look at the contradiction first. Stated confidence never
 *      overrides evidence, and the contradiction is exposed rather than silently downgraded.
 */
export function deriveAnalysisOutcome(
  result: AnalysisResult,
  assessment?: EvidenceAssessment,
): Extract<BacklogTrigger, "analysis_succeeded" | "analysis_needs_clarification"> {
  if (result.missingInformation.some((m) => m.blocking)) return "analysis_needs_clarification";
  if (hasConfidentContradiction(assessment)) return "analysis_needs_clarification";
  // Phase 4A.4 — strong platform evidence that a reported ABSENCE is already implemented: a human looks first,
  // whatever confidence the model claimed. (A weaker `possible` conflict is shown but does not block.) Never "fixed".
  if (assessment?.reconciliation?.alreadyImplemented === "strong") return "analysis_needs_clarification";
  return "analysis_succeeded";
}

// ---------------------------------------------------------------------------
// TaskProposal
// ---------------------------------------------------------------------------

export type ProposalTrigger = "approve" | "reject" | "convert_started" | "convert_succeeded" | "convert_failed";

export interface ProposalTransitionRule {
  from: TaskProposalStatus;
  trigger: ProposalTrigger;
  to: TaskProposalStatus;
}

export const PROPOSAL_TRANSITIONS: readonly ProposalTransitionRule[] = [
  { from: "PENDING", trigger: "approve", to: "APPROVED" },
  { from: "PENDING", trigger: "reject", to: "REJECTED" },
  { from: "APPROVED", trigger: "reject", to: "REJECTED" },
  { from: "APPROVED", trigger: "convert_started", to: "CONVERTING" },
  // Lease reclaim of a conversion whose process died between claiming and finishing.
  { from: "CONVERTING", trigger: "convert_started", to: "CONVERTING" },
  { from: "CONVERTING", trigger: "convert_succeeded", to: "CONVERTED" },
  { from: "CONVERTING", trigger: "convert_failed", to: "APPROVED" },
] as const;

// Deliberately absent: PENDING -> CONVERTING (a proposal must be explicitly approved first), and
// nothing leaves CONVERTED or REJECTED. There is no trigger the analysis path can fire at all —
// approval exists only as an authenticated user action (BacklogService.approveProposal).

export class InvalidProposalTransitionError extends Error {
  constructor(
    public readonly from: TaskProposalStatus,
    public readonly trigger: ProposalTrigger,
  ) {
    super(`Invalid task-proposal transition: ${from} cannot handle "${trigger}"`);
    this.name = "InvalidProposalTransitionError";
  }
}

export function nextProposalStatus(from: TaskProposalStatus, trigger: ProposalTrigger): TaskProposalStatus {
  const rule = PROPOSAL_TRANSITIONS.find((r) => r.from === from && r.trigger === trigger);
  if (!rule) throw new InvalidProposalTransitionError(from, trigger);
  return rule.to;
}

export function proposalStatusesAllowing(trigger: ProposalTrigger): TaskProposalStatus[] {
  return PROPOSAL_TRANSITIONS.filter((r) => r.trigger === trigger).map((r) => r.from);
}
