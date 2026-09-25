import type { AgentRole, AgentRun, AgentRunStatus, CostMetadata, Task, TaskEvent } from "../domain/types.js";
import { deriveReviewResult } from "../review/reviewer.js";

/**
 * Execution-history derivation for the Task Detail UI/API — see
 * /docs/TASK_LIFECYCLE.md "Execution history and observability". Every value
 * here is derived from data the platform already persists (AgentRun rows,
 * TaskEvent rows, the task's own timestamps) — nothing new is stored. This
 * is deliberately a second *view* over existing evidence, not a second
 * parallel event/history system.
 */

export type AgentRunTrigger =
  | "initial"
  | "self_fix_retry"
  | "ai_review_fix"
  | "human_review_fix"
  | "review"
  /** The Reviewer's follow-up call made AFTER the platform executed a check it requested — a model call about verification evidence, distinct from the review itself. */
  | "review_verification";

export interface AgentRunHistoryItem {
  id: string;
  role: AgentRole;
  attemptNumber: number;
  status: AgentRunStatus;
  /** What caused this specific attempt — distinguishes an original pass from a self-fix retry,
   *  an AI-reviewer-triggered fix, or a human-GitHub-review-triggered fix. See TASK_LIFECYCLE.md. */
  trigger: AgentRunTrigger;
  startedAt: string;
  completedAt: string | null;
  /** The Implementer/Reviewer's own summary (clean prose — never raw engine output). */
  summary: string | null;
  filesChanged: string[];
  confidence: "high" | "medium" | "low" | null;
  /** Present only for role = "reviewer". */
  findings: Array<{ severity: string; category: string; summary: string }> | null;
  /** Present only for role = "reviewer" — derived via the same deriveReviewResult() the
   *  Orchestrator itself uses, not a second parallel verdict concept. */
  verdict: "approved" | "rejected" | null;
  /** Sanitized failure message (never a raw stack trace — see AgentRun.error's own contract). */
  error: string | null;
  /** The human GitHub reviewer's own feedback, present only on a human-review-triggered fix run. */
  humanReviewFeedback: { reviewerLogin: string; comments: string } | null;
  /** True iff the immediately preceding attempt of the same role was left "interrupted" —
   *  i.e. this run is what a crash-recovery resume actually produced. See "Crash recovery". */
  resumedAfterInterruption: boolean;
  /**
   * V1.1 Slice 5 — the platform's own routing decision for this exact invocation (see
   * domain/types.ts ModelSelection/AgentRun.modelId), never the AI's own claim about what ran.
   * `null` when no ModelRouter/ModelRegistry was wired or no candidate was eligible — see
   * routing/model-router.ts's own doc comment.
   */
  modelId: string | null;
  providerId: string | null;
  /** How many DISTINCT models were already attempted for this (task, role) before this one — 0 for the first. */
  fallbackIndex: number;
  /** Real token/cost telemetry the coding engine reported, or `null` fields where it didn't expose them — see domain/types.ts CostMetadata. Never fabricated. */
  cost: CostMetadata | null;
}

export function buildAgentRunHistory(agentRuns: AgentRun[]): AgentRunHistoryItem[] {
  return agentRuns.map((run) => {
    const priorSameRole = agentRuns.find((r) => r.role === run.role && r.attemptNumber === run.attemptNumber - 1);
    const review = run.role === "reviewer" && run.result ? deriveReviewResult(run.result) : null;
    return {
      id: run.id,
      role: run.role,
      attemptNumber: run.attemptNumber,
      status: run.status,
      trigger: deriveTrigger(run),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      summary: run.result?.summary ?? null,
      filesChanged: run.result?.filesChanged ?? [],
      confidence: run.result?.confidence ?? null,
      findings: run.role === "reviewer" ? (review?.findings ?? []).map((f) => ({ severity: f.severity, category: f.category, summary: f.summary })) : null,
      verdict: review?.verdict ?? null,
      error: run.error,
      humanReviewFeedback: run.input.humanReviewFeedback
        ? { reviewerLogin: run.input.humanReviewFeedback.reviewerLogin, comments: run.input.humanReviewFeedback.comments }
        : null,
      resumedAfterInterruption: priorSameRole?.status === "interrupted",
      modelId: run.modelId,
      providerId: run.providerId,
      fallbackIndex: run.fallbackIndex,
      cost: run.cost,
    };
  });
}

export function deriveTrigger(run: AgentRun): AgentRunTrigger {
  if (run.role === "reviewer") return run.input.verificationEvidence ? "review_verification" : "review";
  if (run.input.humanReviewFeedback) return "human_review_fix";
  if (run.input.reviewerFeedback) return "ai_review_fix";
  if (run.input.lastFailure) return "self_fix_retry";
  return "initial";
}

export interface ExecutionDurations {
  totalMs: number | null;
  implementationMs: number | null;
  reviewMs: number | null;
  validationMs: number | null;
  waitingForHumanReviewMs: number | null;
}

/**
 * Every value is derived purely from existing timestamps (Task.startedAt/completedAt,
 * AgentRun.startedAt/completedAt, TaskEvent.createdAt) — nothing new is persisted. Any duration
 * whose boundary timestamps aren't both available yet is `null`, never estimated or fabricated —
 * same convention `formatDuration` (web/src/lib/time.ts) already uses for the total.
 */
export function computeExecutionDurations(task: Task, events: TaskEvent[], agentRuns: AgentRun[]): ExecutionDurations {
  return {
    totalMs: diffMs(task.startedAt, task.completedAt),
    implementationMs: sumRunDurations(agentRuns, "implementer"),
    reviewMs: sumRunDurations(agentRuns, "reviewer"),
    validationMs: sumPairedEventDurations(events, "VALIDATION_STARTED", "VALIDATION_COMPLETED"),
    waitingForHumanReviewMs: computeWaitingForHumanReviewMs(task, events),
  };
}

function diffMs(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return ms >= 0 ? ms : null;
}

function sumRunDurations(agentRuns: AgentRun[], role: AgentRole): number | null {
  const durations = agentRuns
    .filter((r) => r.role === role)
    .map((r) => diffMs(r.startedAt, r.completedAt))
    .filter((ms): ms is number => ms !== null);
  return durations.length ? durations.reduce((a, b) => a + b, 0) : null;
}

function sumPairedEventDurations(events: TaskEvent[], startType: TaskEvent["type"], endType: TaskEvent["type"]): number | null {
  let total = 0;
  let count = 0;
  let pendingStart: string | null = null;
  for (const event of events) {
    if (event.type === startType) {
      pendingStart = event.createdAt;
    } else if (event.type === endType && pendingStart) {
      const ms = diffMs(pendingStart, event.createdAt);
      if (ms !== null) {
        total += ms;
        count += 1;
      }
      pendingStart = null;
    }
  }
  return count ? total : null;
}

/** From the most recent time the task reached REVIEW to whenever it was next acted on. */
function computeWaitingForHumanReviewMs(task: Task, events: TaskEvent[]): number | null {
  const lastMovedToReview = [...events].reverse().find((e) => e.type === "TASK_MOVED_TO_REVIEW");
  if (!lastMovedToReview) return null;

  const respondedTypes = new Set(["HUMAN_REVIEW_CHANGES_REQUESTED", "HUMAN_REVIEW_APPROVED", "TASK_ACCEPTED", "TASK_CHANGES_REQUESTED"]);
  const responseEvent = events.find((e) => e.createdAt > lastMovedToReview.createdAt && respondedTypes.has(e.type));
  const end = responseEvent?.createdAt ?? task.completedAt ?? null;
  return diffMs(lastMovedToReview.createdAt, end);
}

export interface FailureContext {
  /** Human-readable stage the failure happened at, e.g. "Implementer", "Validation", "Independent review". */
  stage: string;
  failedRole: AgentRole | null;
  attemptNumber: number | null;
  /** True iff any AgentRun for this task was ever left "interrupted" — i.e. this task's history
   *  includes at least one crash-recovery resume, whether or not it's what ultimately failed. */
  recoveredFromCrash: boolean;
}

const STAGE_LABELS: Partial<Record<TaskEvent["type"], string>> = {
  WORKSPACE_FAILED: "Preparing the workspace",
  AGENT_FAILED: "Agent invocation",
  VALIDATION_COMPLETED: "Validation",
  SOURCE_CONTROL_FAILED: "Commit/push",
  REVIEW_CHANGES_REQUESTED: "Independent review",
};

/** Only present when the task is FAILED with a recorded TASK_FAILED event — never fabricated. */
export function deriveFailureContext(task: Task, events: TaskEvent[], agentRuns: AgentRun[]): FailureContext | null {
  if (task.status !== "FAILED") return null;
  const failedEvent = [...events].reverse().find((e) => e.type === "TASK_FAILED");
  if (!failedEvent) return null;

  const before = events.filter((e) => e.id !== failedEvent.id && e.createdAt <= failedEvent.createdAt);
  const lastRelevant = [...before].reverse().find((e) => e.type in STAGE_LABELS);
  const failedRun = [...agentRuns].reverse().find((r) => r.status === "failed" || r.status === "interrupted");

  return {
    stage: (lastRelevant && STAGE_LABELS[lastRelevant.type]) ?? "Unknown",
    failedRole: failedRun?.role ?? null,
    attemptNumber: failedRun?.attemptNumber ?? null,
    recoveredFromCrash: agentRuns.some((r) => r.status === "interrupted"),
  };
}
