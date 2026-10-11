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
  /** Phase 4B: the import this item came from, its source row, and bounded inert metadata (module, priority, platform, …). Data only. */
  importId?: string | null;
  sourceRow?: number | null;
  metadata?: Record<string, string> | null;
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
  /** Stable content hash of the claim this requirement is bound to (see verification.ts `claimIdOf`). */
  claimId?: string;
  /** The project's APPROVED claim check (`ApprovedClaimCheck.id`) the platform matched to this claim. Never model-supplied. */
  checkId: string;
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
 *  CHECK_VERIFIED          a platform-run APPROVED check, explicitly bound to this claim (id + fingerprint), passed at this
 *                          revision, and its declared semantics establish what the claim says.
 *  CHECK_CONTRADICTED      the same, for an absence-worded BEHAVIOR_INCORRECT claim: the check verified the OPPOSITE behaviour.
 */
export type ReconciliationOutcome = "IMPLEMENTATION_PRESENT" | "IMPLEMENTATION_POSSIBLE" | "UNRESOLVED" | "NO_CONFLICT" | "CHECK_VERIFIED" | "CHECK_CONTRADICTED";

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
  /** True only for CHECK_VERIFIED / CHECK_CONTRADICTED — a bound approved check actually established behaviour. */
  behaviorVerified: boolean;
  /** Stable id of the claim (content hash) — what a verification is bound to. */
  claimId?: string;
  /** The approved checks that COULD verify this claim (bound by the platform from the project's own declared checks); empty ⇒ behaviour stays BEHAVIOR_UNVERIFIED. */
  availableChecks?: string[];
  /** The verification record that produced a CHECK_* outcome. */
  verificationId?: string | null;
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
  /** True only if some claim is CHECK_VERIFIED / CHECK_CONTRADICTED. */
  behaviorVerified: boolean;
  /** Evidence ids that were NOT used because they describe a different revision. */
  ignoredEvidence: Array<{ id: string; reason: string }>;
  /**
   * The combined implementation-presence conclusion (Phase 4A.5): the strongest of what the CLAIMS reconcile to and what
   * the platform's own INVESTIGATION found. `present` = declared-and-wired-in implementation evidence conflicts with a
   * reported absence; `possible` = weaker; `none` = nothing found. Independent of, and never implying, behaviour.
   */
  implementation?: "present" | "possible" | "none";
  implementationSources?: Array<"claim" | "investigation">;
  behavior?: BehaviorStatus;
  /** Verification records that were IGNORED (stale revision, changed check, different claim…), with why. */
  ignoredVerifications?: Array<{ id: string; reason: string }>;
}

export type BehaviorStatus = "BEHAVIOR_UNVERIFIED" | "CHECK_VERIFIED";

/**
 * The platform's OWN investigation of a backlog item's premise (Phase 4A.5), done from the item text and the
 * repository index/content — independent of anything the model claimed. It answers one question: does the repository
 * at this revision already contain an implementation of the mechanism the item says is missing? It never answers
 * whether that implementation WORKS (`behavior` is always BEHAVIOR_UNVERIFIED here).
 *  IMPLEMENTATION_PRESENT                    a declaration naming the mechanism AND the subject exists and is wired in (used)
 *  POSSIBLY_ALREADY_IMPLEMENTED              such names/files exist, but nothing shows them wired in
 *  NO_CONFLICTING_IMPLEMENTATION_EVIDENCE    a premise was recognised and nothing conflicting was found in what was inspected
 *                                            (NOT proof of absence)
 *  UNRESOLVED                                no recognisable premise, or no repository/index to look in
 */
export type InvestigationSignal = "IMPLEMENTATION_PRESENT" | "POSSIBLY_ALREADY_IMPLEMENTED" | "NO_CONFLICTING_IMPLEMENTATION_EVIDENCE" | "UNRESOLVED";

export interface InvestigationCandidate {
  path: string;
  /** The declared name that matched (null for a file matched by its name/path alone). */
  symbol: string | null;
  /** Item words that matched the candidate's name/path. */
  subjectHits: string[];
  /** Where the platform saw it used — a file that references the symbol / imports the file ("path:line"), or null. */
  wiredIn: string | null;
  evidenceIds: string[];
}

/** Static flow evidence tying the item's ENTRY POINT to the mechanism (see flow.ts). A found path is a name-reference path, not a proven call path. */
export interface InvestigationFlow {
  status: "FLOW_REFERENCE_PRESENT" | "FLOW_NOT_ESTABLISHED" | "ENTRY_POINT_NOT_LOCATED";
  entries: Array<{ route: string; file: string; handlers: string[]; located: "named_in_item" | "inferred_from_subject" }>;
  path: Array<{ kind: "ROUTE_TO_HANDLER" | "DIRECT_REFERENCE" | "IMPORT_REFERENCE"; symbol: string; file: string }>;
  evidenceIds: string[];
}

export interface Investigation {
  /** Mechanism existence, entry point and flow are separate facts (Phase 4A.6): `IMPLEMENTATION_PRESENT` now REQUIRES `flow.status === "FLOW_REFERENCE_PRESENT"`. */
  flow?: InvestigationFlow;
  revision: string | null;
  premise: { kind: "absence" | "permissive"; mechanism: string; subjectTerms: string[] } | null;
  signal: InvestigationSignal;
  behavior: BehaviorStatus;
  candidates: InvestigationCandidate[];
  filesRead: number;
  /** Platform-written. */
  explanation: string;
}

/**
 * One execution of ONE approved check for ONE claim at ONE revision (append-only; migration 016). The binding is
 * (claimId, checkId, checkFingerprint, revision): a record only counts if all four still match.
 */
export interface ClaimVerificationRecord {
  id: string;
  analysisId: string;
  claimId: string;
  claimIndex: number;
  checkId: string;
  /** Hash of the check's definition when it ran — a later edit to the check makes an old record stale. */
  checkFingerprint: string;
  /** The analysed revision the claim is about, and the revision the workspace was proven to be at before AND after the run. */
  revision: string;
  headBefore: string | null;
  headAfter: string | null;
  state: VerificationState;
  exitCode: number | null;
  durationMs: number;
  /** The exact command that ran (taken from the project's check, never from a claim). */
  command: string;
  logExcerpt: string | null;
  requestedBy: string;
  createdAt: string;
  /** Phase 4A.6 provenance (null for a record written before verification became a worker job). */
  jobId?: string | null;
  executor?: string | null;
  workspaceId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  timedOut?: boolean;
}

export type VerificationJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";

/** One approved check for one claim of one analysis at one exact revision, executed by the worker. Status describes the EXECUTION only. */
export interface ClaimVerificationJob {
  id: string;
  backlogItemId: string;
  projectId: string;
  analysisId: string;
  claimId: string;
  claimIndex: number;
  checkId: string;
  checkFingerprint: string;
  revision: string;
  status: VerificationJobStatus;
  requestedBy: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  lockGeneration: number;
  cancelRequestedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/** The small, explicit review vocabulary bulk review will use (Phase 4A.5). Derived by the platform; nothing a model returns sets it. */
export type ReviewState =
  | "NEEDS_ANALYSIS"
  | "NEEDS_CLARIFICATION"
  | "POSSIBLY_ALREADY_IMPLEMENTED"
  | "VERIFIED_CONFLICT"
  | "READY_FOR_PROPOSAL";

export interface ReviewSummary {
  /** `null` once the item has left review (proposal approved, converted or rejected). */
  state: ReviewState | null;
  /** Two orthogonal facts, never merged: an implementation can be present while behaviour is unverified. */
  implementation: "present" | "possible" | "none_found" | "unknown";
  behavior: BehaviorStatus;
}

export interface EvidenceAssessment {
  /** Phase 4A.4 — the deterministic reconciliation pass over claims + evidence. Absent on older analyses. */
  reconciliation?: Reconciliation;
  /** Phase 4A.5 — the platform's own investigation of the item's premise, independent of the model's claims. Absent on older analyses. */
  investigation?: Investigation;
  /** Verification the platform judged relevant to behaviour claims. Absent on analyses recorded before it existed. */
  verification?: VerificationRequirement[];
  /** Relevant approved checks per behaviour claim with the platform's SUFFICIENCY verdict (Phase 4A.7). A check listed here as insufficient can never verify the claim. */
  verificationCandidates?: Array<{ claimIndex: number; claimId: string; checkId: string; claimClass: string; relevance: "not_relevant" | "relevant"; sufficiency: "sufficient" | "insufficient"; reason: string }>;
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
  | "TASK_PROPOSAL_CONVERTED"
  | "CLAIM_VERIFICATION_QUEUED"
  | "CLAIM_VERIFICATION_RUN"
  | "BACKLOG_ITEM_IMPORTED"
  | "BULK_ANALYSIS_QUEUED"
  | "RELATIONSHIP_CONFIRMED"
  | "RELATIONSHIP_DISMISSED";

export interface BacklogEvent {
  id: string;
  projectId: string;
  backlogItemId: string;
  type: BacklogEventType;
  /** Structured, non-secret payload — never credentials, never raw model output. */
  payload: Record<string, unknown>;
  createdAt: string;
}
