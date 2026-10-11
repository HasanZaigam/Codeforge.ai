/**
 * Core domain types for the platform's execution model.
 * See /docs/ARCHITECTURE.md and /docs/TASK_LIFECYCLE.md for the reasoning behind this shape.
 */

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** User-visible + terminal task states. Orchestrator-owned; never set by an LLM. */
export type TaskStatus =
  | "BACKLOG"
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
  /**
   * V1.1 Slice 1 introduced this as an inert extension point; V1.1 Slice 2
   * built the `VerificationEvidence` primitive it now reuses; V1.1 Slice 3
   * makes it real (see PLATFORM_GAPS.md GAP-016's "reproduce, then confirm
   * fixed" direction). `null` for every ordinary task — only set when a
   * task is explicitly created with a bug-fix verification contract (see
   * task-factory.ts's CreateTaskInput). See BugFixVerification's own doc
   * comment for the full shape.
   */
  bugFixVerification: BugFixVerification | null;
}

// ---------------------------------------------------------------------------
// Bug-fix verification (V1.1 Slice 3 — see PLATFORM_GAPS.md GAP-016 and
// /docs/SECURITY_ARCHITECTURE.md "AI may describe/interpret. CodeForge owns
// verification policy, execution, evidence, and status.")
// ---------------------------------------------------------------------------

/**
 * A deterministic answer to "what exact platform-owned check establishes
 * whether this bug exists, and whether the fix works?" — set once at task
 * creation, immutable thereafter (like `Task.branchMode`). Reuses the exact
 * same check-id vocabulary reviewer-requested verification already uses
 * (`review/reviewer-verification.ts`'s `resolveApprovedVerificationChecks`)
 * — never an arbitrary command supplied by a user or an AI.
 */
export interface BugFixVerificationContract {
  /** One of the project's configured check names (build/test/lint/typecheck) — see reviewer-verification.ts. */
  checkId: string;
  /**
   * Which real outcome of running `checkId` means "the bug is present" —
   * almost always `"failed"` (a failing test/build that should pass once
   * fixed), but kept explicit rather than assumed so a check that should
   * currently be passing-when-it-shouldn't (a regression-guard check that's
   * silently green) can be expressed too. This is the ONLY thing that
   * decides how a real `passed`/`failed` result maps to
   * BUG_REPRODUCED/BUG_NOT_REPRODUCED or FIX_VERIFIED/FIX_NOT_VERIFIED (see
   * review/bug-fix-verification.ts) — never inferred by an LLM.
   */
  bugPresentWhenCheckOutcome: "failed" | "passed";
  /** Free text for the task author's own reasoning — informational only, never interpreted as anything executable. */
  purpose: string | null;
}

/**
 * See BugFixVerificationContract's own doc comment on the deterministic
 * mapping this derives from. `"rejected"`/`"timed_out"`/
 * `"infrastructure_error"` mirror `VerificationOutcome` exactly (nothing
 * about the check actually ran to a real pass/fail, so no bug-present/
 * bug-absent judgment can be made at all). There is deliberately no
 * separate `"not_run"` member — see ReviewResult's Slice 2 precedent for
 * `VerificationOutcome`'s own identical reasoning: "not run yet" is
 * represented by `BugReproductionResult` itself being absent
 * (`TaskRecord.bugFixVerification.reproduction === null`), never a
 * synthetic status value nothing produces.
 */
export type ReproductionStatus = "bug_reproduced" | "bug_not_reproduced" | "timed_out" | "infrastructure_error" | "rejected";

/** See ReproductionStatus's own doc comment — the identical reasoning, for the post-fix run of the same contract. */
export type FixVerificationStatus = "fix_verified" | "fix_not_verified" | "timed_out" | "infrastructure_error" | "rejected";

/** The platform's own captured pre-implementation check result, plus the deterministic status derived from it (see review/bug-fix-verification.ts's deriveReproductionStatus) — never an AI's claim about whether the bug exists. */
export interface BugReproductionResult {
  status: ReproductionStatus;
  evidence: VerificationEvidence;
}

/** The platform's own captured post-implementation check result, plus the deterministic status derived from it (see review/bug-fix-verification.ts's deriveFixVerificationStatus) — never an AI's claim that "the fix works." */
export interface FixVerificationResult {
  status: FixVerificationStatus;
  evidence: VerificationEvidence;
}

/**
 * Every field here is either platform-owned configuration (`contract`) or
 * platform-captured evidence (`reproduction`/`fixVerification`) — never
 * anything an AI wrote. `reproduction` is set once, immediately before
 * implementation begins (against the workspace's starting commit);
 * `fixVerification` is overwritten with fresh evidence after every commit
 * that follows (see orchestrator.ts's runWorkingEpisode) — so it always
 * reflects the LATEST verified commit, and its own `evidence.commitSha`
 * tells a reader exactly which commit it refers to, never presented as
 * evidence for a commit it didn't actually run against (see item 8's
 * commit-binding requirement — /docs/SECURITY_ARCHITECTURE.md).
 */
export interface BugFixVerification {
  contract: BugFixVerificationContract | null;
  reproduction: BugReproductionResult | null;
  fixVerification: FixVerificationResult | null;
}

export interface Decision {
  source: "human_answer" | "discovered";
  summary: string;
  recordedAt: string;
}

/**
 * How a task's workspace branch is derived — see /docs/TASK_LIFECYCLE.md
 * "Branch modes". Set once at task creation, immutable thereafter (unlike
 * `TaskRecord.branchName`, the orchestrator-derived *actual* branch in use,
 * which this only informs). `"new"` is the default and safest mode (isolated
 * per-task branch); `"existing"` checks out a user-selected branch directly
 * and never creates one. Absent on any Task row created before this field
 * existed — always treated as `"new"` (see task-repository.ts rowToTask).
 */
export type BranchMode = "new" | "existing";

export interface Task {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  /**
   * Original plain-language description. Editable only while the task is still BACKLOG (see
   * TaskService.editBacklogTask / POST /tasks/:taskId/edit) — immutable once released from BACKLOG,
   * exactly like `workingBranch`/`baseBranch` below.
   */
  goal: string;
  status: TaskStatus;
  taskRecord: TaskRecord;
  /** See BranchMode. Defaults to "new" for backward compatibility with rows created before this field existed. */
  branchMode: BranchMode;
  /**
   * Mode "new": an optional user-supplied branch name (validated — see
   * schemas.ts `isSafeBranchName`) used instead of the auto-derived
   * `task/<id-prefix>` name; null means auto-derive. Mode "existing": the
   * exact, required branch name to check out directly — never created,
   * never renamed. Editable only while the task is still BACKLOG (see
   * TaskService.editBacklogTask); immutable once released from BACKLOG.
   */
  workingBranch: string | null;
  /**
   * Mode "new" only: overrides `Project.defaultBranch` as the branch this
   * task's new branch is created from. Null means "use the project's
   * default branch." Ignored in mode "existing" (there is no separate base
   * to branch from — the selected branch itself is the target). Editable
   * only while the task is still BACKLOG (see TaskService.editBacklogTask);
   * immutable once released from BACKLOG.
   */
  baseBranch: string | null;
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
  /**
   * Ownership epoch for this task's execution lease (see
   * /docs/TASK_LIFECYCLE.md "Worker concurrency and lease loss" and
   * migrations/009_lock_generation.sql). Advances only when the lease
   * changes hands — a claimTodo/claimWorking/claimReviewForHumanFeedback
   * call that actually wins — never on a same-owner heartbeat renewal
   * (TaskRepository.renewWorkingLease). An execution captures the
   * generation it was granted at claim time and threads it through its
   * whole run; every write that must not survive losing the lease is
   * fenced against this column's CURRENT value (TaskRepository.saveOwned),
   * not the value captured at claim time.
   */
  lockGeneration: number;
  /**
   * When this REVIEW task's PR is next due for a GitHub refresh (status +
   * human-feedback check) — see migrations/010_review_poll_scheduling.sql
   * and TaskRepository.claimReviewCheck. `null` for every non-REVIEW task
   * and for a REVIEW task never yet checked (treated as due immediately).
   * Deliberately orthogonal to `lockGeneration`: this governs "who gets to
   * do this poll cycle's read-only GitHub check," not execution ownership.
   */
  nextReviewCheckAt: string | null;
}

// ---------------------------------------------------------------------------
// TaskEvent (append-only audit log / recovery backbone)
// ---------------------------------------------------------------------------

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
  /**
   * V1.1 Slice 2 — appended when the Reviewer's response contains a `VERIFY:`
   * line, immediately before the platform acts on it (whether it will go on
   * to execute the check or reject it) — see ReviewerVerificationCompleted's
   * own doc comment on VerificationEvidence for why the follow-up event
   * carries the actual outcome. See PLATFORM_GAPS.md GAP-016.
   */
  | "REVIEWER_VERIFICATION_REQUESTED"
  /**
   * V1.1 Slice 2 — the platform's own record of what actually happened to a
   * Reviewer's verification request: either real command execution (with
   * captured stdout/stderr/exit code/duration) or a structured rejection —
   * never the Reviewer's own claim about either. See VerificationEvidence's
   * doc comment and /docs/SECURITY_ARCHITECTURE.md "AI may request
   * verification. CodeForge owns verification evidence."
   */
  | "REVIEWER_VERIFICATION_COMPLETED"
  /**
   * V1.1 Slice 3 — appended immediately before the platform runs a task's
   * BugFixVerificationContract check against the workspace's starting
   * state, before any implementation happens. See
   * TaskRecord.bugFixVerification and review/bug-fix-verification.ts.
   */
  | "BUG_REPRODUCTION_STARTED"
  /** V1.1 Slice 3 — the platform's own captured pre-implementation result (BugReproductionResult), never an AI's claim about whether the bug exists. */
  | "BUG_REPRODUCTION_COMPLETED"
  /** V1.1 Slice 3 — appended immediately before the platform re-runs the SAME contract check against a new commit produced by implementation. */
  | "FIX_VERIFICATION_STARTED"
  /** V1.1 Slice 3 — the platform's own captured post-implementation result (FixVerificationResult), never an AI's claim that "the fix works." */
  | "FIX_VERIFICATION_COMPLETED"
  /**
   * V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028) — appended the moment an episode-level
   * (workspace/engine/source-control) or check-level (validation/verification) failure is
   * classified, before any retry decision is acted on — see orchestrator/failure-classifier.ts.
   * Payload: `{ category, retryable, reason, attempt }`. Appended even for a non-retryable failure,
   * so the task's event log always shows WHY it ultimately failed, not just that it did.
   */
  | "INFRASTRUCTURE_FAILURE_DETECTED"
  /**
   * V1.1 Slice 4 — appended only when the failure above was retryable and the retry budget was not
   * yet exhausted, immediately before the bounded backoff wait begins. Payload:
   * `{ attempt, maxAttempts, delayMs, retryAfterMs }`.
   */
  | "INFRASTRUCTURE_RETRY_SCHEDULED"
  /**
   * V1.1 Slice 4 — appended right after the backoff wait completes, immediately before the failed
   * step is attempted again — the visible "attempt N+1 begins here" marker in the task's timeline
   * (see this slice's brief, item 17's example timeline). Payload: `{ attempt }`.
   */
  | "INFRASTRUCTURE_RETRY_STARTED"
  | "HUMAN_REVIEW_DETECTED"
  | "HUMAN_REVIEW_CHANGES_REQUESTED"
  | "HUMAN_REVIEW_APPROVED"
  | "PULL_REQUEST_MERGED"
  /**
   * Appended when an in-flight execution discovers (via a fenced write or
   * heartbeat-renewal failure) that it no longer holds the task's
   * execution lease — distinct from TASK_FAILED (a genuine platform
   * failure) and from TASK_CANCELLED (a human-requested stop). Task status
   * and workspace are deliberately left untouched by whichever process
   * raises this — see LeaseLostError's own doc comment. See
   * /docs/TASK_LIFECYCLE.md "Worker concurrency and lease loss".
   */
  | "EXECUTION_LEASE_LOST"
  /**
   * Phase 4D.2 — appended by ActionLayerService AFTER an existing TaskService mutation (create/edit/
   * start/cancel) has already succeeded AND its result was read back and verified. Never appended
   * speculatively, never a mutation itself — purely an audit trail so a Chat-originated change shows
   * up in the SAME task history as one made through the Tasks UI. See action-layer.ts.
   */
  | "CHAT_ACTION_PERFORMED";

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

/**
 * A project-owned, platform-executed verification of ONE specific behaviour (Phase 4A.5, GAP-033). Unlike
 * build/test/lint/typecheck (project-wide), it declares what a PASS establishes and which claims it may be bound to, so
 * "the generic suite passed" can never be mistaken for "this behaviour holds". Declared by the project owner (the same
 * trust level as the four commands above) — NEVER supplied by a model: an AI claim can only be *matched* to a check
 * that already exists here. See backlog/claim-verification.ts.
 */
/**
 * What a check actually EXERCISES (Phase 4A.7) — declared by the project owner, never by a model. A check may verify only claims that
 * fall inside its scope; a passing check is not evidence about anything outside it.
 */
export interface CheckScope {
  /** `mechanism`: exercises one function/module directly (a unit test). `flow`: exercises an entry point end to end (e.g. an HTTP route). */
  level: "mechanism" | "flow";
  /** The application exercised ("backend", "mobile", …). */
  application: string;
  /** The symbol whose behaviour is asserted (e.g. "evaluateOtpThrottle"). A behaviour claim must name it. */
  mechanism: string;
  /** Required for `flow`: the entry point exercised, "POST /request-otp". */
  entryPoint?: string;
  /** The behaviours the check asserts, each recognised in a claim by any of its single lowercase words. */
  behaviors: Array<{ id: string; terms: string[] }>;
}

export interface ApprovedClaimCheck {
  /** Stable identifier, `[a-z0-9-]`. Recorded on every result; a check whose definition changes is a different check (fingerprint). */
  id: string;
  description: string;
  /** Shell command run with the project's repository checked out at the analysed revision (like `test`/`typecheck`). Exit 0 ⇒ pass. */
  command: string;
  /** Wall-clock limit, ms (default 120,000; max 900,000). Enforced by the existing check runner. */
  timeoutMs?: number;
  /** Informational: the application/module this check exercises (e.g. "backend"). */
  application?: string;
  /** Prerequisite state: the check only applies when every listed file exists at the analysed revision. */
  requiresFiles?: string[];
  establishes: {
    /** What a pass establishes, in words (shown to reviewers). */
    behavior: string;
    /**
     * Binding keys. A claim is bound to this check only if, for EVERY group, the claim's own words contain at least one
     * term of that group (groups are ANDed, terms within a group are alternatives): [["otp"], ["limit","throttle","rate"]].
     */
    claimTerms: string[][];
    /** Which behaviour claims a pass speaks to. Default both: it VERIFIES "…works correctly" and CONTRADICTS an absence-worded "…is not handled". */
    claimKinds?: Array<"BEHAVIOR_CORRECT" | "BEHAVIOR_INCORRECT">;
    /** The semantic contract. Without it the check is never sufficient for any claim (`claimTerms` alone only ranks candidates). */
    scope?: CheckScope;
  };
  /** The only supported semantics: exit 0 means the described behaviour holds at that revision. A failure is recorded but establishes nothing. */
  passMeans: "behavior_holds";
}

export interface ProjectCommands {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  /** Approved, claim-bindable behaviour checks (Phase 4A.5). Not run by task validation. */
  claimChecks?: ApprovedClaimCheck[];
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

/**
 * Phase 3 — Project Workspace, Slice 1. A first-class persistent domain concept keyed by
 * `projectId`, one-to-one with `Project` (enforced by `UNIQUE(project_id)` on `project_workspaces`
 * — see migrations/011_project_workspace.sql). Deliberately NOT the same concept as the existing
 * task-execution `Workspace` below (keyed by `taskId`, backed by the `workspaces` table/
 * `WorkspaceRepository`/`WorkspaceProvider`/`src/workspace/*`, provisions an actual working
 * directory on disk for one task's coding-engine run) — that concept predates this one, is
 * unrelated to it, and is not touched by this type. `ProjectWorkspace` currently has zero
 * filesystem footprint; it exists purely as the project-scoped persistence anchor Phase 3 builds
 * on next.
 */
export interface ProjectWorkspace {
  id: string;
  projectId: string;
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
  /**
   * The task's `lock_generation` at the moment this AgentRun was created
   * (see Orchestrator.runAgent) — the fencing key AgentRunRepository.complete()
   * re-checks against the task's CURRENT lock_generation, so a stale
   * execution (operating under an old generation) can never complete this
   * run after a newer owner has taken over. See migrations/009_lock_generation.sql.
   */
  ownerGeneration: number;
  /**
   * V1.1 Slice 5 — the platform's own routing decision for this invocation
   * (`ModelRouter.selectModel`, never the AI's own choice) — see
   * ModelSelection's own doc comment. `null` only when no ModelRouter/
   * ModelRegistry was wired (older callers, or no model actually configured
   * — see routing/model-registry.ts's own doc comment on
   * `OPENCODE_MODEL` being unset) — the coding engine then falls back to
   * whatever model it would have used before this slice existed.
   */
  modelId: string | null;
  providerId: string | null;
  /**
   * How many DISTINCT models have already been attempted for this exact
   * (taskId, role) before this one — 0 for the first attempt. Derived from
   * persisted AgentRun rows the same way `Orchestrator.nextAttemptNumber`
   * derives attempt numbers — never a separately tracked in-memory counter.
   * See domain/types.ts ModelSelection's own doc comment on explainability.
   */
  fallbackIndex: number;
}

/**
 * A monetary ESTIMATE attached to a run — kept separate from the raw usage counts below because it is a
 * different kind of fact: usage is what the provider/engine reported; an estimate is somebody's
 * arithmetic over a price list. Present ONLY when the engine (or a platform pricing table, none exists
 * yet) actually supplied a figure. `pricingSource` says whose arithmetic it is; `pricingVersion` says
 * which price list, or `null` when the source does not say. Never fabricated, never `0` for "unknown".
 */
export interface EstimatedCost {
  amount: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Who computed it, e.g. "opencode-reported" (the engine's own estimate — NOT provider-billed). */
  pricingSource: string;
  pricingVersion: string | null;
}

/**
 * Normalized, provider-agnostic usage for one engine invocation (see coding-engine/engine-usage.ts).
 * Every field is OPTIONAL and means exactly "the engine reported this": an absent field is
 * "unavailable", never `0`. Provider-specific parsing lives in the engine adapter; nothing here names
 * a vendor. `reasoningTokens`/cache fields are reported separately (providers bill them differently) —
 * whether `inputTokens` includes cached tokens is the provider's convention, so cache counts are never
 * silently added to or subtracted from it.
 */
export interface CostMetadata {
  /**
   * How trustworthy the counts are as a TOTAL for the invocation (GAP-034):
   *  - `complete`: the invocation finished normally and every usage event the engine emitted was captured;
   *  - `partial`: the invocation failed, timed out or was cancelled after (possibly) emitting usage — the counts
   *    are what WAS emitted before it stopped, a lower bound, never a full total.
   * Absent on `cost: null` (usage `unavailable`) and on rows written before this field existed (readers then
   * treat a completed run as complete and anything else as partial — see reporting/usage-rollup.ts).
   */
  usageStatus?: "complete" | "partial";
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Separate from the counts above — see EstimatedCost. Absent when no cost was supplied. */
  estimatedCost?: EstimatedCost;
  /** Legacy engine-reported USD figure (Claude Code adapter); superseded by `estimatedCost`, kept for existing readers. */
  costUsd?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Model / provider routing (V1.1 Slice 5 — see PLATFORM_GAPS.md GAP-027/028's
// "Still open" notes and /docs/SECURITY_ARCHITECTURE.md "CodeForge owns
// routing"). CodeForge stays model-agnostic: the orchestrator selects a
// model from a configurable registry and records what actually ran; no
// abstraction here assumes Gemini, OpenAI, Anthropic, or any other specific
// provider.
// ---------------------------------------------------------------------------

/**
 * Deliberately qualitative, never a fabricated numeric "intelligence score"
 * (see this slice's own brief, item 3: no `modelScore = 97`). `"unknown"` is
 * the honest default for a model this registry has no real, sourced
 * assessment of — never guessed just to fill the field in.
 */
export type CapabilityLevel = "basic" | "strong" | "unknown";
export type SpeedClass = "low" | "medium" | "high" | "unknown";
export type CostClass = "low" | "medium" | "high" | "unknown";

export interface ModelCapabilityProfile {
  coding: CapabilityLevel;
  reasoning: CapabilityLevel;
  /** Typical response latency class — "low" means fast. */
  latency: SpeedClass;
  cost: CostClass;
}

/**
 * Whether the credential used to call this model's provider is one CodeForge
 * itself manages (today's only real mode) or one the customer supplies
 * (BYOK — see this slice's brief, item 16). This is a DOMAIN distinction
 * only in this slice: no BYOK credential storage/resolution is implemented
 * here (see routing/model-registry.ts's own doc comment on what remains
 * open), and the existing GitHub-credential security model
 * (/docs/SECURITY_ARCHITECTURE.md "Secrets management") is exactly what any
 * future BYOK provider-credential store would need to follow — server-side
 * only, never in a prompt/report/log/event.
 */
export type ProviderCredentialMode = "managed" | "byok";

/**
 * One entry in the model registry — see routing/model-registry.ts's
 * `ModelRegistry`. Deliberately data, not code: a new model/provider is
 * registered, not hand-wired into orchestrator logic (this slice's brief,
 * item 4).
 */
export interface ModelProfile {
  /** The exact string passed to the coding engine (e.g. OpenCode's `--model` flag) — never guessed or normalized. */
  modelId: string;
  /** Inferred from `modelId`'s own naming convention where recognizable (see routing/model-registry.ts's inferProviderId), else `"unknown"` — never fabricated. */
  providerId: string;
  displayName: string;
  /** Which registered CodingEngine key actually executes this model — e.g. `"opencode"`. A model profile for an engine that isn't registered is simply never selectable. */
  engineKey: string;
  capability: ModelCapabilityProfile;
  /** `null` when not reliably known — never an invented figure. */
  contextWindow: number | null;
  credentialMode: ProviderCredentialMode;
  /**
   * Whether this profile is actually selectable right now. Distinct from
   * provider HEALTH (`ProviderHealth`, which changes automatically from
   * observed failures): `enabled` is configuration — set false for a
   * profile that exists in the registry (documenting a future/planned
   * model) but isn't wired to real, executable credentials/environment
   * today. See this slice's brief, item 25: a disabled profile must never
   * be presented as available.
   */
  enabled: boolean;
}

/**
 * The execution intent behind one Implementer/Reviewer invocation — lets
 * routing be operation-aware (this slice's brief, item 21: "implementation
 * model ≠ reviewer model", without forcing them to differ). Reuses the
 * existing role/context distinctions orchestrator.ts already makes; does
 * not invent a new task-classification system.
 * `"verification_interpretation"` is reserved for a possible future step
 * that asks a model to interpret verification evidence in natural language
 * — nothing in the current architecture invokes one (Slice 3's own
 * bug-fix-verification status derivation is deliberately deterministic,
 * never an LLM call — see review/bug-fix-verification.ts), so this value is
 * never actually selected by anything today. Kept for the same reason
 * Slice 4's `OrchestratorFailureCategory` kept `recoverable_crash`: a
 * documented, intentionally-unreachable placeholder, not a mistake.
 */
export type OperationClass =
  | "implementation"
  | "bug_fix"
  | "reviewer"
  | "verification_interpretation"
  | "human_feedback_fix"
  /** Phase 4A — a read-only, schema-validated analysis of a backlog item (see backlog/backlog-analyzer.ts). Routed through the same registry/health machinery as execution; never creates an AgentRun (there is no task yet). */
  | "backlog_analysis";

/**
 * The platform's own, explainable routing decision for one invocation —
 * never the AI's choice (this slice's brief, item 17: "Every execution
 * should be able to explain..."). Persisted onto the AgentRun row that used
 * it (`AgentRun.modelId`/`providerId`/`fallbackIndex`); `reason` is
 * generated entirely by `ModelRouter.selectModel`, never an LLM-authored
 * explanation.
 */
export interface ModelSelection {
  modelId: string;
  providerId: string;
  engineKey: string;
  operation: OperationClass;
  /** Human-readable, platform-generated — e.g. "configured default for this project" or "fallback: gemini-3-flash-preview (google) is in cooldown". Never secret-bearing. */
  reason: string;
  /** 0 for the first model attempted for this (task, role); see AgentRun.fallbackIndex's own doc comment. */
  fallbackIndex: number;
}

/**
 * See routing/provider-health-repository.ts. `"degraded"`/`"disabled"` are
 * valid, persistable states this slice's schema supports but its own
 * automatic health-recording logic never produces — reserved for a future,
 * finer policy or an explicit admin action (see
 * routing/provider-health-policy.ts's own doc comment for exactly what this
 * slice's automatic logic does produce: `healthy` <-> `cooldown`).
 */
export type ProviderHealthState = "healthy" | "degraded" | "cooldown" | "disabled";

/** Persisted, cross-task/cross-worker provider health — see this slice's brief, items 13/14. */
export interface ProviderHealth {
  providerId: string;
  state: ProviderHealthState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureCategory: string | null;
  /** `null` unless `state === "cooldown"` — when the cooldown clears on its own, without needing a success to be observed first. */
  cooldownUntil: string | null;
  updatedAt: string;
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

/**
 * The result of a platform-owned commit — see SourceControlProvider.commitAll
 * and git-commit.ts's commitAllLocal. `changedFiles` is the platform's own
 * `git status --porcelain` reading, captured BEFORE staging — never the
 * coding engine's self-reported file list (StepResult.filesChanged, which is
 * derived from the AI's own tool-call log and is a claim, not evidence — see
 * /docs/SECURITY_ARCHITECTURE.md "AI claims are not execution evidence").
 */
export interface CommitResult {
  commitSha: string;
  changedFiles: string[];
}

/**
 * The result of a platform-owned push, verified against the remote — see
 * SourceControlProvider.push. `remoteBranchSha` is `null` only when the
 * provider genuinely has no remote to verify against (the local-git test
 * fixture with no configured remote); for every real push it is read back
 * from the remote itself and must equal `pushedCommitSha`, or the push has
 * not actually landed what the platform believes it landed.
 */
export interface PushResult {
  pushedCommitSha: string;
  remoteBranchSha: string | null;
}

export interface PullRequestRef {
  provider: string; // e.g. "github" | "local-git"
  /** Provider-native identifier (e.g. GitHub PR number as a string). Opaque to core logic. */
  id: string;
  /** Numeric PR number where the provider has one (GitHub); null otherwise. */
  number: number | null;
  url: string | null;
}

/**
 * The remote state of a task's PR — used to detect a human merging (or
 * closing without merging) the PR directly on GitHub, so a REVIEW task can
 * be synced to DONE without the platform ever merging anything itself. See
 * /docs/TASK_LIFECYCLE.md "PR merge sync" and SourceControlProvider.getPullRequestStatus.
 */
export interface PullRequestStatus {
  state: "open" | "closed";
  /** True only once the PR has actually been merged (a distinct fact from `state === "closed"` — a PR can be closed without merging). */
  merged: boolean;
  /**
   * GitHub's own "can this be merged cleanly" verdict for an open PR — null when unknown: GitHub
   * computes this asynchronously and can report null for a brief window right after a push, and a
   * provider with no real PR concept (local-git) always reports null here (see
   * SourceControlProvider.getPullRequestStatus's own doc comment) — never fabricated as true/false.
   * See /docs/TASK_LIFECYCLE.md "Merge/conflict state".
   */
  mergeable: boolean | null;
}

// ---------------------------------------------------------------------------
// Branch comparison / merge-conflict state (see /docs/TASK_LIFECYCLE.md
// "Stale/behind detection" and "Merge/conflict state") — detection only, no
// remediation: the platform never auto-rebases/merges anything.
// ---------------------------------------------------------------------------

/**
 * Ahead/behind commit counts between a task's working branch and its base —
 * see SourceControlProvider.getBranchStatus. `comparable=false` means the
 * provider genuinely could not determine this (never fabricated data) —
 * distinct from `comparable=true` with `aheadBy`/`behindBy` both `0`, which
 * means "up to date."
 */
export interface BranchComparisonStatus {
  comparable: boolean;
  aheadBy: number | null;
  behindBy: number | null;
}

/**
 * The richer, task-execution-independent state of a task's branch/PR — see
 * /docs/TASK_LIFECYCLE.md "Merge/conflict state". Deliberately distinct from
 * `TaskStatus`: a task can be REVIEW while its branch state is READY, BEHIND,
 * or CONFLICT, and reaching DONE off a PR merge is the *only* thing that
 * lets this become MERGED (see Orchestrator.finalizeMergedPullRequest) — the
 * AI finishing implementation, or a branch merely existing, never implies
 * MERGED or READY on its own.
 *   - READY: open PR (or, for local-git, a real branch), no known conflict, not behind its base.
 *   - BEHIND: not (yet) known to conflict, but the base has commits this branch doesn't.
 *   - CONFLICT: the provider reports this PR cannot be merged cleanly.
 *   - MERGED / CLOSED_NOT_MERGED: the PR's own terminal remote state (see PullRequestStatus).
 *   - NOT_APPLICABLE: no real PR concept for this provider (local-git) — never fabricated as READY.
 *   - UNKNOWN: not enough information yet (e.g. no PR opened yet, or the provider read failed).
 */
export type MergeState = "READY" | "BEHIND" | "CONFLICT" | "MERGED" | "CLOSED_NOT_MERGED" | "NOT_APPLICABLE" | "UNKNOWN";

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
  /**
   * Phase 3, Slice 6 — a pre-rendered, size-bounded, clearly-delimited text block built from the
   * project's persistent Project Context Manifest (`.project-context.json`, see
   * project-workspace/project-context-manifest.ts), or `null` when the project has no
   * ProjectWorkspace, no manifest, or the manifest is corrupt (see
   * orchestrator/project-context-loader.ts — loading never fails the task; it degrades to `null`
   * and logs). ALWAYS project-owned, human-authored, untrusted DATA — never system/orchestrator
   * instructions. Nothing in this text is ever interpreted as a command, executed, or capable of
   * altering authorization, task lifecycle, retry limits, branch selection, or any other
   * orchestrator-controlled behavior; see /docs/SECURITY_ARCHITECTURE.md "Project Context Manifest
   * ≠ security policy". Bounded independently of the manifest's own 256 KiB on-disk storage limit —
   * see orchestrator/project-context-section.ts's `MAX_PROJECT_CONTEXT_SECTION_CHARS`.
   */
  projectContext: string | null;
  /**
   * V1.1 Slice 2 — the check ids the Reviewer is allowed to request via a
   * `VERIFY:` line for this project right now (see
   * reviewer-verification.ts's resolveApprovedVerificationChecks) — always
   * a subset of the project's own already-configured build/test/lint/
   * typecheck commands, never invented. Empty for the Implementer role and
   * for any project with nothing configured to offer.
   */
  approvedVerificationChecks: string[];
  /**
   * V1.1 Slice 2 — present only on the Reviewer's follow-up invocation,
   * immediately after it requested a verification and the platform actually
   * executed (or rejected) it — see orchestrator.ts's review/fix cycle. This
   * is the platform's own real, captured result; the Reviewer's own prose in
   * this or any prior response is never a substitute for it. `null` for
   * every Implementer invocation and for a Reviewer's first-pass invocation
   * that hasn't requested anything yet.
   */
  verificationEvidence: VerificationEvidence | null;
  /**
   * V1.1 Slice 3 — the platform's own captured bug-fix verification state
   * for this task, or `null` when the task has no BugFixVerificationContract
   * at all. Populated for BOTH roles: the Implementer sees `reproduction`
   * (captured before it started) with `fixVerification` still `null`; the
   * Reviewer sees both once a post-fix check has run. Every field here is
   * platform evidence, never an AI's claim — see
   * TaskRecord.bugFixVerification and item 5/9 of the Slice 3 brief
   * ("PLATFORM-CAPTURED EVIDENCE" vs. "AI INTERPRETATION").
   */
  bugFixEvidence: { reproduction: BugReproductionResult | null; fixVerification: FixVerificationResult | null } | null;
}

export interface ReviewEvidence {
  implementerSummary: string;
  filesChanged: string[];
  diffRef: string | null;
  validation: ValidationResult;
}

// ---------------------------------------------------------------------------
// Reviewer-requested, platform-executed verification (V1.1 Slice 2 — see
// PLATFORM_GAPS.md GAP-016 and /docs/SECURITY_ARCHITECTURE.md "AI may
// request verification. CodeForge owns verification evidence.")
// ---------------------------------------------------------------------------

/**
 * A bounded request the Reviewer may make for the platform to run one of the
 * project's own already-configured checks (build/test/lint/typecheck) —
 * never an arbitrary shell command. Parsed from an explicit `VERIFY:` line
 * (see review/reviewer.ts's parseVerificationRequest), the same
 * deterministic-parser convention `VERDICT:`/`FINDING:`/`VERIFICATION:`
 * already use. `purpose` is free text for the Reviewer's own reasoning
 * (e.g. "confirm the regex rejects '---'") — informational only, never
 * interpreted as anything executable.
 */
export interface VerificationRequest {
  /** One of the project's configured check names — see reviewer-verification.ts's resolveApprovedVerificationChecks. */
  checkId: string;
  purpose: string | null;
}

/**
 * Distinguishes what actually happened to a VerificationRequest — see
 * PLATFORM_GAPS.md GAP-016. `"passed"`/`"failed"`/`"timed_out"`/
 * `"infrastructure_error"` mirror CheckOutcome exactly (the platform reused
 * validation-runner.ts's own `runCheck`, not a second execution engine) and
 * mean a real process actually ran to one of those ends. `"rejected"` means
 * nothing was ever spawned — the requested check id was unknown or not
 * configured for this project, and the Reviewer's request was refused
 * before touching a single process. There is deliberately no separate
 * "not_run" outcome distinct from "rejected": the only way for this slice to
 * reach "requested but nothing happened" is a rejected request, so folding
 * the two would only add an unreachable state — see PLATFORM_GAPS.md
 * GAP-016's "Narrowed" note for what a future slice might add here (e.g. a
 * per-project verification kill-switch).
 */
export type VerificationOutcome = "passed" | "failed" | "timed_out" | "infrastructure_error" | "rejected";

/**
 * The platform's own captured record of one Reviewer-requested verification
 * — the only thing that can ever make `ReviewResult.verificationMethod`
 * become `"executed"` (see reviewer.ts's deriveReviewResult). Every field is
 * either what the platform actually spawned/observed or, for a rejection,
 * why it refused — never the Reviewer's own claim about what it ran. See
 * PLATFORM_GAPS.md GAP-016 and /docs/SECURITY_ARCHITECTURE.md "AI may
 * request verification. CodeForge owns verification evidence."
 *
 * `expectedBranch`/`actualBranch`/`commitSha` tie this evidence to the exact
 * repository state it verified (item 4's "critical" requirement) — a later
 * Implementer fix produces a new commit and a fresh review cycle with its
 * own (or no) VerificationEvidence; nothing here is ever carried forward and
 * presented as evidence for a different commit.
 */
export interface VerificationEvidence {
  requested: VerificationRequest;
  outcome: VerificationOutcome;
  /** Set only when `outcome === "rejected"` — a plain, human-readable reason (e.g. which check ids are actually approved for this project). */
  rejectionReason: string | null;
  checkId: string | null;
  /** The actual command that ran — always the project's own configured command for `checkId`, never anything the Reviewer supplied. `null` only when rejected. */
  command: string | null;
  /** The task's recorded branch at the moment of this request — captured even for a rejection, since it costs nothing extra and documents intent. */
  expectedBranch: string;
  /** The workspace's real current branch, read via git — `null` only when rejected (nothing was executed, so nothing was read). */
  actualBranch: string | null;
  /** HEAD commit sha at verification start — see this type's own doc comment on commit binding. `null` only when rejected. */
  commitSha: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  /** Tail of real captured stdout/stderr, bounded exactly like CheckResult.logExcerpt. `null` when rejected. */
  logExcerpt: string | null;
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

/**
 * A truthful outcome for one check — see PLATFORM_GAPS.md GAP-002. `"failed"`
 * means the command actually ran to completion with a non-zero exit;
 * `"timed_out"` and `"infrastructure_error"` are deliberately distinct from
 * it, because a self-fix loop (or a human) handed a plain "failed" for either
 * of those would go hunting for a bug in the diff that does not exist.
 */
export type CheckOutcome = "passed" | "failed" | "timed_out" | "infrastructure_error";

export interface CheckResult {
  name: string; // e.g. "build" | "test" | "lint" | "typecheck"
  command: string;
  /** Kept for backward compatibility with every existing reader — always exactly `outcome === "passed"`. Prefer `outcome` for anything that needs to tell a real failure apart from a timeout or an infrastructure error. */
  passed: boolean;
  outcome: CheckOutcome;
  exitCode: number | null;
  durationMs: number;
  logExcerpt: string; // tail of output, bounded in size
}

/**
 * Distinguishes "the declared checks ran and passed" from "nothing was
 * declared, so nothing ran" — see PLATFORM_GAPS.md GAP-004. A project with no
 * commands configured must never be reported as having passed validation.
 */
export type ValidationOutcome = "checks_passed" | "checks_failed" | "no_checks_configured";

export interface ValidationResult {
  /**
   * Unchanged semantics from before this slice — this is what gates the
   * self-fix loop (`status === "passed"` exits it), and a project with no
   * declared checks must keep exiting that loop exactly as it always has,
   * since there is nothing to retry against. `outcome` below is the
   * truthful field for anything that reports this to a human; `status`
   * alone must never be read as "validation genuinely ran and passed."
   */
  status: "passed" | "failed";
  outcome: ValidationOutcome;
  checks: CheckResult[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Reviewer contract
// ---------------------------------------------------------------------------

/**
 * Whether the Reviewer's verdict rests on reading the diff (`"static"`) or on
 * an executable check it actually ran and reported the output of
 * (`"executed"`) — see PLATFORM_GAPS.md GAP-016, "'Independently verified'
 * means read, not run." `"unknown"` is the safe default: a Reviewer response
 * that never states which one it did must never be presented as verified.
 */
export type VerificationMethod = "static" | "executed" | "unknown";

export interface ReviewResult {
  verdict: "approved" | "rejected";
  findings: Finding[];
  confidence: "high" | "medium" | "low";
  summary: string;
  /**
   * V1.1 Slice 2 — no longer derived purely from what the Reviewer's own text
   * claims (see reviewer.ts's deriveReviewResult). Can only become
   * `"executed"` when `verification` below is real platform evidence of an
   * actually-run check; a Reviewer that writes `VERIFICATION: EXECUTED`
   * without platform evidence to back it is downgraded to `"static"` — see
   * PLATFORM_GAPS.md GAP-016's "AI may request verification. CodeForge owns
   * verification evidence."
   */
  verificationMethod: VerificationMethod;
  /**
   * V1.1 Slice 2 — the platform's own record of a Reviewer-requested
   * verification, or `null` when the Reviewer never requested one this
   * cycle. See VerificationEvidence's own doc comment.
   */
  verification: VerificationEvidence | null;
}
