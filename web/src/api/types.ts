/**
 * Wire types for the backend API, hand-kept in sync with /docs/API.md.
 * These are plain data shapes, not business logic — the frontend never
 * re-derives task status or lifecycle rules; it only renders what the API
 * returns. See /docs/UI_ARCHITECTURE.md "API integration".
 */

export type TaskStatus = "BACKLOG" | "TODO" | "WORKING" | "NEEDS_INPUT" | "REVIEW" | "DONE" | "FAILED" | "CANCELLED";

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

/** Build/test/lint/typecheck commands a project has declared — see ProjectSettingsPage. A check
 *  with no declared command here is skipped (not failed) by the backend's validation runner. */
export interface ProjectCommands {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
}

/** One repository connected to a project. A monorepo project has one; a split codebase has several. */
export interface ProjectRepoDTO {
  id: string;
  projectId: string;
  /** Short label, unique within the project ("frontend", "backend"). */
  name: string;
  repoUrl: string;
  defaultBranch: string;
  sourceControlProvider: string;
  owner: string | null;
  repo: string | null;
  commands: ProjectCommands | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDTO {
  id: string;
  name: string;
  /** Every connected repository, primary first. Empty until the first one is connected. */
  repositories: ProjectRepoDTO[];
  /** The fields below describe the PRIMARY repository (empty strings when there is none). */
  repoUrl: string;
  defaultBranch: string;
  codingEngine: string;
  sourceControlProvider: string;
  /** Non-null only for sourceControlProvider = "github". */
  owner: string | null;
  repo: string | null;
  commandsDeclared: string[];
  commands: ProjectCommands | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDTO {
  id: string;
  projectId: string;
  /** The project repository this task works in. */
  repositoryId?: string | null;
  /** Its name — only on GET /tasks/:id (the detail screen), where no project list is loaded. */
  repositoryName?: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  currentActivity: string;
  selfFixAttempts: number;
  branchName: string | null;
  branchMode: "new" | "existing";
  workingBranch: string | null;
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** True only while WORKING with a cancellation requested but not yet confirmed. */
  cancelRequested: boolean;
  /** Set once cancellation was requested — who asked for it to stop. */
  cancelledBy: string | null;
  /** Set once independent review approves and the platform opens/finds the PR. */
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  /** The latest commit produced for this task, if any. */
  commitSha: string | null;
  /** This task's explicit, user-defined dependencies — see /docs/TASK_LIFECYCLE.md "Task dependencies". Derived/read-only; never edited by writing this field directly. */
  dependencies: DependencyStatusDTO[];
}

/** One dependency, as embedded on TaskDTO or returned by GET/POST/DELETE /tasks/:taskId/dependencies. */
export interface DependencyStatusDTO {
  id: string;
  title: string;
  status: TaskStatus;
  /** True only when this dependency's own status is DONE. */
  satisfied: boolean;
}

export type TaskEventType =
  | "TASK_CREATED"
  | "TASK_RELEASED"
  | "TASK_CLAIMED"
  | "TASK_STARTED"
  | "WORKSPACE_CREATED"
  | "WORKSPACE_FAILED"
  | "AGENT_STARTED"
  | "AGENT_COMPLETED"
  | "AGENT_FAILED"
  | "VALIDATION_STARTED"
  | "VALIDATION_COMPLETED"
  | "RETRY_STARTED"
  | "REVIEW_STARTED"
  | "REVIEW_COMPLETED"
  | "REVIEW_CHANGES_REQUESTED"
  | "NEEDS_INPUT_RAISED"
  | "NEEDS_INPUT_ANSWERED"
  | "TASK_MOVED_TO_REVIEW"
  | "TASK_ACCEPTED"
  | "TASK_CHANGES_REQUESTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "CANCEL_REQUESTED"
  | "EXECUTION_CANCELLED"
  | "WORKSPACE_CLEANUP_STARTED"
  | "WORKSPACE_CLEANUP_COMPLETED"
  | "TASK_CANCELLED"
  | "BRANCH_CREATED"
  | "COMMIT_CREATED"
  | "BRANCH_PUSHED"
  | "PULL_REQUEST_CREATED"
  | "SOURCE_CONTROL_FAILED"
  | "NO_CHANGES_DETECTED"
  | "HUMAN_REVIEW_DETECTED"
  | "HUMAN_REVIEW_CHANGES_REQUESTED"
  | "HUMAN_REVIEW_APPROVED"
  | "PULL_REQUEST_MERGED"
  /**
   * Appended when an in-flight execution discovers it no longer holds the
   * task's execution lease (see /docs/TASK_LIFECYCLE.md "Worker
   * concurrency and lease loss") — distinct from TASK_FAILED (a genuine
   * platform failure) and TASK_CANCELLED (a human-requested stop). Task
   * status and workspace are deliberately left untouched.
   */
  | "EXECUTION_LEASE_LOST"
  /**
   * Phase 4D.2 — appended by ActionLayerService after a Chat-driven mutation (create/edit/start/cancel)
   * has already succeeded and been read back and verified. Shows up in the SAME task history the Tasks
   * UI reads, never a parallel Chat-only history.
   */
  | "CHAT_ACTION_PERFORMED";

export interface TaskEventDTO {
  id: string;
  type: TaskEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface InputOption {
  label: string;
  description: string;
}

export interface HumanAnswer {
  selectedOption: string | null;
  freeText: string;
}

export interface HumanInputRequestDTO {
  id: string;
  status: "open" | "answered";
  discovered: string;
  attempted: string[];
  blocker: string;
  question: string;
  options: InputOption[];
  answer: HumanAnswer | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface TaskReport {
  title: string;
  whatWasWrong: string;
  whatChanged: string;
  filesChanged: number;
  checks: Array<{ name: string; passed: boolean }>;
  reviewFindings: Array<{ severity: string; category: string; summary: string }>;
  /** The Reviewer's own prose assessment (Markdown) — shown alongside reviewFindings, which stay empty unless the engine emits structured findings. */
  reviewSummary: string | null;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  pullRequest: { url: string | null; number: number | null; branch: string | null; baseBranch: string } | null;
  commitSha: string | null;
  /** Present only when status is FAILED. */
  failureReason: string | null;
  agentRuns: AgentRunHistoryItemDTO[];
  /** GAP-031 — absent on a backend older than the roll-up. */
  usage?: TaskUsageRollup;
  durations: ExecutionDurationsDTO;
  recoveredFromCrash: boolean;
  failureContext: FailureContextDTO | null;
  /** V1.1 Slice 4 — e.g. "timeout", "provider_quota_exhausted", "task_failure". Present only on FAILED tasks. */
  failureCategory?: string | null;
  /** V1.1 Slice 4 — every infrastructure failure this task hit and tried to recover from. */
  infrastructureFailures?: Array<{ attempt: number; category: string; retryable: boolean; reason: string; detectedAt: string }>;
  /** V1.1 Slice 3 — platform-captured reproduction/fix-verification evidence; null for tasks without a contract. */
  bugFixVerification?: {
    contract: { checkId: string; bugPresentWhenCheckOutcome: "failed" | "passed"; purpose: string | null };
    reproduction: { status: string; commitSha: string | null; exitCode: number | null } | null;
    fixVerification: { status: string; commitSha: string | null; exitCode: number | null } | null;
  } | null;
}

export type AgentRunTrigger = "initial" | "self_fix_retry" | "ai_review_fix" | "human_review_fix" | "review" | "review_verification";
export type AgentRunStatus = "running" | "completed" | "failed" | "timeout" | "cancelled" | "interrupted";

/** Each field is null when no run reported it — never 0 for "unknown". */
export interface UsageNumbers {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface ProviderReportedEstimateTotal {
  amount: number;
  currency: string;
  runsCovered: number;
  runsWithoutEstimate: number;
  /** Who computed the figure (an engine estimate, not a provider invoice). */
  sources: string[];
}

/** Task-level usage: every AgentRun counted once. `codeforgeCalculatedCost` is always null (no CodeForge pricing source). */
export type UsageStatus = "complete" | "partial" | "unavailable";

export interface TaskUsageRollup {
  /** `partial` = at least one run failed/ended abnormally or has no usage: the totals are lower bounds. Absent on an older backend. */
  usageStatus?: UsageStatus;
  runsCounted: number;
  runsWithUsage: number;
  totals: UsageNumbers;
  /** Input + output + reasoning over the runs that reported usage; null when none did. Absent on an older backend. */
  totalTokens?: number | null;
  providerReportedEstimate: ProviderReportedEstimateTotal | null;
  codeforgeCalculatedCost: null;
  byPhase: Record<"implementation" | "fix" | "review" | "verification", { runs: number; totals: UsageNumbers; providerReportedEstimate: ProviderReportedEstimateTotal | null }>;
  runs: Array<{
    runId: string;
    role: "implementer" | "reviewer";
    phase: "implementation" | "fix" | "review" | "verification";
    attemptNumber: number;
    providerId: string | null;
    modelId: string | null;
    usage: UsageNumbers | null;
    usageStatus?: UsageStatus;
    providerReportedEstimate: { amount: number; currency: string; pricingSource: string; pricingVersion: string | null } | null;
  }>;
}

export interface AgentRunHistoryItemDTO {
  id: string;
  role: "implementer" | "reviewer";
  attemptNumber: number;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  startedAt: string;
  completedAt: string | null;
  summary: string | null;
  filesChanged: string[];
  confidence: "high" | "medium" | "low" | null;
  findings: Array<{ severity: string; category: string; summary: string }> | null;
  verdict: "approved" | "rejected" | null;
  error: string | null;
  humanReviewFeedback: { reviewerLogin: string; comments: string } | null;
  resumedAfterInterruption: boolean;
  /** V1.1 Slice 5 — the platform's own routing decision; null when no model was routed. */
  modelId?: string | null;
  providerId?: string | null;
  fallbackIndex?: number;
}

export interface ExecutionDurationsDTO {
  totalMs: number | null;
  implementationMs: number | null;
  reviewMs: number | null;
  validationMs: number | null;
  waitingForHumanReviewMs: number | null;
}

export interface FailureContextDTO {
  stage: string;
  failedRole: "implementer" | "reviewer" | null;
  attemptNumber: number | null;
  recoveredFromCrash: boolean;
}

interface CreateProjectCommon {
  name: string;
  defaultBranch?: string;
  codingEngine?: string;
  commands?: { build?: string; test?: string; lint?: string; typecheck?: string };
}

export interface CreateGitHubProjectInput extends CreateProjectCommon {
  sourceControlProvider: "github";
  owner: string;
  repo: string;
}

export interface CreateLocalGitProjectInput extends CreateProjectCommon {
  sourceControlProvider: "local-git";
  repoUrl: string;
}

/** A project with no repository yet — repositories are connected afterwards in Project Settings. */
export interface CreateEmptyProjectInput {
  name: string;
}

export type CreateProjectInput = CreateGitHubProjectInput | CreateLocalGitProjectInput | CreateEmptyProjectInput;

/** POST /projects/:id/repositories. `name` defaults to the repository's own name. */
export type AddRepositoryInput =
  | { sourceControlProvider: "github"; name?: string; owner: string; repo: string; defaultBranch?: string }
  | { sourceControlProvider: "local-git"; name?: string; repoUrl: string; defaultBranch?: string };

/** POST /projects/verify-github-repo response — see ProjectService.verifyGitHubRepositoryUrl. */
export interface VerifyGitHubRepositoryResult {
  repoUrl: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Auto-suggested project name (the repository name) — always editable, never forced. */
  suggestedName: string;
}

export type BranchMode = "new" | "existing";

export interface CreateTaskInput {
  /** Required when the project has several repositories; optional with exactly one. */
  repositoryId?: string;
  title: string;
  description: string;
  branchMode?: BranchMode;
  /** Mode "new" only: an optional custom branch name (else auto-derived from the task title). */
  branchName?: string;
  /** Mode "new" only: overrides the project's default branch as the branch to create from. */
  baseBranch?: string;
  /** Mode "existing" only: the branch to work directly on — required when branchMode is "existing". */
  existingBranch?: string;
  /** Explicit, user-selected dependency task ids — create only (see /docs/TASK_LIFECYCLE.md "Task dependencies"). Ignored by the edit endpoint; dependency edits go through the dedicated add/remove endpoints instead. */
  dependencyIds?: string[];
}

/** POST /tasks/:taskId/edit — same field set/validation as task creation. See TaskService.editBacklogTask. */
export type EditTaskInput = CreateTaskInput;

export type MergeState = "READY" | "BEHIND" | "CONFLICT" | "MERGED" | "CLOSED_NOT_MERGED" | "NOT_APPLICABLE" | "UNKNOWN";

/** GET /tasks/:id/branch-state — detection only (never remediation): the platform never auto-rebases/merges. */
export interface BranchStateDTO {
  aheadBy: number | null;
  behindBy: number | null;
  comparable: boolean;
  mergeState: MergeState;
}

/**
 * GET /projects/:projectId/workspace response — Phase 3 "Project Workspace" (Slice 1, backend).
 * This is a distinct concept from a task execution's ephemeral working directory
 * (see src/workspace/*) — a ProjectWorkspace is a durable, project-scoped record.
 * There is no separate "status" field on this DTO yet; existence of the row is the signal.
 */
export interface ProjectWorkspaceDTO {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET/PUT /projects/:projectId/context — Phase 3 "Project Context Manifest" (Slice 5; `revision`
 * added in Slice 7). Mirrors the backend's validated manifest shape (see
 * src/project-workspace/project-context-manifest.ts). `revision` is optimistic-concurrency
 * bookkeeping only — the editor UI never lets a user edit it directly, and it is never rendered
 * into the AI Context Preview (see lib/projectContextPreview.ts). A `PUT` is a full replacement
 * (no partial update) and must echo back the `revision` most recently loaded — see
 * ProjectContextPanel.
 */
export interface ProjectContextDTO {
  version: number;
  revision: number;
  project: { name: string; description?: string };
  instructions: string[];
  architecture: string[];
  conventions: string[];
  validation: { commands: string[] };
  constraints: string[];
  /** Server-computed timestamp of the last successful save — null only for a manifest persisted
   *  before this field existed. Never client-supplied; see ProjectContextPanel's "Last updated". */
  updatedAt: string | null;
}

/** GET/POST /integrations/github — never includes the token itself. */
export interface GitHubConnectionDTO {
  connected: boolean;
  githubLogin: string | null;
  connectedAt: string | null;
}

// ---------------------------------------------------------------------------
// Phase 4A — Backlog Intelligence (mirrors src/api/backlog-dto.ts and src/backlog/backlog-types.ts)
// ---------------------------------------------------------------------------

export type BacklogItemStatus = "NEW" | "ANALYZING" | "ANALYZED" | "NEEDS_CLARIFICATION" | "READY_FOR_TASK" | "CONVERTED" | "REJECTED";
export type IssueType = "bug" | "feature" | "improvement" | "chore" | "question" | "unknown";
export type ConfidenceLevel = "high" | "medium" | "low";
export type AnalysisStatus = "succeeded" | "failed";
export type AnalysisFailureCategory =
  | "malformed_output"
  | "engine_error"
  | "timeout"
  | "no_model_available"
  | "cancelled"
  | "context_error"
  | "interrupted";
export type AnalysisJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type BacklogRelationshipKind = "POSSIBLE_DUPLICATE" | "DEPENDS_ON";
export type BacklogRelationshipStatus = "PROPOSED" | "CONFIRMED" | "DISMISSED";
export type TaskProposalStatus = "PENDING" | "APPROVED" | "CONVERTING" | "CONVERTED" | "REJECTED";
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

export interface BacklogItemDTO {
  id: string;
  projectId: string;
  /** The project repository this item concerns. */
  repositoryId?: string | null;
  externalRef: string | null;
  title: string;
  description: string;
  source: "manual" | "import";
  status: BacklogItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BacklogItemSummaryDTO extends BacklogItemDTO {
  review?: ReviewSummary;
  latestAnalysis: { id: string; status: AnalysisStatus; completedAt: string } | null;
  proposal: { id: string; status: TaskProposalStatus; taskId: string | null } | null;
}

export interface AnalysisMissingInformation {
  question: string;
  /** True when the item cannot responsibly become a task until this is answered. */
  blocking: boolean;
}

export type ClaimKind = "FILE_EXISTS" | "FILE_ABSENT" | "FEATURE_ABSENT" | "FEATURE_PRESENT" | "BEHAVIOR_CORRECT" | "BEHAVIOR_INCORRECT";
export type EvidenceType = "FILE_EXISTS" | "FILE_NOT_FOUND" | "PATH_MATCH" | "CONTENT_MATCH" | "SYMBOL_MATCH" | "SYMBOL_REFERENCE" | "CHECK_RESULT";
export type ClaimStatus = "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED" | "NOT_CHECKED";

/** A structured assertion the MODEL made about the repository — never evidence. */
export interface AnalysisClaim {
  statement: string;
  kind: ClaimKind;
  path: string | null;
  searchTerms: string[];
  confidence: ConfidenceLevel;
}

/** A fact CodeForge itself obtained from the repository. */
export interface PlatformEvidence {
  id: string;
  type: EvidenceType;
  source: "repository_listing" | "repository_content" | "repository_index" | "platform_check";
  path: string | null;
  detail: string | null;
  matchedTerms: string[];
  /** The exact commit the evidence describes (index symbols, check results). */
  revision?: string | null;
}

/** What a status actually establishes, decided by the platform; missing on older records (treat as "nothing"). */
export type ClaimEstablishes = "existence" | "nothing";

export interface ClaimAssessment {
  claimIndex: number;
  statement: string;
  kind: ClaimKind;
  aiConfidence: ConfidenceLevel;
  status: ClaimStatus;
  establishes?: ClaimEstablishes;
  evidenceIds: string[];
  /** Written by the platform (deterministic), not by the model. */
  reason: string;
}

export interface InspectionSummary {
  listing: "complete" | "truncated" | "unavailable";
  filesRead: number;
  bytesRead: number;
  filesSkipped: Array<{ path: string; reason: string }>;
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
}

export type VerificationState = "not_run" | "passed" | "failed" | "timed_out" | "infrastructure_error" | "rejected";

/** A check the PLATFORM judged relevant to a behaviour claim. Analysis never runs it today (`not_run`). */
export interface VerificationRequirement {
  claimIndex: number;
  claimId?: string;
  /** The project's approved claim check bound to this claim. */
  checkId: string;
  state: VerificationState;
  reason: string;
  evidenceId: string | null;
}

export type ReconciliationOutcome = "IMPLEMENTATION_PRESENT" | "IMPLEMENTATION_POSSIBLE" | "UNRESOLVED" | "NO_CONFLICT" | "CHECK_VERIFIED" | "CHECK_CONTRADICTED";

/** The platform's own conclusion about how ONE AI claim relates to ONE body of platform evidence. Never "fixed"; never behaviour unless a bound check passed. */
export interface ReconciliationFinding {
  claimIndex: number;
  statement: string;
  claimClass: "implementation_absence" | "behavior" | "presence";
  labelledAsBehavior: boolean;
  outcome: ReconciliationOutcome;
  strength: "strong" | "weak" | null;
  evidenceIds: string[];
  explanation: string;
  behaviorVerified: boolean;
  /** Approved checks that could verify this claim (bound by the platform); empty ⇒ behaviour stays unverified. */
  availableChecks?: string[];
  claimId?: string;
  verificationId?: string | null;
}

export type BehaviorStatus = "BEHAVIOR_UNVERIFIED" | "CHECK_VERIFIED";

export type InvestigationSignal = "IMPLEMENTATION_PRESENT" | "POSSIBLY_ALREADY_IMPLEMENTED" | "NO_CONFLICTING_IMPLEMENTATION_EVIDENCE" | "UNRESOLVED";

/** The platform's own investigation of the item's premise — independent of the AI's claims; behaviour is always unverified here. */
export type FlowStatus = "FLOW_REFERENCE_PRESENT" | "FLOW_NOT_ESTABLISHED" | "ENTRY_POINT_NOT_LOCATED";

/** Static flow evidence for the item's entry point — a name-reference path, never a proven call path. */
export interface InvestigationFlow {
  status: FlowStatus;
  entries: Array<{ route: string; file: string; handlers: string[]; located: "named_in_item" | "inferred_from_subject" }>;
  path: Array<{ kind: "ROUTE_TO_HANDLER" | "DIRECT_REFERENCE" | "IMPORT_REFERENCE"; symbol: string; file: string }>;
  evidenceIds: string[];
}

export interface Investigation {
  flow?: InvestigationFlow;
  revision: string | null;
  premise: { kind: "absence" | "permissive"; mechanism: string; subjectTerms: string[] } | null;
  signal: InvestigationSignal;
  behavior: BehaviorStatus;
  candidates: Array<{ path: string; symbol: string | null; subjectHits: string[]; wiredIn: string | null; evidenceIds: string[] }>;
  filesRead: number;
  explanation: string;
}

export type ReviewState = "NEEDS_ANALYSIS" | "NEEDS_CLARIFICATION" | "POSSIBLY_ALREADY_IMPLEMENTED" | "VERIFIED_CONFLICT" | "READY_FOR_PROPOSAL";

/** Implementation and behaviour are two facts, never one: "present" does not mean "fixed". */
export interface ReviewSummary {
  state: ReviewState | null;
  implementation: "present" | "possible" | "none_found" | "unknown";
  behavior: BehaviorStatus;
}

export interface ClaimVerificationDTO {
  id: string;
  claimId: string;
  claimIndex: number;
  checkId: string;
  revision: string;
  state: VerificationState;
  exitCode: number | null;
  durationMs: number;
  command: string;
  logExcerpt: string | null;
  createdAt: string;
  jobId?: string | null;
  executor?: string | null;
  workspaceId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  timedOut?: boolean;
}

export type VerificationJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";

/** The EXECUTION of one verification. It never says a claim is verified — only a bound, passed record does. */
export interface ClaimVerificationJobDTO {
  id: string;
  analysisId: string;
  claimId: string;
  claimIndex: number;
  checkId: string;
  revision: string;
  status: VerificationJobStatus;
  attemptCount: number;
  maxAttempts: number;
  cancelRequested: boolean;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Reconciliation {
  revision: string | null;
  findings: ReconciliationFinding[];
  alreadyImplemented: "strong" | "possible" | "none";
  behaviorVerified: boolean;
  ignoredEvidence: Array<{ id: string; reason: string }>;
  implementation?: "present" | "possible" | "none";
  implementationSources?: Array<"claim" | "investigation">;
  behavior?: BehaviorStatus;
  ignoredVerifications?: Array<{ id: string; reason: string }>;
}

export interface EvidenceAssessment {
  /** Absent on analyses recorded before reconciliation existed. */
  reconciliation?: Reconciliation;
  /** Absent on analyses recorded before the platform investigated premises. */
  investigation?: Investigation;
  /** Absent on analyses recorded before verification planning existed. */
  verification?: VerificationRequirement[];
  /** Relevant approved checks with the platform's SUFFICIENCY verdict; an insufficient check can never verify the claim. */
  verificationCandidates?: Array<{ claimIndex: number; claimId: string; checkId: string; claimClass: string; relevance: "not_relevant" | "relevant"; sufficiency: "sufficient" | "insufficient"; reason: string }>;
  evidence: PlatformEvidence[];
  claims: ClaimAssessment[];
  summary: { supported: number; contradicted: number; unresolved: number; notChecked: number };
  confidenceOverridden: boolean;
  inspection: InspectionSummary;
}

/** Each field is null when the engine did not report it — never 0 for "unknown". */
export interface BacklogAnalysisTokenFields {
  /** Tokens this analysis used — reported, or estimated (`estimated: true`); null if neither. */
  tokenCount?: TokenCountDTO | null;
}

export interface BacklogAnalysisUsageDTO {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** An estimate computed by `pricingSource` — not provider-billed. */
export interface EstimatedCost {
  amount: number;
  currency: string;
  pricingSource: string;
  pricingVersion: string | null;
}

/** The model's validated PROPOSAL — claims, not facts. See PlatformChecks for what the platform verified. */
export interface AnalysisResult {
  summary: string;
  issueType: IssueType;
  affectedApplication: string | null;
  suspectedArea: string | null;
  candidateFiles: Array<{ path: string; reason: string }>;
  duplicateCandidates: Array<{ ref: string; confidence: ConfidenceLevel; rationale: string }>;
  dependencyCandidates: Array<{ ref: string; confidence: ConfidenceLevel; rationale: string }>;
  missingInformation: AnalysisMissingInformation[];
  suggestedAcceptanceCriteria: string[];
  suggestedValidation: string[];
  confidence: { overall: ConfidenceLevel; uncertainties: string[] };
  /** Absent on analyses recorded before claims existed. */
  claims?: AnalysisClaim[];
}

export interface AnalysisContextSummary {
  projectContextIncluded: boolean;
  repositoryStructure: "included" | "truncated" | "unavailable";
  repositoryFileCount: number | null;
  repositoryPathsIncluded: number;
  /** How the revision-bound repository index contributed (absent on older analyses). */
  index?: {
    state: "used" | "building_elsewhere" | "backoff" | "no_revision" | "rejected" | "failed" | "disabled";
    revision: string | null;
    built: boolean;
    files: number | null;
    contentIndexedFiles: number | null;
    symbols: number | null;
    complete: boolean | null;
    reason: string | null;
  };
  selection?: { method: "index" | "name"; rankedFiles: number; top: Array<{ path: string; score: number; reasons: string[] }>; excerptPaths: string[] };
  siblingItemsIncluded: number;
  siblingItemsOmitted: number;
  promptChars: number;
}

export interface PlatformChecks {
  /** `existsInRepository` is null when no repository listing was available to check against. */
  candidateFiles: Array<{ path: string; existsInRepository: boolean | null }>;
  unresolvedReferences: string[];
  droppedRelationships: Array<{ ref: string; kind: BacklogRelationshipKind; reason: string }>;
  context: AnalysisContextSummary;
  /** Absent on analyses recorded before platform evidence existed. */
  assessment?: EvidenceAssessment;
}

export interface BacklogAnalysisDTO extends BacklogAnalysisTokenFields {
  id: string;
  backlogItemId: string;
  status: AnalysisStatus;
  failureCategory: AnalysisFailureCategory | null;
  failureReason: string | null;
  result: AnalysisResult | null;
  platformChecks: PlatformChecks | null;
  diagnostics: Record<string, unknown> | null;
  modelId: string | null;
  providerId: string | null;
  engineKey: string | null;
  fallbackIndex: number;
  routingReason: string | null;
  usage: BacklogAnalysisUsageDTO | null;
  estimatedCost: EstimatedCost | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
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

export interface TaskProposalDependency {
  backlogItemId: string;
  ref: string | null;
  title: string;
  confidence: ConfidenceLevel;
  rationale: string;
}

export interface TaskProposalContent {
  title: string;
  /** The exact text that becomes the task's description on conversion. */
  goal: string;
  summary: string;
  issueType: IssueType;
  affectedApplication: string | null;
  suspectedArea: string | null;
  candidateFiles: Array<{ path: string; reason: string; existsInRepository: boolean | null }>;
  acceptanceCriteria: string[];
  validation: string[];
  dependencies: TaskProposalDependency[];
  duplicateWarnings: TaskProposalDependency[];
  uncertainty: { overall: ConfidenceLevel; uncertainties: string[]; missingInformation: AnalysisMissingInformation[] };
  /** Absent on proposals created before claim assessment existed. */
  claimAssessments?: Array<{
    statement: string;
    kind: ClaimKind;
    aiConfidence: ConfidenceLevel;
    status: ClaimStatus;
    establishes?: ClaimEstablishes;
    reason: string;
    evidence: string[];
  }>;
  investigateFirst?: boolean;
  /** Implementation evidence conflicts with a reported absence. Absent on older proposals. Never means "fixed". */
  implementationConflict?: "strong" | "possible" | "none";
}

export interface TaskProposalDTO {
  id: string;
  backlogItemId: string;
  analysisId: string;
  status: TaskProposalStatus;
  /** null only for a stored proposal whose content no longer validates — it can be rejected but never approved/converted. */
  content: TaskProposalContent | null;
  decidedAt: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BacklogEventDTO {
  id: string;
  type: BacklogEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Mirrors BacklogAnalysisJobDTO — the queued/running/terminal state of the background analysis. */
export interface BacklogAnalysisJobDTO {
  id: string;
  status: AnalysisJobStatus;
  attemptCount: number;
  maxAttempts: number;
  /** For a QUEUED job: in the future ⇒ a retry backoff is pending. */
  availableAt: string;
  cancelRequested: boolean;
  failureCategory: AnalysisFailureCategory | null;
  failureReason: string | null;
  modelId: string | null;
  providerId: string | null;
  analysisId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BacklogItemDetailDTO {
  item: BacklogItemDTO;
  review?: ReviewSummary;
  claimVerifications?: ClaimVerificationDTO[];
  verificationJobs?: ClaimVerificationJobDTO[];
  latestAnalysis: BacklogAnalysisDTO | null;
  analysisJob: BacklogAnalysisJobDTO | null;
  analysisCount: number;
  relationships: BacklogRelationshipDTO[];
  proposal: TaskProposalDTO | null;
  events: BacklogEventDTO[];
}

export interface CreateBacklogItemInput {
  title: string;
  description: string;
  externalRef?: string;
}

export interface UpdateBacklogItemInput {
  title?: string;
  description?: string;
  /** null clears the reference. */
  externalRef?: string | null;
  /** Moves the item to another repository of the project — resets it to New for re-analysis. */
  repositoryId?: string;
}

export interface ConvertProposalResult {
  proposal: TaskProposalDTO;
  task: TaskDTO;
  alreadyConverted: boolean;
}

// ---------------------------------------------------------------------------
// Phase 4B — bulk backlog
// ---------------------------------------------------------------------------

export interface ImportPreviewRow {
  rowNumber: number;
  status: "ACCEPTED" | "REJECTED";
  reason: string | null;
  detail: string | null;
  sourceKey: string | null;
  title: string | null;
  warnings: string[];
}

export interface ImportPreviewDTO {
  headers: string[];
  mapping: { fields: Record<string, string>; metadataColumns: string[]; unnamedColumns: number };
  rows: ImportPreviewRow[];
  totalRows: number;
  accepted: number;
  rejected: number;
  alreadyImported: number;
  warnings: string[];
  errors: string[];
}

export interface BacklogImportDTO {
  id: string;
  sourceName: string;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  alreadyImportedRows: number;
  createdAt: string;
}

export type BulkStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";

export interface BulkViewDTO {
  job: { id: string; importId: string | null; totalItems: number; cancelRequestedAt: string | null; createdAt: string };
  status: BulkStatus;
  counts: { total: number; queued: number; running: number; completed: number; failed: number; cancelled: number; skipped: number };
  members: Array<{ backlogItemId: string; disposition: "QUEUED" | "REUSED" | "SKIPPED"; reason: string | null; ref: string | null; title: string | null; jobStatus: string | null }>;
}

export type ReviewFilterKey = "all" | "needs_analysis" | "analysis_ready" | "possibly_implemented" | "needs_clarification" | "duplicate" | "dependency" | "ready_for_proposal" | "verified" | "unverified" | "failed";

export interface ReviewRowDTO {
  itemId: string;
  ref: string | null;
  title: string;
  status: BacklogItemStatus;
  module: string | null;
  priority: string | null;
  analysis: { state: "NONE" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"; failureCategory: string | null; failureReason: string | null; completedAt: string | null };
  review: ReviewSummary;
  flow: "FLOW_REFERENCE_PRESENT" | "FLOW_NOT_ESTABLISHED" | "ENTRY_POINT_NOT_LOCATED" | null;
  evidenceCount: number;
  verification: { checksAvailable: number; sufficientChecks: number; verified: boolean };
  duplicates: { proposed: number; confirmed: number };
  dependencies: { proposed: number; confirmed: number };
  proposal: { id: string; status: string; taskId: string | null } | null;
  usage: { inputTokens: number | null; outputTokens: number | null; estimatedCost: { amount: number; currency: string; pricingSource: string } | null; status: "reported" | "partial" | "unavailable" };
}

export interface BulkUsageDTO {
  analyses: number;
  withReportedUsage: number;
  unavailable: number;
  partial: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: Array<{ currency: string; amount: number; analysesWithEstimate: number; pricingSources: string[] }>;
}

export interface BulkReviewDTO {
  rows: ReviewRowDTO[];
  counts: Record<ReviewFilterKey, number>;
  total: number;
  usage: BulkUsageDTO;
}

export interface BacklogGroupsDTO {
  duplicateGroups: Array<{ items: Array<{ id: string; ref: string | null; title: string }>; edges: Array<{ id: string; fromItemId: string; toItemId: string; confidence: string; status: string; rationale: string }> }>;
  dependencies: Array<{ id: string; from: { id: string; ref: string | null; title: string }; to: { id: string; ref: string | null; title: string }; confidence: string; status: string; rationale: string }>;
}

export type BulkActionKey = "generate_proposals" | "approve_proposals" | "reject_proposals" | "convert_proposals" | "dismiss_duplicates";

export interface BulkActionResultDTO {
  results: Array<{ itemId: string; ok: boolean; detail: string | null; taskId?: string | null }>;
  ok: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Phase 4B.1 — human ground-truth adjudication
// ---------------------------------------------------------------------------

export type RelationshipJudgmentLabel = "CONFIRMED_DUPLICATE" | "RELATED_NOT_DUPLICATE" | "REJECTED";
export type ClarificationLabel = "CORRECT_CLARIFICATION" | "SHOULD_BE_PROPOSAL_READY" | "INSUFFICIENT_ANALYSIS" | "OTHER";
export type ProposalReadinessLabel = "CORRECT_PROPOSAL_READY" | "NEEDS_CLARIFICATION" | "INSUFFICIENT_ANALYSIS" | "OTHER";
export type ReviewJudgmentCategory = "CLARIFICATION" | "PROPOSAL_READINESS";

export interface RelationshipJudgmentDTO {
  id: string;
  relationshipId: string;
  fromItemId: string;
  toItemId: string;
  analysisId: string;
  revision: string | null;
  aiConfidence: string;
  label: RelationshipJudgmentLabel;
  reviewerId: string;
  note: string | null;
  createdAt: string;
}

export interface ItemJudgmentDTO {
  id: string;
  backlogItemId: string;
  analysisId: string;
  revision: string | null;
  category: ReviewJudgmentCategory;
  aiReviewState: string | null;
  label: ClarificationLabel | ProposalReadinessLabel;
  reviewerId: string;
  note: string | null;
  createdAt: string;
}

export interface SampledEdgeDTO {
  relationshipId: string;
  fromItemId: string;
  toItemId: string;
  confidence: string;
  status: string;
  rationale: string;
  analysisId: string;
  revision: string | null;
  current: RelationshipJudgmentDTO | null;
  history: RelationshipJudgmentDTO[];
}

export interface SampledGroupDTO {
  groupKey: string;
  items: Array<{ id: string; ref: string | null; title: string }>;
  edges: SampledEdgeDTO[];
}

export interface InfrastructureFailureDTO {
  itemId: string;
  ref: string | null;
  title: string | null;
  failureCategory: string | null;
  failureReason: string | null;
}

export interface DuplicateSampleDTO {
  seed: string;
  size: number;
  totalGroups: number;
  groups: SampledGroupDTO[];
  infrastructureFailures: InfrastructureFailureDTO[];
}

export interface SampledItemDTO {
  row: ReviewRowDTO;
  current: ItemJudgmentDTO | null;
  history: ItemJudgmentDTO[];
  stale: boolean;
}

export interface ItemSampleDTO {
  seed: string;
  size: number;
  totalCandidates: number;
  sampled: SampledItemDTO[];
  infrastructureFailures: InfrastructureFailureDTO[];
}

export interface AdjudicationMetricsDTO {
  duplicates: { groupsReviewed: number; totalGroups: number; relationshipsReviewed: number; staleRelationships: number; confirmedDuplicate: number; relatedNotDuplicate: number; rejected: number; confirmationRate: number | null };
  clarification: { reviewed: number; stale: number; correctClarification: number; shouldBeProposalReady: number; insufficientAnalysis: number; other: number };
  proposalReadiness: { reviewed: number; stale: number; correctProposalReady: number; needsClarification: number; insufficientAnalysis: number; other: number };
}

export interface LabelCountsDTO {
  duplicateLabelCount: number;
  clarificationLabelCount: number;
  proposalReadinessLabelCount: number;
  validLabelCount: number;
  staleLabelCount: number;
  humanLabelCount: number;
}

// ---------------------------------------------------------------------------
// Phase 4B.2 — human-filled CSV import and baseline snapshots
// ---------------------------------------------------------------------------

export type ImportRowOutcome = "IMPORTED" | "BLANK" | "INVALID_LABEL" | "MALFORMED_ROW" | "UNKNOWN_KIND" | "WRONG_PROJECT" | "NOT_FOUND";

export interface AdjudicationImportSummaryDTO {
  totalRows: number;
  imported: number;
  blank: number;
  invalidLabel: number;
  malformedRow: number;
  wrongProject: number;
  notFound: number;
  results: Array<{ rowNumber: number; outcome: ImportRowOutcome; detail: string | null }>;
}

export type ReviewCategoryStatus = "NOT_REVIEWED" | "IN_PROGRESS" | "REVIEWED";

export interface BaselineMetricsDTO {
  duplicates: { candidateGroups: number; sampledGroups: number; sampledEdges: number; reviewedEdges: number; unreviewedEdges: number; staleEdges: number; labelDistribution: Record<string, number>; confirmationRate: number | null; status: ReviewCategoryStatus };
  clarification: { candidateCount: number; sampledCount: number; reviewedCount: number; unreviewedCount: number; staleCount: number; labelDistribution: Record<string, number>; status: ReviewCategoryStatus };
  proposalReadiness: { candidateCount: number; sampledCount: number; reviewedCount: number; unreviewedCount: number; staleCount: number; labelDistribution: Record<string, number>; status: ReviewCategoryStatus };
  coverage: { labelsCollected: number; staleLabels: number; sampledTotal: number; notYetReviewed: number };
  limitations: string[];
}

export interface BaselineSampleDTO {
  runId: string | null;
  duplicateGroups: Array<{ groupKey: string; edgeIds: string[] }>;
  clarificationItemIds: string[];
  proposalReadyItemIds: string[];
  analysisIds: string[];
  infrastructureFailures: InfrastructureFailureDTO[];
  requestedSampleSizes: { duplicateSize: number; clarificationSize: number; proposalReadySize: number };
  actualSampleSizes: { duplicateGroups: number; duplicateEdges: number; clarificationItems: number; proposalReadyItems: number };
}

export interface BaselineDTO {
  id: string;
  projectId: string;
  version: number;
  seed: string;
  sourceName: string | null;
  repositoryRevisions: string[];
  models: string[];
  sample: BaselineSampleDTO;
  metrics: BaselineMetricsDTO;
  established: boolean;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Phase 4C — Chat
// ---------------------------------------------------------------------------

export interface ChatMessageDTO {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  attachment: { filename: string; mimeType: string; byteSize: number } | null;
  bulkJobId: string | null;
  createdAt: string;
  /** Assistant replies: tokens used — 0 when answered from CodeForge data with no model call, null when unknown. */
  tokens?: number | null;
  /** True when `tokens` is a ~4-characters-per-token estimate rather than engine-reported. */
  tokensEstimated?: boolean;
}

/** A token count and whether it was reported by the engine or estimated by CodeForge. */
export interface TokenCountDTO {
  tokens: number;
  estimated: boolean;
}

/** Tokens for one kind of operation this month. */
export interface UsageBucketDTO {
  tokens: number;
  estimatedTokens: number;
  unreported: number;
  operations: number;
}

/** Monthly (calendar month, UTC) token meter against an optional budget. */
export interface TokenMeterDTO {
  periodStart: string;
  used: number;
  estimatedTokens: number;
  unreportedOperations: number;
  budget: number | null;
  remaining: number | null;
  percentUsed: number | null;
}

export interface ProjectTokenUsageDTO extends TokenMeterDTO {
  projectId: string;
  breakdown: { tasks: UsageBucketDTO; analyses: UsageBucketDTO; chat: UsageBucketDTO };
}

export interface AccountTokenUsageDTO extends TokenMeterDTO {
  projects: Array<{ projectId: string; name: string; used: number; estimatedTokens: number; budget: number | null }>;
}

export interface ChatAttachmentDTO {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

/**
 * A mutation Chat has proposed and is waiting on an explicit yes/no reply for. Confirm/Decline just send
 * the same "yes"/"no" text through sendMessage — never a second mutation endpoint. Phase 4D.3 introduced
 * the bulk variants; Phase 4D.4 added the single-task human-confirmed completion variant.
 */
export type ChatPendingActionDTO =
  | { kind: "BULK_CANCEL" | "BULK_START"; status: TaskStatus; taskIds: string[]; titles: string[]; createdAt: string }
  | { kind: "HUMAN_MARK_DONE"; taskId: string; taskTitle: string; observedStatus: TaskStatus; createdAt: string }
  | { kind: "UPLOAD_TASK_CREATION"; importId: string; itemIds: string[]; filterDescription: string; titles: string[]; createdAt: string };

export interface SendChatMessageResponseDTO {
  userMessage: ChatMessageDTO;
  assistantMessage: ChatMessageDTO;
  pendingAction: ChatPendingActionDTO | null;
}

/** A subset of the existing bulk-review row (see ReviewRow on the backend) — only what Chat's suggestion card needs. */
export interface ChatSuggestionDTO {
  itemId: string;
  ref: string | null;
  title: string;
  status: BacklogItemStatus;
  proposal: { id: string; status: TaskProposalStatus; taskId: string | null } | null;
}

export interface CreateTasksFromChatResponseDTO {
  createdTaskIds: string[];
  results: Array<{ itemId: string; ok: boolean; detail: string | null; taskId?: string }>;
}

/** GET /settings/ai-model — read-only. See src/api/routes/ai-model.ts's own doc comment for why this is deliberately narrow. */
export interface AiModelInfoDTO {
  configured: boolean;
  models: Array<{ modelId: string; providerId: string; engineKey: string }>;
  autoDescription: string;
}

// ---------------------------------------------------------------------------
// Model Gateway — Settings -> AI / Models (see docs/MODEL_GATEWAY.md)
// ---------------------------------------------------------------------------

export type AiProviderId = "google" | "anthropic" | "openai";

/** The provider's API key is write-only — never included here. */
export interface ProviderConnectionDTO {
  provider: AiProviderId;
  connected: boolean;
  model: string | null;
  status: "connected" | "disconnected" | "error";
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface GlobalAiConfigDTO {
  mode: "auto" | "fixed";
  fixedProvider: AiProviderId | null;
  fixedModel: string | null;
  autoAllowed: Array<{ provider: AiProviderId; allowed: boolean; connected: boolean }>;
}

export interface ProviderUsageTotalsDTO {
  providerId: string;
  runsWithUsage: number;
  runsTotal: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}
