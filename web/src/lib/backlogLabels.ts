import type {
  AnalysisFailureCategory,
  AnalysisJobStatus,
  BacklogEventType,
  BacklogItemStatus,
  ClaimEstablishes,
  ClaimKind,
  ClaimStatus,
  EvidenceType,
  InspectionSummary,
  ConfidenceLevel,
  IssueType,
  TaskProposalStatus,
} from "../api/index.js";
import type { StatusMeta } from "./statusMeta.js";

/**
 * Display-only labels for Phase 4A backlog concepts — like statusMeta.ts, the frontend never infers
 * or overrides a status, it only decides how the server's value is worded and colored.
 */
export const BACKLOG_STATUS_META: Record<BacklogItemStatus, StatusMeta> = {
  NEW: { label: "New", tone: "neutral" },
  ANALYZING: { label: "Analyzing", tone: "active" },
  ANALYZED: { label: "Analyzed", tone: "info" },
  NEEDS_CLARIFICATION: { label: "Needs clarification", tone: "attention" },
  READY_FOR_TASK: { label: "Ready for task", tone: "success" },
  CONVERTED: { label: "Converted to task", tone: "success" },
  REJECTED: { label: "Rejected", tone: "cancelled" },
};

export const PROPOSAL_STATUS_META: Record<TaskProposalStatus, StatusMeta> = {
  PENDING: { label: "Pending approval", tone: "attention" },
  APPROVED: { label: "Approved", tone: "info" },
  CONVERTING: { label: "Converting", tone: "active" },
  CONVERTED: { label: "Converted", tone: "success" },
  REJECTED: { label: "Rejected", tone: "cancelled" },
};

export const FAILURE_CATEGORY_LABELS: Record<AnalysisFailureCategory, string> = {
  malformed_output: "The model returned output CodeForge could not validate",
  engine_error: "The coding engine reported an error",
  timeout: "The analysis timed out",
  no_model_available: "No model was available",
  cancelled: "The analysis was cancelled",
  context_error: "CodeForge could not build the project context",
  interrupted: "The analysis was interrupted",
};

export const ANALYSIS_JOB_STATUS_LABELS: Record<AnalysisJobStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  bug: "Bug",
  feature: "Feature",
  improvement: "Improvement",
  chore: "Chore",
  question: "Question",
  unknown: "Unknown",
};

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

export const BACKLOG_EVENT_LABELS: Record<BacklogEventType, string> = {
  BACKLOG_ITEM_CREATED: "Backlog item created",
  BACKLOG_ITEM_UPDATED: "Backlog item edited",
  BACKLOG_ITEM_REJECTED: "Backlog item rejected",
  ANALYSIS_QUEUED: "Analysis queued",
  ANALYSIS_STARTED: "Analysis started",
  ANALYSIS_RETRY_SCHEDULED: "Analysis retry scheduled",
  ANALYSIS_COMPLETED: "Analysis completed",
  ANALYSIS_FAILED: "Analysis failed",
  ANALYSIS_CANCELLED: "Analysis cancelled",
  TASK_PROPOSAL_GENERATED: "Task proposal generated",
  TASK_PROPOSAL_APPROVED: "Task proposal approved",
  TASK_PROPOSAL_REJECTED: "Task proposal rejected",
  TASK_PROPOSAL_CONVERTED: "Task proposal converted to a task",
};

export function labelForBacklogEvent(type: BacklogEventType): string {
  return BACKLOG_EVENT_LABELS[type] ?? type;
}

/** Statuses in which title/description/reference may be edited (mirrors the server's rule; the server still enforces it). */
export const EDITABLE_STATUSES: BacklogItemStatus[] = ["NEW", "ANALYZED", "NEEDS_CLARIFICATION"];

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  FILE_EXISTS: "A file exists",
  FILE_ABSENT: "A file does not exist",
  FEATURE_ABSENT: "Nothing implements this",
  FEATURE_PRESENT: "Something implements this",
  BEHAVIOR_CORRECT: "Behaves correctly",
  BEHAVIOR_INCORRECT: "Behaves incorrectly",
};

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  FILE_EXISTS: "File exists",
  FILE_NOT_FOUND: "File not found",
  PATH_MATCH: "Path match",
  CONTENT_MATCH: "Content match",
  SYMBOL_MATCH: "Declared in the repository index",
  SYMBOL_REFERENCE: "Declared and referenced",
  CHECK_RESULT: "Configured check result",
};

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  SUPPORTED: "SUPPORTED",
  CONTRADICTED: "CONTRADICTED",
  UNRESOLVED: "UNRESOLVED",
  NOT_CHECKED: "NOT CHECKED",
};

/** Skip reasons the platform reports; unknown reasons fall back to the raw value. */
export const SKIP_REASON_LABELS: Record<string, string> = {
  invalid_path: "Invalid path",
  not_in_listing: "Not in repository listing",
  secret_path: "Secret-looking path",
  symlink: "Symlink",
  submodule: "Submodule",
  too_large: "Too large",
  binary: "Binary file",
  contains_private_key: "Contains a private key",
  file_limit: "File-count limit reached",
  byte_limit: "Byte limit reached",
  deadline: "Inspection deadline reached",
  unreadable: "Unreadable",
};

export const ESTABLISHES_LABELS: Record<ClaimEstablishes, string> = {
  existence: "Establishes only that matching files/code exist — not what they do.",
  nothing: "Establishes nothing about this claim.",
};

export const LISTING_LABELS: Record<InspectionSummary["listing"], string> = {
  complete: "complete",
  truncated: "truncated (absence proves nothing)",
  unavailable: "unavailable (no repository access)",
};

export const INDEX_STATE_LABELS: Record<"used" | "building_elsewhere" | "backoff" | "no_revision" | "rejected" | "failed" | "disabled", string> = {
  used: "repository index in use",
  building_elsewhere: "the repository index was being built by another analysis",
  backoff: "a recent repository index build failed",
  no_revision: "the repository revision could not be determined",
  rejected: "a stored repository index did not match this revision and was not used",
  failed: "the repository index could not be built",
  disabled: "no repository index is configured",
};

export const VERIFICATION_STATE_LABELS: Record<"not_run" | "passed" | "failed" | "timed_out" | "infrastructure_error" | "rejected", string> = {
  not_run: "not run",
  passed: "passed",
  failed: "failed",
  timed_out: "timed out",
  infrastructure_error: "could not start",
  rejected: "refused",
};

export const RECONCILIATION_LABELS: Record<"IMPLEMENTATION_PRESENT" | "IMPLEMENTATION_POSSIBLE" | "UNRESOLVED" | "NO_CONFLICT" | "CHECK_VERIFIED", string> = {
  IMPLEMENTATION_PRESENT: "Implementation evidence conflicts with the reported absence",
  IMPLEMENTATION_POSSIBLE: "Related code may conflict with the reported absence",
  UNRESOLVED: "Not resolved by the evidence",
  NO_CONFLICT: "No conflict",
  CHECK_VERIFIED: "Verified by a platform check bound to this claim",
};

export const USAGE_STATUS_LABELS: Record<"complete" | "partial" | "unavailable", string> = {
  complete: "complete",
  partial: "partial — at least one run failed or reported nothing, so totals are lower bounds",
  unavailable: "unavailable",
};
