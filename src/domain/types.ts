/**
 * Core domain types for the platform's execution model.
 * See /docs/ARCHITECTURE.md and /docs/TASK_LIFECYCLE.md for the reasoning behind this shape.
 */

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** User-visible + terminal task states. Orchestrator-owned; never set by an LLM. */
export type TaskStatus =
  | "TODO"
  | "WORKING"
  | "NEEDS_INPUT"
  | "REVIEW"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

/**
 * The mutable, structured record an agent invocation is built from.
 * This is NOT a transcript: it grows by replacing/appending small structured
 * fields, not by accumulating conversation turns. See CONTEXT_ARCHITECTURE.md.
 */
export interface TaskRecord {
  /** Set once the Implementer has produced an initial plan; reused, not re-derived, on resume. */
  plan: string | null;
  /** Human answers and self-discovered constraints accumulated across the task's life. */
  decisions: Decision[];
  /** Working branch name for this task's changes, once a workspace/source-control step creates it. */
  branchName: string | null;
  /** Ref to the latest diff produced (e.g. a workspace-relative marker or commit sha), if any. */
  latestDiffRef: string | null;
  /** How many implement->validate self-fix iterations have been used in the current WORKING episode. */
  selfFixAttempts: number;
  /** How many times the task has been claimed for a WORKING episode in total (crash-retry included). */
  workingEpisodes: number;
  /**
   * Set exactly once, the first time a Pull Request is successfully opened
   * for this task (after independent review approves) — see
   * /docs/GITHUB_INTEGRATION.md "PR idempotency". Its presence is what makes
   * PR creation idempotent across a crash/retry: if this is already set,
   * the Orchestrator never calls openPullRequest again for this task.
   */
  pullRequest: PullRequestRef | null;
  /**
   * Identifiers (see HumanReviewFeedbackItem.id) of GitHub PR reviews/comments
   * already acted on — the idempotency guard for the human review feedback
   * loop (see /docs/TASK_LIFECYCLE.md "Human review feedback loop"). A
   * repeated poll of the same PR must never trigger a second fix cycle for
   * feedback already recorded here.
   */
  processedHumanFeedbackIds: string[];
  /**
   * Set the moment a human-feedback fix cycle is claimed (REVIEW ->
   * WORKING), before any work starts; cleared the moment that cycle ends
   * (success, NEEDS_INPUT, or failure) — never left set on any status other
   * than WORKING. This is what lets `executeTask` tell, after a crash and
   * restart, that a re-claimed WORKING task must resume the human review
   * feedback fix cycle (not the original implement/validate/review
   * pipeline) — see /docs/TASK_LIFECYCLE.md "Crash recovery". Durable by
   * construction: it's part of the same persisted TaskRecord as everything
   * else here, so it survives a process crash exactly like `pullRequest` or
   * `branchName` already do.
   */
  pendingHumanReviewFeedback: HumanReviewFeedback | null;
}

export interface Decision {
  source: "human_answer" | "discovered";
  summary: string;
  recordedAt: string;
}

export interface Task {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  /** Original plain-language description. Immutable once created. */
  goal: string;
  status: TaskStatus;
  taskRecord: TaskRecord;
  currentAgentRunId: string | null;
  workspaceId: string | null;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * Set the moment a cancellation is requested while WORKING — this is the
   * persisted "cancellation intent" a live execution (possibly in a
   * different process) observes and acts on. Never cleared once set; a task
   * with this set and status still WORKING is "cancelling," not cancelled
   * yet. See /docs/TASK_LIFECYCLE.md "Cancellation".
   */
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
}

// ---------------------------------------------------------------------------
// TaskEvent (append-only audit log / recovery backbone)
// ---------------------------------------------------------------------------

export type TaskEventType =
  | "TASK_CREATED"
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
  | "HUMAN_REVIEW_DETECTED"
  | "HUMAN_REVIEW_CHANGES_REQUESTED"
  | "HUMAN_REVIEW_APPROVED";

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  /** Structured, non-secret payload. Never contains credentials. */
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface ProjectCommands {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
}

export interface Project {
  id: string;
  tenantId: string;
  /** The user who connected this project — the MVP access model is User -> owns -> Project. See /docs/AUTHENTICATION.md. */
  ownerId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  codingEngine: string; // e.g. "claude-code" — provider key, not a hardcoded type
  sourceControlProvider: string; // e.g. "github" | "local-git" — resolves a SourceControlProvider from the registry, same pattern as codingEngine
  /**
   * Repository identity for provider="github" — null for "local-git" (dev/test
   * fixture projects). `repoUrl` is still the canonical clone URL (derived
   * from owner/repo for GitHub); these are kept as explicit, non-secret
   * fields so the platform can display/validate repository identity without
   * re-parsing a URL. See /docs/GITHUB_INTEGRATION.md.
   */
  owner: string | null;
  repo: string | null;
  /** Declared build/test/lint commands. Null/missing fields are discovered pragmatically at runtime. */
  commands: ProjectCommands | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AgentRun (one CodingEngineAdapter invocation)
// ---------------------------------------------------------------------------

export type AgentRole = "implementer" | "reviewer";
export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted"; // crashed mid-run, discovered on recovery

export interface AgentRun {
  id: string;
  taskId: string;
  role: AgentRole;
  engine: string;
  attemptNumber: number;
  status: AgentRunStatus;
  /** Small structured input snapshot (context bundle), not a transcript. */
  input: ContextBundle;
  result: StepResult | null;
  error: string | null;
  cost: CostMetadata | null;
  startedAt: string;
  completedAt: string | null;
}

export interface CostMetadata {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export type WorkspaceStatus = "provisioning" | "ready" | "torn_down" | "failed";

export interface Workspace {
  id: string;
  taskId: string;
  provider: string; // e.g. "local-git" | "docker"
  path: string;
  repoUrl: string;
  branch: string;
  baseCommit: string | null;
  status: WorkspaceStatus;
  createdAt: string;
  destroyedAt: string | null;
}

// ---------------------------------------------------------------------------
// Source control contract (platform <-> SourceControlProvider boundary)
// ---------------------------------------------------------------------------

export interface PullRequestRef {
  provider: string; // e.g. "github" | "local-git"
  /** Provider-native identifier (e.g. GitHub PR number as a string). Opaque to core logic. */
  id: string;
  /** Numeric PR number where the provider has one (GitHub); null otherwise. */
  number: number | null;
  url: string | null;
}

// ---------------------------------------------------------------------------
// Human review feedback (human-in-the-loop PR review, see TASK_LIFECYCLE.md
// "Human review feedback loop")
// ---------------------------------------------------------------------------

/**
 * One piece of human feedback read from the task's PR — a submitted review
 * (with a verdict) or a plain conversation comment. Deliberately small: not
 * a generic GitHub API model, just enough to drive the fix cycle and dedupe
 * repeated polls. `id` is stable and provider-namespaced (e.g. "review:123",
 * "comment:456") so it never collides across kinds.
 */
export interface HumanReviewFeedbackItem {
  id: string;
  kind: "review" | "comment";
  /** Only reviews carry a verdict; a plain comment is null. */
  verdict: "approved" | "changes_requested" | "commented" | null;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

/** What actually reaches the Implementer — see ContextBundle.humanReviewFeedback. */
export interface HumanReviewFeedback {
  reviewerLogin: string;
  /** The actionable review's own body, plus any other new comment bodies appended. */
  comments: string;
}

/**
 * An ephemeral, opaque, per-operation credential a SourceControlProvider
 * hands to the Workspace layer for cloning a private repository — never
 * persisted to the workspace's git config, never exposed to the coding
 * engine. See /docs/GITHUB_INTEGRATION.md "Credential exposure boundary".
 */
export interface GitCredential {
  /** A ready-to-use HTTP header line, e.g. "Authorization: Bearer <token>". Never logged. */
  header: string;
}

// ---------------------------------------------------------------------------
// HumanInputRequest (the NEEDS_INPUT contract)
// ---------------------------------------------------------------------------

export interface InputOption {
  label: string;
  description: string;
}

export type HumanInputRequestStatus = "open" | "answered";

export interface HumanInputRequest {
  id: string;
  taskId: string;
  status: HumanInputRequestStatus;
  discovered: string;
  attempted: string[];
  blocker: string;
  question: string;
  options: InputOption[];
  answer: HumanAnswer | null;
  askedAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
}

export interface HumanAnswer {
  selectedOption: string | null;
  freeText: string;
}

// ---------------------------------------------------------------------------
// User (minimal — see docs/MVP_SCOPE.md: single-tenant, multiple developers)
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  /** scrypt-hashed, never the plaintext password. Never included in any API DTO — see /docs/AUTHENTICATION.md. */
  passwordHash: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Session (server-side, browser-facing auth — see /docs/AUTHENTICATION.md)
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  userId: string;
  /** sha256 of the opaque token sent to the browser — the raw token itself is never persisted. */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

// ---------------------------------------------------------------------------
// Coding Engine contract (platform <-> AI coding engine boundary)
// ---------------------------------------------------------------------------

/** What an agent invocation is given. Built fresh per invocation — never a replayed transcript. */
export interface ContextBundle {
  taskGoal: string;
  taskPlan: string | null;
  priorDecisions: Decision[];
  repoPath: string;
  projectConventionPointer: string;
  /** Present only when this is a retry within the self-fix loop (a validation failure, not a Reviewer rejection). */
  lastFailure: ValidationResult | null;
  /** Present only for role = "reviewer". */
  reviewEvidence: ReviewEvidence | null;
  /**
   * Present only when this is an Implementer retry triggered by an independent
   * Reviewer rejection (the review/fix cycle) — distinct from `lastFailure`,
   * which is a validation-gate failure. Mutually exclusive with `lastFailure`
   * in practice: a review/fix retry follows a *passing* validation run, so
   * there is no validation failure to report alongside it. See
   * /docs/TASK_LIFECYCLE.md "Review/fix cycle".
   */
  reviewerFeedback: ReviewResult | null;
  /**
   * Present only when this is an Implementer retry triggered by a human's
   * GitHub PR review requesting changes (the human review feedback loop) —
   * distinct from both `lastFailure` and `reviewerFeedback`. Mutually
   * exclusive with both in practice: a human feedback retry only ever
   * happens after the task has already reached REVIEW (a passing validation
   * run and an approved independent review). See /docs/TASK_LIFECYCLE.md
   * "Human review feedback loop".
   */
  humanReviewFeedback: HumanReviewFeedback | null;
}

export interface ReviewEvidence {
  implementerSummary: string;
  filesChanged: string[];
  diffRef: string | null;
  validation: ValidationResult;
}

export interface StepResult {
  status: "completed" | "blocked" | "needs_input";
  summary: string;
  filesChanged: string[];
  diffRef: string | null;
  confidence: "high" | "medium" | "low" | null;
  findings: Finding[];
  /** Populated only when status = "needs_input". */
  needsInput: NeedsInputDraft | null;
}

export interface NeedsInputDraft {
  discovered: string;
  attempted: string[];
  blocker: string;
  question: string;
  options: InputOption[];
}

export type FindingSeverity = "blocker" | "concern" | "note";

export interface Finding {
  category: "correctness" | "missing_requirement" | "regression" | "risky_change" | "test_gap" | "security";
  severity: FindingSeverity;
  summary: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Validation contract
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string; // e.g. "build" | "test" | "lint" | "typecheck"
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  logExcerpt: string; // tail of output, bounded in size
}

export interface ValidationResult {
  status: "passed" | "failed";
  checks: CheckResult[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Reviewer contract
// ---------------------------------------------------------------------------

export interface ReviewResult {
  verdict: "approved" | "rejected";
  findings: Finding[];
  confidence: "high" | "medium" | "low";
  summary: string;
}
