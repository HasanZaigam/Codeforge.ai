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

export const RECONCILIATION_LABELS: Record<"IMPLEMENTATION_PRESENT" | "IMPLEMENTATION_POSSIBLE" | "UNRESOLVED" | "NO_CONFLICT" | "CHECK_VERIFIED" | "CHECK_CONTRADICTED", string> = {
  IMPLEMENTATION_PRESENT: "Implementation evidence conflicts with the reported absence",
  IMPLEMENTATION_POSSIBLE: "Related code may conflict with the reported absence",
  UNRESOLVED: "Not resolved by the evidence",
  NO_CONFLICT: "No conflict",
  CHECK_VERIFIED: "Verified by a platform check bound to this claim",
  CHECK_CONTRADICTED: "Contradicted by a verified platform check",
};

export const USAGE_STATUS_LABELS: Record<"complete" | "partial" | "unavailable", string> = {
  complete: "complete",
  partial: "partial — at least one run failed or reported nothing, so totals are lower bounds",
  unavailable: "unavailable",
};

export const REVIEW_STATE_LABELS: Record<"NEEDS_ANALYSIS" | "NEEDS_CLARIFICATION" | "POSSIBLY_ALREADY_IMPLEMENTED" | "VERIFIED_CONFLICT" | "READY_FOR_PROPOSAL", { label: string; tone: string }> = {
  NEEDS_ANALYSIS: { label: "Needs analysis", tone: "neutral" },
  NEEDS_CLARIFICATION: { label: "Needs clarification", tone: "attention" },
  POSSIBLY_ALREADY_IMPLEMENTED: { label: "Possibly already implemented", tone: "info" },
  VERIFIED_CONFLICT: { label: "Verified conflict", tone: "success" },
  READY_FOR_PROPOSAL: { label: "Ready for proposal", tone: "active" },
};

/** Implementation presence is NOT behaviour: these labels never say fixed / working. */
export const IMPLEMENTATION_LABELS: Record<"present" | "possible" | "none_found" | "unknown", string> = {
  present: "Implementation appears present",
  possible: "Implementation possibly present",
  none_found: "No conflicting implementation found",
  unknown: "Implementation not assessed",
};

export const BEHAVIOR_LABELS: Record<"BEHAVIOR_UNVERIFIED" | "CHECK_VERIFIED", string> = {
  BEHAVIOR_UNVERIFIED: "Behavior unverified",
  CHECK_VERIFIED: "Behavior verified by a platform check",
};

export const INVESTIGATION_LABELS: Record<"IMPLEMENTATION_PRESENT" | "POSSIBLY_ALREADY_IMPLEMENTED" | "NO_CONFLICTING_IMPLEMENTATION_EVIDENCE" | "UNRESOLVED", string> = {
  IMPLEMENTATION_PRESENT: "Implementation appears present",
  POSSIBLY_ALREADY_IMPLEMENTED: "Possibly already implemented",
  NO_CONFLICTING_IMPLEMENTATION_EVIDENCE: "No conflicting implementation evidence found (not proof of absence)",
  UNRESOLVED: "Not investigated",
};

/** Job status describes the RUN; "passed" here means the check passed, not that the claim is verified. */
export const VERIFICATION_JOB_LABELS: Record<"QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED", string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Passed",
  FAILED: "Failed",
  TIMED_OUT: "Timed out",
  CANCELLED: "Cancelled",
};

export const FLOW_LABELS: Record<"FLOW_REFERENCE_PRESENT" | "FLOW_NOT_ESTABLISHED" | "ENTRY_POINT_NOT_LOCATED", string> = {
  FLOW_REFERENCE_PRESENT: "Flow reference present (static name-reference path — not a proven call path)",
  FLOW_NOT_ESTABLISHED: "Flow not established (the mechanism was not reached from the entry point)",
  ENTRY_POINT_NOT_LOCATED: "Entry point not located",
};

export const REVIEW_FILTER_LABELS: Record<"all" | "needs_analysis" | "analysis_ready" | "possibly_implemented" | "needs_clarification" | "duplicate" | "dependency" | "ready_for_proposal" | "verified" | "unverified" | "failed", string> = {
  all: "All",
  needs_analysis: "Needs analysis",
  analysis_ready: "Analysis ready",
  possibly_implemented: "Possibly already implemented",
  needs_clarification: "Needs clarification",
  duplicate: "Duplicate candidate",
  dependency: "Dependency candidate",
  ready_for_proposal: "Ready for proposal",
  verified: "Verified",
  unverified: "Unverified",
  failed: "Failed",
};

export const REJECT_REASON_LABELS: Record<string, string> = {
  missing_title: "Missing title",
  missing_description: "Missing description / steps / expected / actual",
  invalid_bug_id: "Unusable bug id",
  duplicate_source_row: "Duplicate source row",
  title_too_long: "Title too long",
  field_too_long: "A field is too long",
  malformed_row: "Malformed row",
};
