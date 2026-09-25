import type { AgentRun, BugFixVerificationContract, CheckOutcome, FixVerificationStatus, ReproductionStatus, Task, TaskEvent, ValidationOutcome, VerificationEvidence, VerificationMethod } from "../domain/types.js";
import type { OrchestratorFailureCategory } from "../orchestrator/failure-classifier.js";
import {
  buildAgentRunHistory,
  computeExecutionDurations,
  deriveFailureContext,
  type AgentRunHistoryItem,
  type ExecutionDurations,
  type FailureContext,
} from "./execution-history.js";
import { rollupUsage, type TaskUsageRollup } from "./usage-rollup.js";

/**
 * Real, platform-captured evidence about this task's commit and push — see
 * PLATFORM_GAPS.md GAP-015/GAP-024, "AI claims are not execution evidence."
 * Everything here is read from the COMMIT_CREATED/BRANCH_PUSHED events,
 * which the orchestrator only appends after `git` itself confirmed each
 * fact (branch assertion, `git status --porcelain`, a remote ref read back
 * after push) — never from anything the coding engine said about its own
 * work. `null` fields mean the corresponding step hasn't happened yet for
 * this task (e.g. no push event recorded), not "unknown."
 */
export interface TaskReportGitEvidence {
  branch: string | null;
  changedFiles: string[];
  commitSha: string | null;
  pushedCommitSha: string | null;
  remoteBranchSha: string | null;
}

/**
 * V1.1 Slice 3 — one side (reproduction or fix verification) of a task's
 * bug-fix verification evidence, shaped for direct report/UI display. See
 * domain/types.ts BugReproductionResult/FixVerificationResult — this is the
 * same platform-captured data, just flattened for the report's own
 * consumers. PLATFORM-CAPTURED VERIFICATION EVIDENCE, never an AI-generated
 * claim (see item 12 of the Slice 3 brief).
 */
export interface TaskReportVerificationStep<TStatus extends string> {
  status: TStatus;
  checkId: string | null;
  command: string | null;
  commitSha: string | null;
  branch: string | null;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  logExcerpt: string | null;
}

/** See TaskRecord.bugFixVerification's own doc comment. `null` for a task with no bug-fix verification contract at all. */
export interface TaskReportBugFixVerification {
  contract: BugFixVerificationContract;
  reproduction: TaskReportVerificationStep<ReproductionStatus> | null;
  fixVerification: TaskReportVerificationStep<FixVerificationStatus> | null;
}

/**
 * Developer Alpha (see docs/INTERNAL_ALPHA.md "Telemetry") — the handful of numbers that decide the
 * next product priorities, all derived from data the platform already records. Token totals are
 * sums of ONLY what the coding engine actually reported; `tokensReportedRuns` says how many runs
 * that covers, so a partial total is never mistaken for a complete one. Nothing here is estimated.
 */
export interface TaskReportTelemetry {
  implementerAttempts: number;
  reviewerRuns: number;
  reviewerRejections: number;
  humanFeedbackCycles: number;
  infrastructureRetries: number;
  /** AgentRuns executed on a model that wasn't the first one tried for that role (fallbackIndex > 0). */
  fallbackRuns: number;
  /** Times a worker process resumed this task after another lost it (TASK_CLAIMED with `recoveredFrom`). */
  recoveryEvents: number;
  /** Times the task stopped to ask a human a question (NEEDS_INPUT_RAISED) — a manual-intervention signal. */
  humanInterventions: number;
  aiExecutionMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensReportedRuns: number;
  modelsUsed: string[];
}

/** The concise report shape defined in /docs/TASK_LIFECYCLE.md — built only from persisted evidence, never fabricated. */
export interface TaskReport {
  title: string;
  whatWasWrong: string;
  whatChanged: string;
  /**
   * The number of files the platform's own git evidence shows as changed at
   * the last commit — see TaskReportGitEvidence.changedFiles, sourced from
   * `git status --porcelain`, never from the coding engine's self-reported
   * file list (see PLATFORM_GAPS.md GAP-024's fabricated-diff finding for
   * why that distinction matters).
   */
  filesChanged: number;
  /** See TaskReportGitEvidence's own doc comment. */
  gitEvidence: TaskReportGitEvidence;
  checks: Array<{ name: string; passed: boolean; outcome: CheckOutcome }>;
  /**
   * Distinguishes "the declared checks ran and passed" from "nothing was
   * configured, so nothing ran" — see PLATFORM_GAPS.md GAP-004. `null` only
   * when no validation has run yet for this task.
   */
  validationOutcome: ValidationOutcome | null;
  reviewFindings: Array<{ severity: string; category: string; summary: string }>;
  /** The Reviewer's own prose assessment (Markdown) — present alongside `reviewFindings`, which stay empty unless the engine emits structured findings. See /docs/CODING_ENGINE.md "Output handling". */
  reviewSummary: string | null;
  /**
   * Whether the Reviewer's verdict rests on actually running something
   * ("executed") or only reading the diff ("static") — see PLATFORM_GAPS.md
   * GAP-16, "'Independently verified' means read, not run." `"unknown"`
   * means the Reviewer never said, which must be treated as unverified, not
   * silently assumed to be thorough. `null` only when no review has
   * completed yet.
   */
  reviewVerificationMethod: VerificationMethod | null;
  /**
   * V1.1 Slice 2 — the platform's own captured evidence of a Reviewer-
   * requested verification, from the latest REVIEWER_VERIFICATION_COMPLETED
   * event, or `null` if no verification was ever requested for this task's
   * current review. See domain/types.ts VerificationEvidence.
   */
  reviewVerification: VerificationEvidence | null;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  /** Present once the platform has opened/found a real Pull Request for this task — see /docs/GITHUB_INTEGRATION.md. */
  pullRequest: { url: string | null; number: number | null; branch: string | null; baseBranch: string } | null;
  commitSha: string | null;
  /** Present only when status is FAILED — the persisted TASK_FAILED event's own reason, never fabricated. Covers both infra failures and an exhausted review/fix cycle. */
  failureReason: string | null;
  /**
   * V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028) — distinguishes an infrastructure failure
   * (`timeout`, `network_failure`, `rate_limited`, `provider_quota_exhausted`,
   * `workspace_provision_failure`, `source_control_failure`, …) from a genuine task/code failure
   * (`task_failure`) or one the platform couldn't positively identify (`unknown_failure`) — see
   * orchestrator/failure-classifier.ts. `null` only when status isn't FAILED, or (rare) a
   * pre-Slice-4 TASK_FAILED event that predates this field.
   */
  failureCategory: OrchestratorFailureCategory | null;
  /**
   * V1.1 Slice 4 — every infrastructure failure this task's CURRENT execution actually hit and
   * (attempted to) recover from, in order — real, structured retry history, not a summary. Empty for
   * a task that never hit one. See INFRASTRUCTURE_FAILURE_DETECTED/INFRASTRUCTURE_RETRY_SCHEDULED.
   * A task that ultimately succeeded despite one or more entries here is the concrete "RECOVERED
   * FAILURE" case this slice's brief (item 18) asks the report to make visible — distinct from both
   * an ordinary clean run and a genuine CODE/task failure.
   */
  infrastructureFailures: Array<{ attempt: number; category: OrchestratorFailureCategory; retryable: boolean; reason: string; detectedAt: string }>;
  /**
   * Every AgentRun for this task, in order — see /docs/TASK_LIFECYCLE.md "Execution history and
   * observability". A second *view* over already-persisted AgentRun rows, not a new history system.
   */
  agentRuns: AgentRunHistoryItem[];
  /** Derived purely from existing timestamps — see execution-history.ts. */
  durations: ExecutionDurations;
  /** True iff this task's history includes at least one crash-recovery resume (any AgentRun ever left "interrupted"), whether or not it ultimately failed. */
  recoveredFromCrash: boolean;
  /** Present only when status is FAILED — which stage/run/attempt failed, never fabricated. */
  failureContext: FailureContext | null;
  /**
   * GAP-031 — task-level usage/cost roll-up over this task's AgentRuns (each counted exactly once): token
   * totals, the provider-reported estimate (kept apart from any CodeForge-calculated cost, which is always
   * `null`), and per-run / per-phase breakdowns. `null` fields mean "no run reported it", never zero.
   */
  usage: TaskUsageRollup;
  /** Developer Alpha — measurable per-task summary, derived only from already-persisted events/AgentRuns (never new storage). See TaskReportTelemetry. */
  telemetry: TaskReportTelemetry;
  /**
   * V1.1 Slice 3 — see TaskReportBugFixVerification's own doc comment.
   * `null` for every ordinary task (the overwhelming majority); present only
   * for a task explicitly created with a BugFixVerificationContract.
   */
  bugFixVerification: TaskReportBugFixVerification | null;
}

function toReportVerificationStep<TStatus extends string>(status: TStatus, evidence: VerificationEvidence): TaskReportVerificationStep<TStatus> {
  return {
    status,
    checkId: evidence.checkId,
    command: evidence.command,
    commitSha: evidence.commitSha,
    branch: evidence.actualBranch,
    exitCode: evidence.exitCode,
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    logExcerpt: evidence.logExcerpt,
  };
}

export function buildTaskReport(task: Task, agentRuns: AgentRun[], events: TaskEvent[], baseBranch: string): TaskReport {
  const implementerRuns = agentRuns.filter((r) => r.role === "implementer" && r.result);
  const reviewerRuns = agentRuns.filter((r) => r.role === "reviewer" && r.result);
  const lastImplementer = implementerRuns[implementerRuns.length - 1];
  const lastReviewer = reviewerRuns[reviewerRuns.length - 1];
  const reversedEvents = [...events].reverse();
  const lastValidationEvent = reversedEvents.find((e) => e.type === "VALIDATION_COMPLETED");
  const lastCommitEvent = reversedEvents.find((e) => e.type === "COMMIT_CREATED");
  const lastPushEvent = reversedEvents.find((e) => e.type === "BRANCH_PUSHED");
  const lastReviewEvent = reversedEvents.find((e) => e.type === "REVIEW_COMPLETED");
  const checks = (lastValidationEvent?.payload.checks as Array<{ name: string; passed: boolean; outcome: CheckOutcome }> | undefined) ?? [];
  const lastFailedEvent = task.status === "FAILED" ? reversedEvents.find((e) => e.type === "TASK_FAILED") : undefined;

  const gitEvidence: TaskReportGitEvidence = {
    branch: (lastCommitEvent?.payload.branch as string | undefined) ?? (lastPushEvent?.payload.branch as string | undefined) ?? null,
    changedFiles: (lastCommitEvent?.payload.changedFiles as string[] | undefined) ?? [],
    commitSha: (lastCommitEvent?.payload.commitSha as string | undefined) ?? null,
    pushedCommitSha: (lastPushEvent?.payload.pushedCommitSha as string | undefined) ?? null,
    remoteBranchSha: (lastPushEvent?.payload.remoteBranchSha as string | null | undefined) ?? null,
  };

  const countEvents = (type: TaskEvent["type"]) => events.filter((e) => e.type === type).length;
  const usage = rollupUsage(agentRuns);
  const tokenRuns = agentRuns.filter((r) => r.cost && (r.cost.inputTokens !== undefined || r.cost.outputTokens !== undefined));
  const durations = computeExecutionDurations(task, events, agentRuns);
  const telemetry: TaskReportTelemetry = {
    implementerAttempts: agentRuns.filter((r) => r.role === "implementer").length,
    reviewerRuns: agentRuns.filter((r) => r.role === "reviewer").length,
    reviewerRejections: countEvents("REVIEW_CHANGES_REQUESTED"),
    humanFeedbackCycles: countEvents("HUMAN_REVIEW_CHANGES_REQUESTED"),
    infrastructureRetries: countEvents("INFRASTRUCTURE_RETRY_SCHEDULED"),
    fallbackRuns: agentRuns.filter((r) => r.fallbackIndex > 0).length,
    recoveryEvents: events.filter((e) => e.type === "TASK_CLAIMED" && typeof e.payload.recoveredFrom === "string").length,
    humanInterventions: countEvents("NEEDS_INPUT_RAISED"),
    aiExecutionMs: durations.implementationMs === null && durations.reviewMs === null ? null : (durations.implementationMs ?? 0) + (durations.reviewMs ?? 0),
    // From the roll-up: a field no run reported is null, not 0 (the old per-run `?? 0` turned "unreported" into a zero).
    inputTokens: usage.totals.inputTokens,
    outputTokens: usage.totals.outputTokens,
    tokensReportedRuns: tokenRuns.length,
    modelsUsed: [...new Set(agentRuns.map((r) => r.modelId).filter((m): m is string => m !== null))],
  };

  return {
    telemetry,
    usage,
    title: task.title,
    whatWasWrong: task.goal,
    whatChanged: lastImplementer?.result?.summary ?? "(no implementation summary recorded)",
    filesChanged: gitEvidence.changedFiles.length,
    gitEvidence,
    checks,
    validationOutcome: (lastValidationEvent?.payload.outcome as ValidationOutcome | undefined) ?? null,
    reviewFindings: (lastReviewer?.result?.findings ?? []).map((f) => ({
      severity: f.severity,
      category: f.category,
      summary: f.summary,
    })),
    reviewSummary: lastReviewer?.result?.summary ?? null,
    reviewVerificationMethod: (lastReviewEvent?.payload.verificationMethod as VerificationMethod | undefined) ?? null,
    reviewVerification: (lastReviewEvent?.payload.verification as VerificationEvidence | null | undefined) ?? null,
    confidence: lastReviewer?.result?.confidence ?? null,
    status: statusLabel(task),
    pullRequest: task.taskRecord.pullRequest
      ? { url: task.taskRecord.pullRequest.url, number: task.taskRecord.pullRequest.number, branch: task.taskRecord.branchName, baseBranch }
      : null,
    commitSha: task.taskRecord.latestDiffRef,
    failureReason: typeof lastFailedEvent?.payload.error === "string" ? lastFailedEvent.payload.error : null,
    failureCategory: (lastFailedEvent?.payload.category as OrchestratorFailureCategory | undefined) ?? null,
    infrastructureFailures: events
      .filter((e) => e.type === "INFRASTRUCTURE_FAILURE_DETECTED")
      .map((e) => ({
        attempt: e.payload.attempt as number,
        category: e.payload.category as OrchestratorFailureCategory,
        retryable: e.payload.retryable as boolean,
        reason: e.payload.reason as string,
        detectedAt: e.createdAt,
      })),
    agentRuns: buildAgentRunHistory(agentRuns),
    durations,
    recoveredFromCrash: agentRuns.some((r) => r.status === "interrupted"),
    failureContext: deriveFailureContext(task, events, agentRuns),
    bugFixVerification: task.taskRecord.bugFixVerification?.contract
      ? {
          contract: task.taskRecord.bugFixVerification.contract,
          reproduction: task.taskRecord.bugFixVerification.reproduction
            ? toReportVerificationStep(task.taskRecord.bugFixVerification.reproduction.status, task.taskRecord.bugFixVerification.reproduction.evidence)
            : null,
          fixVerification: task.taskRecord.bugFixVerification.fixVerification
            ? toReportVerificationStep(task.taskRecord.bugFixVerification.fixVerification.status, task.taskRecord.bugFixVerification.fixVerification.evidence)
            : null,
        }
      : null,
  };
}

function statusLabel(task: Task): string {
  switch (task.status) {
    case "REVIEW":
      return "Ready for review";
    case "DONE":
      return "Done";
    case "NEEDS_INPUT":
      return "Needs input";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "In progress";
  }
}
