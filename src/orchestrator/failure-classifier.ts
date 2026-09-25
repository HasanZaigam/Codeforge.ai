import { EngineExecutionError, EngineTimeoutError } from "../coding-engine/coding-engine.js";
import { BranchMismatchError, BranchNotFoundAtExecutionError, PushVerificationError } from "../domain/errors.js";
import { classifyGitHubError } from "../integrations/github/error-classifier.js";
import { GitHubApiError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from "../integrations/github/errors.js";

/**
 * V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-027/GAP-028) — the orchestrator-level failure taxonomy this
 * slice exists to build: distinguishes a genuine TASK/CODE failure from an INFRASTRUCTURE failure the
 * platform can safely retry. Deliberately the single, structured decision point every infrastructure-
 * retry boundary in orchestrator.ts consults — never `error.message.includes(...)` scattered around
 * the codebase. This is also the clean interface a future V1.1 Slice 5 (model/provider routing) is
 * meant to consume: "this episode failed, here is exactly why, here is whether it was retried" — see
 * this slice's brief, item 25. Slice 4 itself does NOT route to a different model/provider; it only
 * classifies and retries the SAME configuration.
 */
export type OrchestratorFailureCategory =
  | "task_failure"
  | "infrastructure_failure"
  | "cancellation"
  /**
   * Reserved for describing the OTHER, pre-existing recovery mechanism (lease expiry + orphan
   * detection + a second process resuming — see Orchestrator.recoverOrphanedTasks) — conceptually
   * distinct from this module's own infrastructure retry (see item 15 of this slice's brief: "these
   * should share primitives where appropriate but remain conceptually distinct"). Nothing in this
   * file ever PRODUCES this category: a crash means the process died before it could classify or
   * catch anything, so by construction there is no caught error here to classify as a crash — the
   * surviving resumption is just a fresh `executeTask` call, handled entirely by the existing
   * lease/heartbeat/orphan machinery this slice does not touch.
   */
  | "recoverable_crash"
  | "permanent_configuration_failure"
  | "authentication_failure"
  | "rate_limited"
  | "provider_quota_exhausted"
  | "timeout"
  | "network_failure"
  | "source_control_failure"
  | "workspace_provision_failure"
  /**
   * Covers BOTH a declared validation command that could not even be spawned (see
   * validation-runner.ts's `CheckOutcome: "infrastructure_error"`) and a Slice 3 bug-fix-verification
   * contract check in the same state (see domain/types.ts `VerificationOutcome`) — the same
   * underlying mechanism (`runCheck`) produces both, so one honest category covers both rather than
   * two that would only ever differ by which caller happened to invoke it.
   */
  | "verification_infrastructure_failure"
  | "unknown_failure";

export interface OrchestratorFailureClassification {
  category: OrchestratorFailureCategory;
  /**
   * Whether the ORCHESTRATOR's own episode-level retry (see orchestrator.ts's
   * runEpisodeWithInfrastructureRetry) should attempt this again — never something the AI decides or
   * controls (see this slice's brief, item 3). A model can describe what happened; it never gets a
   * vote on whether to retry.
   */
  retryable: boolean;
  /** Human-readable, safe to put in a TaskEvent/log line — every source this draws from (EngineExecutionError.message, GitHubFailureClassification.reason) is already sanitized upstream; never a raw stack trace. */
  reason: string;
  /** A provider/GitHub-suggested wait, when the underlying classification carried one — null when there's no such hint, in which case the caller falls back to plain bounded backoff. */
  retryAfterMs: number | null;
}

/**
 * Optional context about WHICH orchestrator step actually threw — used only to relabel an otherwise
 * generic classification with the more specific category a human reading the task's event log would
 * expect (e.g. a plain network error thrown while provisioning a workspace reads as
 * "workspace_provision_failure", not the more generic "source_control_failure" the same raw error
 * would get from a commit/push/PR call). Never changes the retry DECISION itself, only the label.
 */
export type OrchestratorFailurePhase = "workspace_provisioning" | "commit_or_push_or_pr";

const KNOWN_GITHUB_ERROR_TYPES = [GitHubApiError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError];

/**
 * The single classification entry point every infrastructure-retry boundary in orchestrator.ts
 * calls. Reuses existing, already-structured classifiers wherever one exists
 * (`coding-engine/coding-engine.ts`'s `EngineExecutionError.meta` — itself built by
 * `engine-failure-classifier.ts` — and `integrations/github/error-classifier.ts`'s
 * `classifyGitHubError`) rather than inventing a third. `CancellationError`/`LeaseLostError` are
 * deliberately NOT handled here — every caller must check for those with `instanceof` and rethrow
 * immediately, before ever reaching this function; see orchestrator.ts's
 * runEpisodeWithInfrastructureRetry for why classifying (let alone retrying) a cancellation or a
 * lost lease would be actively wrong.
 *
 * Conservative by construction, same philosophy `engine-failure-classifier.ts`/
 * `github/error-classifier.ts` already document for themselves: an error this function cannot
 * positively identify as infrastructure-related defaults to `unknown_failure`, non-retryable — NEVER
 * the reverse. In particular, `classifyGitHubError`'s own "any non-GitHub-typed error is
 * retryable_transient" fallback is safe only at ITS actual call site (`checkHumanReviewFeedback`'s
 * read calls, where the only way to reach that catch block at all is a network/GitHub failure) — it
 * is deliberately NOT reused blindly here, where the caught error could be anything (a genuine bug,
 * an assertion failure, anything at all). This function only applies that "assume network-shaped"
 * reasoning when it has independent evidence the error really did occur during a network/git call:
 * either the error is one of GitHub's own typed exceptions, or `phase` confirms the failure happened
 * inside workspace provisioning or a commit/push/PR call (see inferFailurePhase's own doc comment).
 */
export function classifyOrchestratorFailure(err: unknown, phase?: OrchestratorFailurePhase): OrchestratorFailureClassification {
  if (err instanceof EngineTimeoutError) {
    return { category: "timeout", retryable: true, reason: err.message, retryAfterMs: null };
  }
  if (err instanceof EngineExecutionError) {
    return classifyEngineExecutionError(err);
  }
  if (err instanceof BranchMismatchError || err instanceof PushVerificationError || err instanceof BranchNotFoundAtExecutionError) {
    // The agent moved off its branch, a push landed somewhere unexpected, or a configured branch no
    // longer exists — none of these are transient; retrying without a human looking would either
    // fail identically or (worse) succeed by accident against the wrong state. See those errors' own
    // doc comments.
    return { category: "permanent_configuration_failure", retryable: false, reason: err.message, retryAfterMs: null };
  }
  if (KNOWN_GITHUB_ERROR_TYPES.some((type) => err instanceof type)) {
    return mapGitHubClassification(classifyGitHubError(err), phase);
  }
  if (phase !== undefined) {
    // We KNOW this happened during a workspace-provisioning or commit/push/PR call (see
    // inferFailurePhase) — a plain, untyped Error reaching this point is exactly the shape a real
    // transient git clone/fetch/network failure takes (see PLATFORM_GAPS.md GAP-028's own evidence:
    // "RPC failed; curl 18/56 … fatal: early EOF"), so classifyGitHubError's documented
    // non-GitHub-typed-error fallback ("retryable_transient") is the right call HERE, unlike at the
    // unconditional catch-all below.
    return mapGitHubClassification(classifyGitHubError(err), phase);
  }
  const reason = err instanceof Error ? err.message : String(err);
  return { category: "unknown_failure", retryable: false, reason, retryAfterMs: null };
}

function classifyEngineExecutionError(err: EngineExecutionError): OrchestratorFailureClassification {
  const meta = err.meta;
  if (!meta) {
    // No structured classification metadata (an adapter that predates engine-failure-classifier.ts,
    // or a spawn-level failure with no provider response to classify) — conservative default: never
    // retry something we can't actually tell apart from a real failure.
    return { category: "unknown_failure", retryable: false, reason: err.message, retryAfterMs: null };
  }
  if (!meta.retryable) {
    const category: OrchestratorFailureCategory =
      meta.classification === "auth" ? "authentication_failure" : meta.classification === "invalid_request" ? "permanent_configuration_failure" : "task_failure";
    return { category, retryable: false, reason: err.message, retryAfterMs: null };
  }
  // meta.retryable === true here only ever means "rate_limit" or "server_unavailable" — see
  // engine-failure-classifier.ts's own RETRYABLE_STATUS_CODES/classifyCategory. Quota exhaustion has
  // no separate structured category upstream (a 429 is a 429), so this secondary text-pattern check
  // is a best-effort LABEL refinement only — it never changes `retryable` itself, which stays
  // structurally derived from `meta.retryable` either way (see this slice's brief item 2: "do not
  // infer retryability from generic error strings" — retryABILITY isn't inferred here, only which of
  // two already-retryable categories to call it).
  const quotaLike = /quota|resource[_ ]exhausted/i.test(err.message);
  const category: OrchestratorFailureCategory = meta.classification === "rate_limit" ? (quotaLike ? "provider_quota_exhausted" : "rate_limited") : "network_failure";
  // By the time an EngineExecutionError reaches the orchestrator, the adapter's OWN internal retry
  // loop (see opencode-adapter.ts's run()) has already exhausted its budget, having already tried to
  // honor any provider-suggested delay across its own attempts — there is no separate per-request
  // delay left over to hand up here, so this episode-level retry uses its own bounded backoff policy
  // instead (see orchestrator.ts's runEpisodeWithInfrastructureRetry).
  return { category, retryable: true, reason: err.message, retryAfterMs: null };
}

function mapGitHubClassification(gh: ReturnType<typeof classifyGitHubError>, phase: OrchestratorFailurePhase | undefined): OrchestratorFailureClassification {
  switch (gh.category) {
    case "rate_limited":
      return { category: "rate_limited", retryable: true, reason: gh.reason, retryAfterMs: gh.suggestedDelayMs };
    case "auth":
      return { category: "authentication_failure", retryable: false, reason: gh.reason, retryAfterMs: null };
    case "authorization":
    case "not_found":
    case "conflict":
    case "invalid_request":
      return { category: "permanent_configuration_failure", retryable: false, reason: gh.reason, retryAfterMs: null };
    case "retryable_transient":
      // Covers both a real GitHub 5xx/network read failure AND — via classifyGitHubError's own
      // documented fallback for any non-GitHub-typed error — a transient git clone/fetch failure
      // (RPC reset, early EOF, DNS) surfaced from workspace provisioning or a local-git provider.
      return {
        category: phase === "workspace_provisioning" ? "workspace_provision_failure" : "source_control_failure",
        retryable: true,
        reason: gh.reason,
        retryAfterMs: null,
      };
    case "unknown":
      return { category: "unknown_failure", retryable: false, reason: gh.reason, retryAfterMs: null };
  }
}
