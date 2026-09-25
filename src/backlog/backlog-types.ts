import type { CostMetadata } from "../domain/types.js";

/**
 * Phase 4A — Backlog Intelligence Foundation (see /docs/BACKLOG_INTELLIGENCE.md).
 *
 * A `BacklogItem` is "something the engineering team wants CodeForge to understand"; a `Task` is
 * "something CodeForge has approved for execution." They are deliberately separate concepts with
 * separate tables — a backlog item becomes a Task only through an explicit, human-approved
 * `TaskProposal` conversion that goes through the existing `TaskService.create` path.
 *
 * AI output is a PROPOSAL. Every status in this file is decided by platform code
 * (backlog-state-machine.ts + BacklogService), never by anything a model returns.
 */

export type BacklogItemStatus =
  | "NEW"
  | "ANALYZING"
  | "ANALYZED"
  | "NEEDS_CLARIFICATION"
  | "READY_FOR_TASK"
  | "CONVERTED"
  | "REJECTED";

/** Provenance only. `"import"` is reserved for Phase 4B (bulk import) — nothing in this phase's HTTP API can set it. */
export type BacklogSource = "manual" | "import";

export interface BacklogItem {
  id: string;
  projectId: string;
  /** Optional caller-supplied reference (e.g. "BUG-002"), unique per project when present. */
  externalRef: string | null;
  title: string;
  description: string;
  source: BacklogSource;
  status: BacklogItemStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AI analysis (proposal) + platform-owned checks
// ---------------------------------------------------------------------------

export type IssueType = "bug" | "feature" | "improvement" | "chore" | "question" | "unknown";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface AnalysisCandidateFile {
  path: string;
  reason: string;
}

export interface AnalysisRelationshipCandidate {
  /** Reference to ANOTHER backlog item — matched (exactly) against a sibling's `externalRef` or `id`. */
  ref: string;
  confidence: ConfidenceLevel;
  rationale: string;
}

export interface AnalysisMissingInformation {
  question: string;
  /** True when the item cannot responsibly become a task until this is answered. */
  blocking: boolean;
}

// ---------------------------------------------------------------------------
// Claims (AI) vs evidence (platform) — Phase 4A.2
// ---------------------------------------------------------------------------

/**
 * What KIND of statement about the repository the model is making — a small closed set the platform can
 * check deterministically. Free-form prose ("I verified X") is never a claim the platform trusts; a claim
 * exists only in this structured form, and its status is derived by the platform from platform-obtained
 * evidence (evidence.ts), never from anything the model says about itself.
 */
export type ClaimKind =
  | "FILE_EXISTS" // "a file exists at `path`"
  | "FILE_ABSENT" // "no file exists at `path`"
  | "FEATURE_ABSENT" // "nothing in the repository implements <statement> (search terms …)"
  | "FEATURE_PRESENT" // "something in the repository implements <statement> (search terms …)"
  | "BEHAVIOR_CORRECT" // "<statement> is implemented correctly" — cannot be established by inspection
  | "BEHAVIOR_INCORRECT"; // "<statement> is implemented incorrectly" — likewise

export interface AnalysisClaim {
  /** The claim in the model's words. Untrusted text; never interpreted as evidence. */
  statement: string;
  kind: ClaimKind;
  /** The file the claim is about, when it names one. */
  path: string | null;
  /** Distinctive terms the platform may search for (paths, then file contents). A hit needs ≥ min(2, n) of them. */
  searchTerms: string[];
  /** The model's own stated confidence in THIS claim. It never overrides evidence. */
  confidence: ConfidenceLevel;
}

/**
 * Only kinds of evidence this platform can actually obtain. They sit on different rungs, and the rung is
 * part of what each one means — a higher rung never follows from a lower one:
 *  - EXISTENCE   FILE_EXISTS / FILE_NOT_FOUND / PATH_MATCH (the listing), CONTENT_MATCH (file content the
 *                platform read), SYMBOL_MATCH (a declaration/route the revision-bound repository index
 *                extracted). "Something with this name is in that file at that revision."
 *  - BEHAVIOR    not obtainable by inspection. A behaviour claim is UNRESOLVED however much exists.
 *  - EXECUTION   CHECK_RESULT: the project's own configured check (build/test/lint/typecheck) was run by the
 *                platform at an exact revision and returned this outcome. It says the CHECK passed or
 *                failed — not that the code satisfies any particular claim (checks are not bound to claims).
 * STRUCTURE (Phase 4A.4): SYMBOL_REFERENCE — in a file the platform READ, a declared name is also used elsewhere
 *  ("getProfileDeleteBlocker declared L6, referenced L121"). It shows the declaration is wired into something; it
 *  is still not evidence of what that code does. Import/route data from the index otherwise only RANKS files
 *  (see index-selection.ts); it is never evidence for or against a claim on its own.
 */
export type EvidenceType = "FILE_EXISTS" | "FILE_NOT_FOUND" | "PATH_MATCH" | "CONTENT_MATCH" | "SYMBOL_MATCH" | "SYMBOL_REFERENCE" | "CHECK_RESULT";
export type EvidenceSource = "repository_listing" | "repository_content" | "repository_index" | "platform_check";

/**
 * One fact the PLATFORM itself obtained (from the repository listing, or by reading a file's content
 * within the inspection budget). Never written from model output.
 */
export interface PlatformEvidence {
  /** Stable within one assessment ("E1", "E2", …). */
  id: string;
  type: EvidenceType;
  source: EvidenceSource;
  path: string | null;
  /** Bounded, secret-masked. For CONTENT_MATCH: the 1-based line number and a short excerpt. */
  detail: string | null;
  /** The claim search terms this evidence matched (PATH_MATCH / CONTENT_MATCH / SYMBOL_MATCH). */
  matchedTerms: string[];
  /** The exact commit this evidence describes (index symbols, content read from that revision, check results). Reconciliation refuses evidence whose revision differs from the analysed one. */
  revision?: string | null;
}

/**
 * The deterministic relationship between one claim and the evidence gathered for it:
 *  SUPPORTED    — platform evidence establishes what the claim says (e.g. "file X exists" + FILE_EXISTS).
 *  CONTRADICTED — platform evidence establishes the opposite (e.g. "nothing implements X" + a matching path).
 *  UNRESOLVED   — the evidence does not decide it. In particular EXISTENCE never proves BEHAVIOR, and a
 *                 bounded search that finds nothing never proves absence.
 *  NOT_CHECKED  — the platform could not check it (e.g. no repository access).
 */
export type ClaimStatus = "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED" | "NOT_CHECKED";

/**
 * WHAT a claim's status actually establishes — decided by the platform from the claim kind and the
 * outcome, never by the model. The point: the model picks the claim `kind`, and a behavioural sentence
 * mislabelled as FEATURE_PRESENT must not read as "the platform confirmed the sentence". The status
 * always comes with this scope:
 *  - `existence`: only that a matching file / code EXISTS (or does not, on a complete listing) — nothing about what it does;
 *  - `nothing`: the evidence established nothing about the claim (UNRESOLVED / NOT_CHECKED, and every behaviour claim).
 */
export type ClaimEstablishes = "existence" | "nothing";

export interface ClaimAssessment {
  claimIndex: number;
  statement: string;
  kind: ClaimKind;
  aiConfidence: ConfidenceLevel;
  status: ClaimStatus;
  /** What this status does and does not establish (see ClaimEstablishes). */
  establishes: ClaimEstablishes;
  evidenceIds: string[];
  /** Platform-written, deterministic explanation of why this status — never model text. */
  reason: string;
}

/** What the platform did and did not look at — so "not found" is never mistaken for "does not exist". */
export interface InspectionSummary {
  /** `complete`: every file in the repository was listed; `truncated`: a capped prefix (absence proves nothing); `unavailable`: no repository access. */
  listing: "complete" | "truncated" | "unavailable";
  filesRead: number;
  bytesRead: number;
  /** Files the platform declined to read, with the reason (secret path, too large, symlink, binary, budget, …). */
  filesSkipped: Array<{ path: string; reason: string }>;
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
}

/**
 * A verification the PLATFORM decided would bear on a claim, and where it stands. `checkId` is always one of
 * the project's own approved, configured checks (never model-supplied text); `not_run` is the only state
 * analysis produces today — running checks during analysis is disabled by policy (see verification.ts).
 */
export type VerificationState = "not_run" | "passed" | "failed" | "timed_out" | "infrastructure_error" | "rejected";

export interface VerificationRequirement {
  claimIndex: number;
  checkId: "build" | "test" | "lint" | "typecheck";
  /**
   * True only if the project's verification contract explicitly BINDS this check to this claim (a check that
   * exercises exactly what the claim asserts). Nothing sets it today — checks are project-wide — so a passing
   * check can never become `CHECK_VERIFIED` (see reconciliation.ts).
   */
  bindsClaim?: boolean;
  state: VerificationState;
  /** Platform-written explanation (why it was not run / what the outcome does and does not show). */
  reason: string;
  /** The CHECK_RESULT evidence, once a check actually ran. */
  evidenceId: string | null;
}

/**
 * Deterministic reconciliation of an AI claim with platform evidence (Phase 4A.4) — a THIRD object, distinct from
 * both the claim and the evidence (see reconciliation.ts):
 *  IMPLEMENTATION_PRESENT  strong platform evidence that what the claim says is absent EXISTS in this revision
 *                          (declared and wired in). NOT "fixed" and NOT "correct" — behaviour is not verified.
 *  IMPLEMENTATION_POSSIBLE weaker evidence (matching names/content, or a claim labelled as behaviour that asserts an
 *                          absence): worth a human look, not a conclusion.
 *  UNRESOLVED              the evidence does not decide it (behaviour claims always land here).
 *  NO_CONFLICT             the claim does not assert an absence, or evidence agrees with it.
 *  CHECK_VERIFIED          a platform-run check, explicitly bound to this claim, passed at this revision.
 */
export type ReconciliationOutcome = "IMPLEMENTATION_PRESENT" | "IMPLEMENTATION_POSSIBLE" | "UNRESOLVED" | "NO_CONFLICT" | "CHECK_VERIFIED";

export interface ReconciliationFinding {
  claimIndex: number;
  statement: string;
  /** What the platform decided the claim IS (independent of the `kind` the model chose): asserts an absence, a behaviour, or a presence. */
  claimClass: "implementation_absence" | "behavior" | "presence";
  /** True when the model labelled an absence as a BEHAVIOR_* claim (the platform still recognises the wording). */
  labelledAsBehavior: boolean;
  outcome: ReconciliationOutcome;
  strength: "strong" | "weak" | null;
  evidenceIds: string[];
  /** Platform-written. */
  explanation: string;
  /** Always false unless `outcome === "CHECK_VERIFIED"`. */
  behaviorVerified: boolean;
}

export interface Reconciliation {
  /** The revision the evidence was reconciled against. Evidence carrying any other revision was ignored. */
  revision: string | null;
  findings: ReconciliationFinding[];
  /**
   * "Implementation evidence conflicts with the reported absence": `strong` (an absence claim directly contradicted
   * by declared-and-wired-in code), `possible` (weaker conflict), `none`. Never means "bug fixed".
   */
  alreadyImplemented: "strong" | "possible" | "none";
  /** True only if some claim is CHECK_VERIFIED. */
  behaviorVerified: boolean;
  /** Evidence ids that were NOT used because they describe a different revision. */
  ignoredEvidence: Array<{ id: string; reason: string }>;
}

export interface EvidenceAssessment {
  /** Phase 4A.4 — the deterministic reconciliation pass over claims + evidence. Absent on older analyses. */
  reconciliation?: Reconciliation;
  /** Verification the platform judged relevant to behaviour claims. Absent on analyses recorded before it existed. */
  verification?: VerificationRequirement[];
  evidence: PlatformEvidence[];
  claims: ClaimAssessment[];
  summary: { supported: number; contradicted: number; unresolved: number; notChecked: number };
  /** True when the model was `high` confidence about a claim the platform's evidence CONTRADICTS. Exposed, never silently downgraded. */
  confidenceOverridden: boolean;
  inspection: InspectionSummary;
}

/** The strictly-validated structure a model must return — see analysis-schema.ts. Everything here is a claim, never authoritative. */
export interface AnalysisResult {
  summary: string;
  issueType: IssueType;
  affectedApplication: string | null;
  suspectedArea: string | null;
  candidateFiles: AnalysisCandidateFile[];
  duplicateCandidates: AnalysisRelationshipCandidate[];
  dependencyCandidates: AnalysisRelationshipCandidate[];
  missingInformation: AnalysisMissingInformation[];
  suggestedAcceptanceCriteria: string[];
  suggestedValidation: string[];
  confidence: { overall: ConfidenceLevel; uncertainties: string[] };
  /**
   * Structured, checkable statements about the repository (see AnalysisClaim). Optional in the model's
   * output (defaults to none) so analyses stored before Phase 4A.2 still validate.
   */
  claims: AnalysisClaim[];
}

/** Platform-computed verification of the model's claims — `existsInRepository` is `null` when no repository listing was available to check against. */
export interface PlatformChecks {
  candidateFiles: Array<{ path: string; existsInRepository: boolean | null }>;
  /** `ref` values the model returned that matched no sibling backlog item (dropped, never persisted as relationships). */
  unresolvedReferences: string[];
  /** Relationship proposals the platform dropped, with the reason (self-reference, would-create-cycle). */
  droppedRelationships: Array<{ ref: string; kind: BacklogRelationshipKind; reason: string }>;
  context: AnalysisContextSummary;
  /** Phase 4A.2 — platform evidence and the deterministic assessment of each AI claim. Absent on analyses recorded before it existed. */
  assessment?: EvidenceAssessment;
}

/** What the bounded context builder actually gave the model — counts and flags only, never content. */
export interface AnalysisContextSummary {
  projectContextIncluded: boolean;
  repositoryStructure: "included" | "truncated" | "unavailable";
  repositoryFileCount: number | null;
  repositoryPathsIncluded: number;
  /** File CONTENT excerpts placed in the prompt (Phase 4A.2), and how many bytes of source they came from. */
  contentFilesIncluded?: number;
  contentBytesRead?: number;
  /** Phase 4A.3 — whether the revision-bound repository index informed file selection, and how the platform chose what to show the model. */
  index?: IndexSummary;
  selection?: SelectionSummary;
  siblingItemsIncluded: number;
  siblingItemsOmitted: number;
  promptChars: number;
}

/** What the repository index contributed to ONE analysis — counts and the state only, never index content. */
export interface IndexSummary {
  state: "used" | "building_elsewhere" | "backoff" | "no_revision" | "rejected" | "failed" | "disabled";
  /** The commit the analysis viewed (and, when `used`, the index describes). */
  revision: string | null;
  /** True when this very attempt built the index (first analysis of this revision). */
  built: boolean;
  files: number | null;
  contentIndexedFiles: number | null;
  symbols: number | null;
  /** False when the index is partial (a build limit stopped content indexing early, or the listing was capped). */
  complete: boolean | null;
  reason: string | null;
}

export interface SelectionSummary {
  /** `index`: ranked by name + symbols + routes + feature + imports; `name`: file names only (no usable index). */
  method: "index" | "name";
  /** Files the platform put on the ranked list shown to the model. */
  rankedFiles: number;
  /** The top of the ranking, with why — deterministic platform output, not AI. */
  top: Array<{ path: string; score: number; reasons: string[] }>;
  /** Files whose content excerpts were placed in the prompt. */
  excerptPaths: string[];
}

export type AnalysisStatus = "succeeded" | "failed";

// ---------------------------------------------------------------------------
// Analysis JOBS (Phase 4A.1) — the unit of *work*, separate from the result above
// ---------------------------------------------------------------------------

export type AnalysisJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

/**
 * One queued/claimed/retried request to analyze a backlog item, executed ONLY by a worker process
 * (never inside an API request). The result of a finished job is a `BacklogAnalysis` row referenced
 * by `analysisId`. See migrations/014_backlog_analysis_jobs.sql and /docs/BACKLOG_INTELLIGENCE.md
 * "Analysis worker".
 */
export interface BacklogAnalysisJob {
  id: string;
  backlogItemId: string;
  projectId: string;
  status: AnalysisJobStatus;
  requestedBy: string;
  /** Claims so far, crash-recovery claims included; bounded by `maxAttempts`. */
  attemptCount: number;
  maxAttempts: number;
  /** Earliest time a worker may claim a QUEUED job (backoff after a retryable failure). */
  availableAt: string;
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  lockGeneration: number;
  cancelRequestedAt: string | null;
  /** The most recent failure — a scheduled retry's cause, or the terminal cause. Redacted + bounded. */
  failureCategory: AnalysisFailureCategory | null;
  failureReason: string | null;
  /** Routing decision of the most recent attempt. */
  modelId: string | null;
  providerId: string | null;
  /** Set once terminal, when a result row was recorded. */
  analysisId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type AnalysisFailureCategory =
  | "malformed_output"
  | "engine_error"
  | "timeout"
  | "no_model_available"
  | "cancelled"
  | "context_error"
  | "interrupted";

export interface BacklogAnalysis {
  id: string;
  backlogItemId: string;
  projectId: string;
  status: AnalysisStatus;
  failureCategory: AnalysisFailureCategory | null;
  /** Human-readable, redacted and bounded. `null` for a succeeded analysis. */
  failureReason: string | null;
  /** Non-null only for `status = "succeeded"`. */
  result: AnalysisResult | null;
  platformChecks: PlatformChecks | null;
  /** Bounded, redacted diagnostics for a FAILED analysis (e.g. an excerpt of the malformed output) — never secrets. */
  diagnostics: Record<string, unknown> | null;
  /** The platform's own routing decision (never the model's) — the seam future usage/cost accounting reads. */
  modelId: string | null;
  providerId: string | null;
  engineKey: string | null;
  fallbackIndex: number;
  routingReason: string | null;
  cost: CostMetadata | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Relationship proposals (duplicates / dependencies)
// ---------------------------------------------------------------------------

export type BacklogRelationshipKind = "POSSIBLE_DUPLICATE" | "DEPENDS_ON";

/**
 * `PROPOSED` is the only status this phase produces. `CONFIRMED`/`DISMISSED` are reserved for the
 * human/platform workflow of a later phase (4C) and are persisted-but-unreachable today, the same
 * documented-placeholder posture `OrchestratorFailureCategory.recoverable_crash` already takes.
 */
export type BacklogRelationshipStatus = "PROPOSED" | "CONFIRMED" | "DISMISSED";

/** Directional: for `DEPENDS_ON`, `fromItemId` depends on `toItemId`; for `POSSIBLE_DUPLICATE`, `fromItemId`'s analysis flagged `toItemId`. */
export interface BacklogRelationship {
  /** Deterministic: derived from (kind, fromItemId, toItemId) — see backlog-relationship-repository.ts. */
  id: string;
  projectId: string;
  fromItemId: string;
  toItemId: string;
  kind: BacklogRelationshipKind;
  status: BacklogRelationshipStatus;
  confidence: ConfidenceLevel;
  rationale: string;
  analysisId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Task proposal
// ---------------------------------------------------------------------------

export type TaskProposalStatus = "PENDING" | "APPROVED" | "CONVERTING" | "CONVERTED" | "REJECTED";

export interface TaskProposalDependency {
  backlogItemId: string;
  ref: string | null;
  title: string;
  confidence: ConfidenceLevel;
  rationale: string;
}

/**
 * Everything a human needs to decide whether this backlog item should become a Task — built
 * deterministically by the platform from a validated analysis (task-proposal-builder.ts), never
 * written by a model directly. Re-validated against `TaskProposalContentSchema` immediately before
 * conversion, so a corrupted/hand-edited row can never become a Task.
 */
export interface TaskProposalContent {
  title: string;
  /** The exact text that becomes `Task.goal` on conversion. */
  goal: string;
  summary: string;
  issueType: IssueType;
  affectedApplication: string | null;
  suspectedArea: string | null;
  candidateFiles: Array<{ path: string; reason: string; existsInRepository: boolean | null }>;
  acceptanceCriteria: string[];
  validation: string[];
  /** Informational only in this phase — never turned into executable Task dependencies (that is Phase 4C's decision). */
  dependencies: TaskProposalDependency[];
  duplicateWarnings: TaskProposalDependency[];
  uncertainty: { overall: ConfidenceLevel; uncertainties: string[]; missingInformation: AnalysisMissingInformation[] };
  /** Phase 4A.2 — how the platform's own evidence relates to each AI claim (see ClaimAssessment). */
  claimAssessments: Array<{
    statement: string;
    kind: ClaimKind;
    aiConfidence: ConfidenceLevel;
    status: ClaimStatus;
    establishes: ClaimEstablishes;
    reason: string;
    evidence: string[];
  }>;
  /** True when a claim the proposal would rest on is CONTRADICTED by platform evidence — the task is then framed as an investigation. */
  investigateFirst: boolean;
  /** Phase 4A.4 — the reconciliation signal carried into the proposal: implementation evidence conflicts with a reported absence. Never "fixed". */
  implementationConflict: "strong" | "possible" | "none";
}

export interface TaskProposal {
  id: string;
  backlogItemId: string;
  projectId: string;
  analysisId: string;
  status: TaskProposalStatus;
  /**
   * `null` only when the stored JSON no longer satisfies `TaskProposalContentSchema` (a corrupted or
   * hand-edited row). Such a proposal can still be viewed and rejected, but it can never be
   * approved or converted — see BacklogService. Never a best-effort partial reconstruction.
   */
  content: TaskProposalContent | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** Set only once the proposal is CONVERTED. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Audit / observability
// ---------------------------------------------------------------------------

export type BacklogEventType =
  | "BACKLOG_ITEM_CREATED"
  | "BACKLOG_ITEM_UPDATED"
  | "BACKLOG_ITEM_REJECTED"
  | "ANALYSIS_QUEUED"
  | "ANALYSIS_STARTED"
  | "ANALYSIS_RETRY_SCHEDULED"
  | "ANALYSIS_COMPLETED"
  | "ANALYSIS_FAILED"
  | "ANALYSIS_CANCELLED"
  | "TASK_PROPOSAL_GENERATED"
  | "TASK_PROPOSAL_APPROVED"
  | "TASK_PROPOSAL_REJECTED"
  | "TASK_PROPOSAL_CONVERTED";

export interface BacklogEvent {
  id: string;
  projectId: string;
  backlogItemId: string;
  type: BacklogEventType;
  /** Structured, non-secret payload — never credentials, never raw model output. */
  payload: Record<string, unknown>;
  createdAt: string;
}
