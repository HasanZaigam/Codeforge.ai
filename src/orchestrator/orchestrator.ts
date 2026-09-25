import { randomUUID } from "node:crypto";
import type { AgentRole, BugFixVerificationContract, CommitResult, ContextBundle, HumanAnswer, HumanReviewFeedback, OperationClass, Project, PullRequestRef, ReviewResult, StepResult, Task, ValidationResult, VerificationEvidence, Workspace } from "../domain/types.js";
import { transition, canTransition, InvalidTransitionError } from "../domain/task-state-machine.js";
import { BranchMismatchError, BranchNotFoundAtExecutionError, CancellationError, IncompleteDependenciesError, LeaseLostError, PushVerificationError } from "../domain/errors.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { TaskDependencyRepository } from "../persistence/repositories/task-dependency-repository.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { AgentRunRepository } from "../persistence/repositories/agent-run-repository.js";
import type { HumanInputRepository } from "../persistence/repositories/human-input-repository.js";
import type { WorkspaceRepository } from "../persistence/repositories/workspace-repository.js";
import type { ProjectWorkspaceRepository } from "../persistence/repositories/project-workspace-repository.js";
import type { ProjectContextService } from "../project-workspace/project-context-service.js";
import { EngineExecutionError, usageFromError, type CodingEngineRegistry } from "../coding-engine/coding-engine.js";
import type { WorkspaceProvider } from "../workspace/workspace-provider.js";
import type { SourceControlProvider, SourceControlProviderRegistry } from "../source-control/source-control-provider.js";
import { runValidation } from "../validation/validation-runner.js";
import { buildImplementerContext, buildReviewerContext } from "./context-builder.js";
import { loadProjectContextSection } from "./project-context-loader.js";
import { deriveReviewResult, parseVerificationRequest } from "../review/reviewer.js";
import { executeApprovedVerification } from "../review/reviewer-verification.js";
import { deriveFixVerificationStatus, deriveReproductionStatus, runContractCheck } from "../review/bug-fix-verification.js";
import { buildHumanReviewFeedback, deriveHumanReviewOutcome } from "../review/human-review-feedback.js";
import { buildPullRequestDescription, buildPullRequestTitle } from "./pull-request-content.js";
import {
  assertNonTrivial,
  describeReviewCycleExhaustion,
  fromEmptyDiff,
  fromExhaustedSelfFix,
  fromImplementerDraft,
  toHumanInputRequest,
  type NeedsInputRecordInput,
} from "./needs-input.js";
import { hasNoRepositoryChanges } from "../source-control/git-commit.js";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "./config.js";
import { classifyOrchestratorFailure, type OrchestratorFailurePhase } from "./failure-classifier.js";
import { computeBackoffDelayMs, sleepUnlessAborted } from "../coding-engine/retry-backoff.js";
import type { ModelRegistry } from "../routing/model-registry.js";
import { selectModel } from "../routing/model-router.js";
import { deriveHealthOnFailure, deriveHealthOnSuccess } from "../routing/provider-health-policy.js";
import type { ProviderHealthRepository } from "../persistence/repositories/provider-health-repository.js";
// The Orchestrator is otherwise provider-agnostic (see SourceControlProvider), but distinguishing
// "surface this clearly" (auth/permission) from "quietly retry next poll" (transient/rate-limited)
// for a read failure genuinely needs to know which kind of failure this was. The only real remote
// provider today is GitHub, and the classifier's own fallback treats any non-GitHub-typed error as
// transient — safe/inert for local-git, whose listPullRequestFeedback never actually throws. See
// /docs/GITHUB_INTEGRATION.md "Human review feedback ingestion" and TECHNICAL_DECISIONS.md.
import { classifyGitHubError } from "../integrations/github/error-classifier.js";

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/**
 * The deterministic workflow engine driving a task through its lifecycle
 * (see /docs/TASK_LIFECYCLE.md). Owns coordination only — no code-review or
 * implementation judgment lives here; that is entirely delegated to the
 * CodingEngine invocations. Every state transition goes through
 * task-state-machine.transition(), so an invalid transition throws rather
 * than silently corrupting task state.
 */
export class Orchestrator {
  constructor(
    private readonly taskRepo: TaskRepository,
    private readonly eventRepo: TaskEventRepository,
    private readonly projectRepo: ProjectRepository,
    private readonly agentRunRepo: AgentRunRepository,
    private readonly humanInputRepo: HumanInputRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly engines: CodingEngineRegistry,
    private readonly workspaceProvider: WorkspaceProvider,
    private readonly sourceControlProviders: SourceControlProviderRegistry,
    private readonly dependencyRepo: TaskDependencyRepository,
    private readonly ownerId: string,
    private readonly config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
    // Phase 3, Slice 6 — see project-context-loader.ts. Used ONLY to load bounded, read-only
    // project-provided context for AI prompts (via loadProjectContextSection); never consulted for
    // any deterministic orchestration/authorization/lifecycle decision.
    private readonly projectWorkspaceRepo: ProjectWorkspaceRepository | null = null,
    private readonly projectContextService: ProjectContextService | null = null,
    // V1.1 Slice 5 — the platform's own model/provider routing (see routing/model-router.ts and
    // routing/provider-health-policy.ts). Both optional and only ever used together (see runAgent):
    // `null` for either means "no routing" — the coding engine falls back to whatever model it would
    // have used before this slice existed (see EngineInvocationRequest.modelSelection's own doc
    // comment) and no provider-health bookkeeping happens. Backward-compatible by construction: every
    // pre-Slice-5 caller that constructs an Orchestrator directly (not via platform.ts) needs no change.
    private readonly modelRegistry: ModelRegistry | null = null,
    private readonly providerHealthRepo: ProviderHealthRepository | null = null,
  ) {}

  /**
   * Drives one task forward until it reaches REVIEW, NEEDS_INPUT, CANCELLED,
   * or FAILED. Safe to call repeatedly/concurrently for the same taskId:
   * only one call across the whole system will win the claim (see
   * TaskRepository.claimTodo / claimWorking) — the rest return the task
   * unchanged.
   */
  async executeTask(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    const now = () => new Date().toISOString();

    let generation: number;
    if (task.status === "TODO") {
      const claimed = this.taskRepo.claimTodo(taskId, this.ownerId, this.config.taskLeaseMs, now());
      if (claimed === null) {
        return this.requireTask(taskId);
      }
      generation = claimed;
      this.eventRepo.append(taskId, "TASK_CLAIMED", { owner: this.ownerId, generation }, now());
      this.eventRepo.append(taskId, "TASK_STARTED", {}, now());
      task = this.requireTask(taskId);
    } else if (task.status === "WORKING") {
      // Captured BEFORE the claim purely for observability below (item 9: distinguish a genuine
      // takeover-from-another-owner from this process simply resuming its own task) — never used
      // for any decision; the claim's own atomic WHERE clause is what actually decides ownership.
      const previousOwner = task.lockOwner;
      const claimed = this.taskRepo.claimWorking(taskId, this.ownerId, this.config.taskLeaseMs, now());
      if (claimed === null) {
        return task;
      }
      generation = claimed;
      if (previousOwner && previousOwner !== this.ownerId) {
        // Distinct from EXECUTION_LEASE_LOST (the LOSING process's signal) — this is the WINNING
        // process's signal, so a reader of the event log can see both halves of a takeover.
        console.log(`[orchestrator] task ${taskId} — recovered from ${previousOwner} (generation ${generation}).`);
        this.eventRepo.append(taskId, "TASK_CLAIMED", { owner: this.ownerId, generation, recoveredFrom: previousOwner }, now());
      }
    } else {
      return task; // REVIEW / NEEDS_INPUT / DONE / FAILED / CANCELLED: nothing for the orchestrator to drive
    }

    try {
      // Fast path: a cancellation was requested while nothing was actively executing this task
      // (e.g. between worker ticks, or immediately after a crash-recovery reclaim). No point
      // starting a fresh implementer/validation pass just to interrupt it a moment later.
      if (this.taskRepo.isCancelRequested(taskId)) {
        task = await this.finalizeCancellation(this.requireTask(taskId), this.workspaceRepo.findByTaskId(taskId));
      } else if (task.taskRecord.pendingHumanReviewFeedback) {
        // Crash recovery: this WORKING task was originally claimed for a human review feedback fix
        // cycle (see checkHumanReviewFeedback), not from TODO — a process crash mid-cycle leaves
        // `pendingHumanReviewFeedback` set (persisted before any work started), and the next
        // executeTask() call (this one, possibly in a different process) must resume that exact
        // cycle, never the original implement/validate/review pipeline. See
        // /docs/TASK_LIFECYCLE.md "Crash recovery".
        task = await this.withCancellation(taskId, (signal) =>
          this.runEpisodeWithInfrastructureRetry(taskId, generation, signal, () => this.runHumanFeedbackFixCycle(taskId, signal, generation)),
        );
      } else {
        task = await this.withCancellation(taskId, (signal) =>
          this.runEpisodeWithInfrastructureRetry(taskId, generation, signal, () => this.runWorkingEpisode(this.requireTask(taskId), signal, generation)),
        );
      }
    } catch (err) {
      if (err instanceof CancellationError) {
        task = await this.finalizeCancellation(this.requireTask(taskId), this.workspaceRepo.findByTaskId(taskId));
      } else if (err instanceof LeaseLostError) {
        // Another process's claim won — see withCancellation's heartbeat and LeaseLostError's own
        // doc comment for why this must NOT touch task status or the workspace: whoever now holds
        // the lease may be actively, legitimately using both. Just stop and observe current state.
        // Distinct from TASK_FAILED/TASK_CANCELLED (see EXECUTION_LEASE_LOST's own doc comment) so
        // this is unambiguously visible as "fenced out," not a real failure or a human's cancel.
        console.error(`[orchestrator] task ${taskId} — lost the execution lease (generation ${generation}) to another process mid-run; stopping without touching task state.`);
        this.eventRepo.append(taskId, "EXECUTION_LEASE_LOST", { owner: this.ownerId, generation }, now());
        task = this.requireTask(taskId);
      } else {
        // Only genuine platform/infra failures land here — model judgment calls are always
        // routed to NEEDS_INPUT via raiseNeedsInput(), never thrown. This write is itself
        // generation-fenced: a genuine error racing an undetected lease loss must not overwrite
        // whatever the new owner is doing either.
        const fresh = this.requireTask(taskId);
        fresh.status = transition(fresh.status, "infra_failure");
        fresh.completedAt = now();
        // V1.1 Slice 4 — the same classification runEpisodeWithInfrastructureRetry already used to
        // decide whether to retry, re-derived here (a pure function — cheap to call twice) purely to
        // enrich TASK_FAILED's payload with a truthful category/retryable label instead of just the
        // raw error string. See PLATFORM_GAPS.md GAP-027/GAP-028 and task-report.ts's failureCategory.
        const classification = classifyOrchestratorFailure(err, this.inferFailurePhase(taskId));
        if (this.taskRepo.saveOwned(fresh, generation, now())) {
          this.eventRepo.append(taskId, "TASK_FAILED", { error: String(err), category: classification.category, retryable: classification.retryable }, now());
        } else {
          console.error(`[orchestrator] task ${taskId} — infra failure occurred but the execution lease (generation ${generation}) was already lost; not marking FAILED.`);
          this.eventRepo.append(taskId, "EXECUTION_LEASE_LOST", { owner: this.ownerId, generation }, now());
        }
        task = this.requireTask(taskId);
      }
    } finally {
      this.taskRepo.releaseLock(taskId, this.ownerId, now());
    }
    return this.requireTask(taskId);
  }

  /** Human answers a NEEDS_INPUT question; resumes the task without replaying prior transcript. */
  submitHumanAnswer(taskId: string, answer: HumanAnswer, answeredBy: string): Task {
    const now = new Date().toISOString();
    const request = this.humanInputRepo.findOpenForTask(taskId);
    if (!request) throw new Error(`Task ${taskId} has no open NEEDS_INPUT request`);
    this.humanInputRepo.answer(request.id, answer, answeredBy, now);

    const task = this.requireTask(taskId);
    task.taskRecord.decisions.push({
      source: "human_answer",
      summary: answer.freeText || answer.selectedOption || "(no detail provided)",
      recordedAt: now,
    });
    task.taskRecord.selfFixAttempts = 0; // fresh episode: past exhaustion doesn't carry over
    task.status = transition(task.status, "answered");
    this.taskRepo.save(task, now);
    this.eventRepo.append(taskId, "NEEDS_INPUT_ANSWERED", { requestId: request.id }, now);
    return this.requireTask(taskId);
  }

  /** Developer accepts a REVIEW result. */
  acceptReview(taskId: string): Task {
    const now = new Date().toISOString();
    const task = this.requireTask(taskId);
    task.status = transition(task.status, "accepted");
    task.completedAt = now;
    this.taskRepo.save(task, now);
    this.eventRepo.append(taskId, "TASK_ACCEPTED", {}, now);
    this.eventRepo.append(taskId, "TASK_COMPLETED", {}, now);
    return this.requireTask(taskId);
  }

  /** Developer sends a REVIEW result back for more work. */
  requestChanges(taskId: string, note: string): Task {
    const now = new Date().toISOString();
    const task = this.requireTask(taskId);
    task.taskRecord.decisions.push({ source: "human_answer", summary: note, recordedAt: now });
    task.taskRecord.selfFixAttempts = 0;
    task.status = transition(task.status, "changes_requested");
    this.taskRepo.save(task, now);
    this.eventRepo.append(taskId, "TASK_CHANGES_REQUESTED", { note }, now);
    return this.requireTask(taskId);
  }

  /**
   * Releases a BACKLOG task into TODO — the explicit human gate this
   * milestone introduces (see /docs/TASK_LIFECYCLE.md "Task lifecycle").
   * Like requestCancellation, this is a domain command: the caller never
   * writes `status` directly, and the atomic UPDATE...WHERE guard in
   * TaskRepository.releaseFromBacklog (mirroring claimTodo's own pattern)
   * is what actually decides who wins a race between two concurrent
   * "Start Task" requests — only one call's WHERE clause matches, so the
   * loser here throws InvalidTransitionError rather than silently
   * double-processing. A task not currently in BACKLOG (already released,
   * or never existed there) also throws InvalidTransitionError, via the
   * same `canTransition` check every other transition in this file uses,
   * so an invalid attempt never has a different failure shape than any
   * other illegal transition.
   *
   * Also enforces explicit task dependencies (see /docs/TASK_LIFECYCLE.md "Task dependencies"): a
   * task with any dependency not yet DONE may not be released. The actual gate is the `NOT EXISTS`
   * clause built into `TaskRepository.releaseFromBacklog`'s own UPDATE — it re-evaluates every
   * dependency in the SAME atomic statement that flips status, so there is no TOCTOU gap between
   * "checked dependencies" and "released," even under a concurrent dependency edit or a dependency
   * completing mid-request. The `listIncompleteDependencies` call below is only a fast, friendly
   * pre-check for the common (non-racing) case — exactly the same "pre-check + DB-authoritative
   * closure" shape `TaskService.create`'s branch-collision handling already uses — so the error
   * names the incomplete dependencies instead of a bare 409. If the release UPDATE itself still
   * fails after the pre-check passed (a genuine race), the dependencies are re-read once more to
   * report what's actually true now, never a stale message.
   */
  startTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (!canTransition(task.status, "released")) {
      throw new InvalidTransitionError(task.status, "released");
    }
    const incomplete = this.dependencyRepo.listDependencies(taskId).filter((d) => d.status !== "DONE");
    if (incomplete.length > 0) {
      throw new IncompleteDependenciesError(incomplete);
    }
    const now = new Date().toISOString();
    if (!this.taskRepo.releaseFromBacklog(taskId, now)) {
      // Raced with something else between the checks above and this UPDATE — re-read current
      // state to report what's actually true now, rather than a stale/misleading error.
      const fresh = this.requireTask(taskId);
      if (fresh.status !== "BACKLOG") {
        throw new InvalidTransitionError(fresh.status, "released");
      }
      const stillIncomplete = this.dependencyRepo.listDependencies(taskId).filter((d) => d.status !== "DONE");
      throw new IncompleteDependenciesError(stillIncomplete);
    }
    this.eventRepo.append(taskId, "TASK_RELEASED", {}, now);
    return this.requireTask(taskId);
  }

  /**
   * Requests cancellation of a task. This is a domain command, not a status
   * write — the caller (API/application layer) never sets `status`
   * directly, and this method itself never kills a process: it only
   * persists intent and, for states with nothing currently running
   * (TODO/NEEDS_INPUT), finalizes immediately. For WORKING, the actual
   * process termination happens inside whichever executeTask() call is
   * driving the task (see withCancellation) — possibly in a different
   * process (API and worker are separate, see TECHNICAL_DECISIONS.md
   * TD-16) — once it observes the persisted intent this call sets. Safe to
   * call repeatedly: already-CANCELLED is a no-op; a WORKING task with
   * intent already recorded is also a no-op. See /docs/TASK_LIFECYCLE.md
   * "Cancellation" for the full race-condition table.
   */
  async requestCancellation(taskId: string, requestedBy: string): Promise<Task> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = new Date().toISOString();
      const task = this.requireTask(taskId);

      if (task.status === "CANCELLED") return task; // idempotent — repeated requests are safe

      if (!canTransition(task.status, "cancel")) {
        throw new InvalidTransitionError(task.status, "cancel");
      }

      if (task.status === "WORKING") {
        const isNew = this.taskRepo.requestCancellationIntentOnWorking(taskId, requestedBy, now);
        if (isNew) {
          this.eventRepo.append(taskId, "CANCEL_REQUESTED", { requestedBy }, now);
        }
        return this.requireTask(taskId); // still WORKING — the in-flight execution finalizes it
      }

      // BACKLOG, TODO, or NEEDS_INPUT: nothing is currently executing anywhere — finalize immediately.
      const won =
        task.status === "BACKLOG"
          ? this.taskRepo.finalizeCancellationOnBacklog(taskId, requestedBy, now)
          : task.status === "TODO"
            ? this.taskRepo.finalizeCancellationOnTodo(taskId, requestedBy, now)
            : this.taskRepo.finalizeCancellationOnNeedsInput(taskId, requestedBy, now);

      if (!won) continue; // raced with a claim/answer — retry against fresh state

      this.eventRepo.append(taskId, "CANCEL_REQUESTED", { requestedBy }, now);
      await this.cleanupWorkspace(taskId, this.workspaceRepo.findByTaskId(taskId));
      this.eventRepo.append(taskId, "TASK_CANCELLED", { requestedBy }, new Date().toISOString());
      return this.requireTask(taskId);
    }

    throw new Error(`Could not resolve cancellation for task ${taskId}: too many concurrent state changes`);
  }

  /**
   * Finds WORKING tasks whose execution lease expired (worker crashed
   * mid-run) and marks their orphaned AgentRuns interrupted so the next
   * executeTask() call re-claims and re-runs the current step cleanly. See
   * /docs/TECHNICAL_DECISIONS.md TD-12 (idempotency + recovery). A pending
   * cancellation on a recovered task needs no special handling here: the
   * next executeTask() call's fast-path check (see above) finalizes it
   * immediately instead of resuming work.
   */
  recoverOrphanedTasks(): string[] {
    const now = new Date().toISOString();
    const orphaned = this.taskRepo.findOrphanedWorking(now);
    const running = this.agentRunRepo.findRunning();
    for (const run of running) {
      if (orphaned.some((t) => t.id === run.taskId)) {
        this.agentRunRepo.complete(run.id, "interrupted", null, "worker crashed before completion", null, now);
      }
    }
    return orphaned.map((t) => t.id);
  }

  /**
   * Polls a REVIEW task's PR for (1) a merge/close on GitHub — see "PR merge
   * sync" below — and, only if still open, (2) new human feedback (see
   * SourceControlProvider.listPullRequestFeedback), running a bounded fix
   * cycle in the SAME workspace/branch before returning the task to REVIEW
   * if a "changes requested" review is found — see /docs/TASK_LIFECYCLE.md
   * "Human review feedback loop". A no-op for any task that isn't REVIEW
   * with a PR already opened. Safe to call repeatedly/concurrently for the
   * same taskId: at most one call wins the REVIEW->WORKING claim
   * (claimReviewForHumanFeedback), and every feedback item is recorded in
   * `processedHumanFeedbackIds` before it can trigger a second fix cycle —
   * see requirement "duplicate GitHub feedback is ignored".
   *
   * PR merge sync (see /docs/TASK_LIFECYCLE.md "PR merge sync" and
   * /docs/GITHUB_INTEGRATION.md "PR state handling"): this platform never
   * auto-merges a PR, but a human merging it directly on GitHub is a real,
   * final acceptance signal — this closes the gap where a task would
   * otherwise sit in REVIEW forever after that happens. Deliberately reuses
   * this exact poll (same cadence, same REVIEW-task loop the worker already
   * runs every tick) rather than adding a second poller — see
   * /docs/TECHNICAL_DECISIONS.md for why. A merged PR completes the task
   * (REVIEW -> DONE, idempotent and race-safe — see
   * TaskRepository.finalizeReviewAsDoneOnMerge); a PR closed WITHOUT being
   * merged never completes the task — it just stays REVIEW, same as today.
   */
  async checkHumanReviewFeedback(taskId: string): Promise<Task> {
    const now = () => new Date().toISOString();
    let task = this.requireTask(taskId);
    if (task.status !== "REVIEW" || !task.taskRecord.pullRequest) return task;

    const project = this.requireProject(task.projectId);
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
    const pr = task.taskRecord.pullRequest;

    let prStatus;
    try {
      prStatus = await scProvider.getPullRequestStatus(project, pr, new AbortController().signal);
    } catch (err) {
      // Same visibility policy as the feedback-fetch failure handling below (see its own comment):
      // a transient/rate-limited read failure just retries next poll; anything else (e.g. a revoked
      // token) is surfaced via the existing SOURCE_CONTROL_FAILED event, but never fails the task —
      // and, critically, never risks a false DONE off a failed/uncertain status read.
      const reason = err instanceof Error ? err.message : String(err);
      const classification = classifyGitHubError(err);
      console.error(`[orchestrator] task ${taskId} — failed to fetch pull request status (${classification.category}): ${reason}`);
      if (classification.category !== "retryable_transient" && classification.category !== "rate_limited") {
        this.eventRepo.append(task.id, "SOURCE_CONTROL_FAILED", { step: "check_pull_request_status", error: reason }, now());
      }
      this.maybeExtendReviewBackoff(taskId, classification);
      return task;
    }

    if (prStatus.merged) {
      return this.finalizeMergedPullRequest(taskId, pr, now);
    }
    if (prStatus.state === "closed") {
      // Closed WITHOUT being merged: per the product principle, this must never become DONE — it
      // simply stays REVIEW (there is nothing further to do; a human closed it, they can reopen it
      // or start a new task). No event: nothing changed from the task's perspective, and this would
      // otherwise fire on every single poll for as long as the PR stays closed.
      return task;
    }

    let items;
    try {
      items = await scProvider.listPullRequestFeedback(project, pr, new AbortController().signal);
    } catch (err) {
      // A transient/rate-limited read failure must never fail the task itself — the next poll
      // retries, and a server log line is enough (no permanent audit-trail entry for something
      // expected to self-heal). An auth/permission/other failure is a real, likely-persistent
      // problem (e.g. a revoked GitHub token) — that needs to be *visible*, not just logged, so it
      // doesn't silently poll-and-fail forever with nothing for a developer to see. Reuses the
      // existing SOURCE_CONTROL_FAILED event (same one commit/push/PR-creation failures already
      // use) rather than inventing a new event type — see /docs/GITHUB_INTEGRATION.md.
      const reason = err instanceof Error ? err.message : String(err);
      const classification = classifyGitHubError(err);
      console.error(`[orchestrator] task ${taskId} — failed to fetch human review feedback (${classification.category}): ${reason}`);
      if (classification.category !== "retryable_transient" && classification.category !== "rate_limited") {
        this.eventRepo.append(task.id, "SOURCE_CONTROL_FAILED", { step: "check_review_feedback", error: reason }, now());
      }
      this.maybeExtendReviewBackoff(taskId, classification);
      return task;
    }

    const alreadyProcessed = new Set(task.taskRecord.processedHumanFeedbackIds);
    const outcome = deriveHumanReviewOutcome(items, alreadyProcessed);
    if (outcome.newItems.length === 0) return task; // nothing new — safe, idempotent no-op

    if (!outcome.changesRequested) {
      // Approvals and/or plain comments only — nothing actionable. Per requirement: preserve REVIEW,
      // never auto-merge, never invent a new terminal state. Still mark processed so a repeated poll
      // doesn't keep re-detecting the same approval/comment.
      this.eventRepo.append(taskId, "HUMAN_REVIEW_DETECTED", { newItemCount: outcome.newItems.length }, now());
      if (outcome.approvals.length > 0) {
        this.eventRepo.append(taskId, "HUMAN_REVIEW_APPROVED", { reviewer: outcome.approvals.at(-1)!.authorLogin }, now());
      }
      task.taskRecord.processedHumanFeedbackIds = [...alreadyProcessed, ...outcome.newItems.map((i) => i.id)];
      // Deliberately `save()`, not `saveOwned()`: this branch never calls
      // `claimReviewForHumanFeedback` (that claim only happens further down, in the actionable
      // "changes requested" branch below) — the task is still REVIEW here, not claimed into WORKING,
      // and this process holds no execution lease/generation at this point to fence against. There is
      // nothing to pass `saveOwned` as a generation, and fabricating one (e.g. reusing a stale
      // `task.lockGeneration` read before this write) would not express real ownership — it would
      // just silently succeed or fail based on a value that was never actually claimed here, which is
      // worse than `save()`'s honest "unconditional write" semantics. This matches `save()`'s own doc
      // comment: reserved for call sites that legitimately don't hold an execution lease. (A separate,
      // pre-existing, out-of-scope race exists here too: two concurrent pollers could both reach this
      // branch and each unconditionally overwrite `processedHumanFeedbackIds` with their own read of
      // `alreadyProcessed` — worst case is a duplicate-processed id being briefly "forgotten" and
      // re-detected on the next poll, not a lost or corrupted task state; not addressed by this pass.)
      this.taskRepo.save(task, now());
      return this.requireTask(taskId);
    }

    // Actionable: claim the task (REVIEW -> WORKING) before doing anything else — this is the
    // single atomic guard against two concurrent pollers both starting a fix cycle.
    const claimed = this.taskRepo.claimReviewForHumanFeedback(taskId, this.ownerId, this.config.taskLeaseMs, now());
    if (claimed === null) {
      return this.requireTask(taskId); // lost the race — another process is already handling this
    }
    const generation = claimed;

    task = this.requireTask(taskId);
    const feedback = buildHumanReviewFeedback(outcome.changesRequested, outcome.newItems);
    // Marked processed AND persisted as the pending fix (`pendingHumanReviewFeedback`) immediately
    // after winning the claim, before the fix cycle runs — a crash or cancellation mid-fix must
    // never leave this feedback re-triggerable on the next poll, and must let a restarted process
    // resume this exact cycle (see executeTask's dispatch and runHumanFeedbackFixCycle below).
    task.taskRecord.processedHumanFeedbackIds = [...alreadyProcessed, ...outcome.newItems.map((i) => i.id)];
    task.taskRecord.pendingHumanReviewFeedback = feedback;
    this.taskRepo.save(task, now());
    this.eventRepo.append(taskId, "HUMAN_REVIEW_DETECTED", { newItemCount: outcome.newItems.length }, now());
    // Emitted exactly once, here — not inside runHumanFeedbackFixCycle — so a crash-recovery
    // re-entry into that method (which can happen multiple times for the same cycle) never
    // duplicates it. See /docs/TASK_LIFECYCLE.md "Crash recovery".
    this.eventRepo.append(taskId, "HUMAN_REVIEW_CHANGES_REQUESTED", { reviewer: feedback.reviewerLogin }, now());

    try {
      if (this.taskRepo.isCancelRequested(taskId)) {
        task = await this.finalizeCancellation(this.requireTask(taskId), this.workspaceRepo.findByTaskId(taskId));
      } else {
        task = await this.withCancellation(taskId, (signal) =>
          this.runEpisodeWithInfrastructureRetry(taskId, generation, signal, () => this.runHumanFeedbackFixCycle(taskId, signal, generation)),
        );
      }
    } catch (err) {
      if (err instanceof CancellationError) {
        task = await this.finalizeCancellation(this.requireTask(taskId), this.workspaceRepo.findByTaskId(taskId));
      } else if (err instanceof LeaseLostError) {
        // See executeTask's identical branch and LeaseLostError's own doc comment — never touch
        // task status or the workspace here; another process now legitimately owns both.
        console.error(`[orchestrator] task ${taskId} — lost the execution lease (generation ${generation}) to another process mid-run; stopping without touching task state.`);
        this.eventRepo.append(taskId, "EXECUTION_LEASE_LOST", { owner: this.ownerId, generation }, now());
        task = this.requireTask(taskId);
      } else {
        const fresh = this.requireTask(taskId);
        fresh.status = transition(fresh.status, "infra_failure");
        fresh.completedAt = now();
        // V1.1 Slice 4 — the same classification runEpisodeWithInfrastructureRetry already used to
        // decide whether to retry, re-derived here (a pure function — cheap to call twice) purely to
        // enrich TASK_FAILED's payload with a truthful category/retryable label instead of just the
        // raw error string. See PLATFORM_GAPS.md GAP-027/GAP-028 and task-report.ts's failureCategory.
        const classification = classifyOrchestratorFailure(err, this.inferFailurePhase(taskId));
        if (this.taskRepo.saveOwned(fresh, generation, now())) {
          this.eventRepo.append(taskId, "TASK_FAILED", { error: String(err), category: classification.category, retryable: classification.retryable }, now());
        } else {
          console.error(`[orchestrator] task ${taskId} — infra failure occurred but the execution lease (generation ${generation}) was already lost; not marking FAILED.`);
          this.eventRepo.append(taskId, "EXECUTION_LEASE_LOST", { owner: this.ownerId, generation }, now());
        }
        task = this.requireTask(taskId);
      }
    } finally {
      this.taskRepo.releaseLock(taskId, this.ownerId, now());
    }
    return this.requireTask(taskId);
  }

  /**
   * Completes a REVIEW task whose PR was found merged on GitHub — see
   * checkHumanReviewFeedback's "PR merge sync" doc comment and
   * /docs/TASK_LIFECYCLE.md "PR merge sync". Never touches the workspace,
   * never re-runs the Implementer/Reviewer, never opens/modifies a PR — the
   * PR is already merged; this only records that fact against the task.
   * Race-safe and idempotent by construction: `finalizeReviewAsDoneOnMerge`
   * is a single atomic UPDATE guarded on `status = 'REVIEW'`, so if another
   * process already finalized this task (or claimed it into WORKING for a
   * human-feedback fix cycle in the same instant), this call is a silent
   * no-op — the event below is only appended when THIS call actually won.
   *
   * Deliberately appends only `PULL_REQUEST_MERGED`, not the generic
   * `TASK_COMPLETED` acceptReview() also appends — `PULL_REQUEST_MERGED` is
   * itself an unambiguous, final completion signal, and staying the single
   * most-recent event is what lets the API layer (see toTaskDTO's
   * `deriveCurrentActivity`) render the specific "Completed — PR #N merged"
   * activity text instead of the generic "Done" a manual Accept produces.
   */
  private finalizeMergedPullRequest(taskId: string, pr: PullRequestRef, now: () => string): Task {
    const wonHere = this.taskRepo.finalizeReviewAsDoneOnMerge(taskId, now());
    if (wonHere) {
      this.eventRepo.append(taskId, "PULL_REQUEST_MERGED", { provider: pr.provider, number: pr.number, url: pr.url }, now());
    }
    return this.requireTask(taskId);
  }

  /**
   * Pushes a REVIEW task's `next_review_check_at` further out than the optimistic schedule
   * Worker.tick's own `claimReviewCheck` already set (now + `reviewPollIntervalMs`) — called only
   * from checkHumanReviewFeedback's two read-failure catch blocks above. A plain
   * `retryable_transient`/`auth`/other failure needs no extra handling here: the claim already
   * deferred the next attempt by a full `reviewPollIntervalMs`, which is exactly the "don't hammer
   * every tick" behavior this milestone requires (see /docs/TASK_LIFECYCLE.md "REVIEW polling") —
   * including for `auth`, whose own persistent-failure visibility (SOURCE_CONTROL_FAILED) is
   * unaffected by this method and handled entirely by the caller. Only `rate_limited` carries a
   * concrete external signal (GitHub's own `Retry-After`/rate-limit-reset) that can legitimately be
   * LONGER than the normal cadence — when it is, this extends the schedule to match it instead of
   * silently retrying sooner than GitHub itself says is safe. Never called for a task this process
   * didn't just win the claim for, so there is no ownership race to guard against the way
   * `claimReviewCheck`'s own WHERE clause must (see TaskRepository.rescheduleReviewCheck's own doc
   * comment).
   */
  private maybeExtendReviewBackoff(taskId: string, classification: ReturnType<typeof classifyGitHubError>): void {
    if (classification.category !== "rate_limited" || classification.suggestedDelayMs === null) return;
    if (classification.suggestedDelayMs <= this.config.reviewPollIntervalMs) return;
    const nextCheckAt = new Date(Date.now() + classification.suggestedDelayMs).toISOString();
    this.taskRepo.rescheduleReviewCheck(taskId, nextCheckAt);
    console.error(`[orchestrator] task ${taskId} — rate limited; deferring next REVIEW check to ${nextCheckAt} (suggested ${classification.suggestedDelayMs}ms)`);
  }

  // -------------------------------------------------------------------------
  // Cancellation internals
  // -------------------------------------------------------------------------

  /**
   * Wraps one task's WORKING episode with a live AbortSignal and a
   * lightweight watcher that polls the persisted cancellation intent
   * (TaskRepository.isCancelRequested) and aborts the signal the moment it
   * appears — independent of whatever step is currently running, so a
   * cancellation takes effect mid-step, not just between steps. This is the
   * only mechanism that can actually interrupt a live agent/validation
   * child process; requestCancellation() itself never touches a process
   * directly (see its own doc comment).
   */
  private async withCancellation<T>(taskId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let leaseLost = false;
    const watcher = setInterval(() => {
      if (!controller.signal.aborted && this.taskRepo.isCancelRequested(taskId)) {
        controller.abort();
      }
    }, this.config.cancellationPollIntervalMs);
    // Renews this process's execution lease periodically for as long as `work` is genuinely still
    // running — without this, an episode whose total wall-clock time exceeds `taskLeaseMs` (easily
    // possible across multiple self-fix/review cycles) would look orphaned to
    // recoverOrphanedTasks/claimWorking even though nothing crashed, letting a second process
    // reclaim and double-execute the same task. See /docs/TASK_LIFECYCLE.md "Crash recovery".
    //
    // If renewal ever fails (claimWorking returns false), this process no longer holds the lease —
    // another process's claim won, most likely because this one crashed/stalled long enough for the
    // lease to genuinely expire and someone else recovered it. Aborting here stops this process's
    // own work at its next checkpoint (throwIfCancelled), and `leaseLost` tells the catch below to
    // treat WHATEVER comes out of `work()` afterward (a CancellationError from our own abort, or any
    // other error/success racing it) as "lease lost," never as this process's own outcome to act on
    // — see LeaseLostError's own doc comment for why touching task state here would be actively
    // dangerous to whichever process now legitimately owns the lease.
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted) return;
      // renewWorkingLease, not claimWorking: this must succeed ONLY for the current owner and must
      // NEVER advance lock_generation — a heartbeat is this same execution proving it's still
      // alive, not a new ownership event. See TaskRepository.renewWorkingLease's own doc comment.
      const renewed = this.taskRepo.renewWorkingLease(taskId, this.ownerId, this.config.taskLeaseMs, new Date().toISOString());
      if (!renewed) {
        leaseLost = true;
        controller.abort();
      }
    }, this.config.leaseHeartbeatIntervalMs);
    try {
      const result = await work(controller.signal);
      // Even a clean success is not this process's to act on if the lease was lost right at the
      // very end (e.g. the last checkpoint passed just before renewal failed) — the result itself
      // may be racing whatever the new lease holder is doing. Discard it the same way a mid-flight
      // failure is discarded.
      if (leaseLost) throw new LeaseLostError();
      return result;
    } catch (err) {
      if (leaseLost) throw new LeaseLostError();
      throw err;
    } finally {
      clearInterval(watcher);
      clearInterval(heartbeat);
    }
  }

  /**
   * Transitions a task to CANCELLED and cleans up its workspace. Idempotent
   * — if the task is already CANCELLED (e.g. finalized by a racing caller),
   * this is a no-op returning the current task. `workspace` may be null
   * (nothing was ever provisioned, e.g. cancelled while still TODO).
   */
  private async finalizeCancellation(task: Task, workspace: Workspace | null): Promise<Task> {
    const fresh = this.requireTask(task.id);
    if (fresh.status === "CANCELLED") return fresh;

    await this.cleanupWorkspace(task.id, workspace);

    const now = new Date().toISOString();
    fresh.status = transition(fresh.status, "cancel");
    fresh.completedAt = now;
    this.taskRepo.save(fresh, now);
    this.eventRepo.append(task.id, "EXECUTION_CANCELLED", { requestedBy: fresh.cancelRequestedBy }, now);
    this.eventRepo.append(task.id, "TASK_CANCELLED", { requestedBy: fresh.cancelRequestedBy }, now);
    return this.requireTask(task.id);
  }

  /**
   * Stops active processes for a task's workspace and removes the disposable
   * clone — never the connected project's own repository, only this task's
   * isolated copy (see /docs/SECURITY_ARCHITECTURE.md, WorkspaceProvider).
   * The Workspace row itself, and every TaskEvent/AgentRun recorded so far,
   * are left untouched: that's the audit evidence of what happened before
   * cancellation, and cleanup must never remove it. Best-effort: a cleanup
   * failure is recorded but never blocks finalizing CANCELLED — a leftover
   * directory is a cleanup bug to fix later, not a reason to leave the task
   * stuck.
   */
  private async cleanupWorkspace(taskId: string, workspace: Workspace | null): Promise<void> {
    if (!workspace || workspace.status === "torn_down") return;
    const now = () => new Date().toISOString();
    this.eventRepo.append(taskId, "WORKSPACE_CLEANUP_STARTED", {}, now());
    try {
      await this.workspaceProvider.destroy(workspace);
      this.eventRepo.append(taskId, "WORKSPACE_CLEANUP_COMPLETED", {}, now());
    } catch (err) {
      this.eventRepo.append(taskId, "WORKSPACE_CLEANUP_COMPLETED", { error: String(err) }, now());
    }
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new CancellationError();
  }

  // -------------------------------------------------------------------------
  // Lease-generation fencing (see /docs/TASK_LIFECYCLE.md "Worker concurrency and lease loss")
  // -------------------------------------------------------------------------

  /**
   * The ONLY way a live execution (runWorkingEpisode / runHumanFeedbackFixCycle / runAgent and
   * everything they call) may persist a Task write. Wraps TaskRepository.saveOwned and turns a
   * failed (generation-mismatched) write into a LeaseLostError, so every call site downstream gets
   * uniform, correct handling via the existing executeTask/checkHumanReviewFeedback catch blocks —
   * callers never need to check a boolean themselves.
   */
  private saveOwned(task: Task, generation: number, now: string): void {
    if (!this.taskRepo.saveOwned(task, generation, now)) {
      throw new LeaseLostError();
    }
  }

  /**
   * Authoritative, DB-backed ownership check performed immediately before each high-consequence
   * side effect this milestone calls out explicitly (validation commands, git commit, git push, PR
   * creation/update — see runValidationStep/prepareChanges/ensurePullRequest below): re-reads the
   * task's CURRENT lock_generation and compares it against the generation this execution was
   * granted at claim time. A single in-memory `leaseLost` flag (set only by withCancellation's own
   * heartbeat, on its own polling cadence) is not good enough on its own to gate an external
   * git/GitHub call — this makes the DB itself the source of truth at the exact moment before the
   * call, narrowing (not eliminating — see the module-level caveat below) the window.
   *
   * IMPORTANT, and impossible to fully close with this architecture: this check and the external
   * call it guards are still two separate operations, not one atomic transaction. A takeover that
   * lands in the instant between this check returning and the external call actually starting is a
   * real, unavoidable residual race — see docs/TASK_LIFECYCLE.md "Worker concurrency and lease
   * loss" and this task's own "Remaining limitations." What this DOES fully close is the much
   * larger, easily-hit window of "an execution that lost its lease minutes ago, and hasn't reached
   * a heartbeat tick yet, being allowed to commit/push/open a PR at all."
   */
  private assertStillOwned(taskId: string, generation: number): void {
    const current = this.taskRepo.findById(taskId);
    if (!current || current.lockGeneration !== generation) {
      throw new LeaseLostError();
    }
  }

  // -------------------------------------------------------------------------
  // Infrastructure-failure retry (V1.1 Slice 4 — see PLATFORM_GAPS.md GAP-027/GAP-028)
  // -------------------------------------------------------------------------

  /**
   * Wraps one episode-level unit of work (`runWorkingEpisode` or
   * `runHumanFeedbackFixCycle`, called via `runOnce`) with bounded, classified infrastructure retry —
   * the direct fix for GAP-027 (a provider quota limit turning every queued task into a permanent
   * failure) and GAP-028 (transient clone/timeout failures with no retry anywhere). This is
   * conceptually DISTINCT from crash recovery (see item 15 of this slice's brief): crash recovery is
   * what happens when the WORKER PROCESS itself disappears (lease expiry + orphan detection + a
   * second process resuming — see recoverOrphanedTasks); this is what happens when the CURRENT,
   * still-alive process's own operation failed for a transient external/system reason. They share the
   * same lease-fencing primitive (`assertStillOwned`) but are otherwise independent — this method
   * never touches task status, never re-claims anything, and a task that exhausts its retry budget
   * here still falls through to the exact same TASK_FAILED path every other genuine failure already
   * used before this slice.
   *
   * A retried attempt is never "resume from scratch" in the wasteful sense (see item 26 of this
   * slice's brief) — `runOnce` re-enters `runWorkingEpisode`/`runHumanFeedbackFixCycle` from the top,
   * and it is THEIR OWN pre-existing idempotent-step design (a `ready` workspace is reused rather than
   * re-cloned, `commitAllLocal` is a no-op when there is nothing new to commit, `ensurePullRequest`
   * short-circuits once `taskRecord.pullRequest` is set) — the exact same properties crash recovery
   * already depends on — that makes re-entry land back at the last safe boundary. No second resume
   * mechanism was built for this slice; it reuses the one that already existed.
   *
   * Bounded by `config.maxInfrastructureRetries` extra attempts (0 disables this entirely). Backoff
   * is `retry-backoff.ts`'s existing bounded exponential-with-jitter helper (the same one
   * OpenCodeAdapter/GitHubClient already use), taking the larger of the computed backoff and any
   * provider/GitHub-suggested `retryAfterMs`, capped at `config.infrastructureRetryMaxDelayMs` either
   * way so a provider can never force an effectively unbounded wait. The wait itself is cancellable
   * (`sleepUnlessAborted`, the SAME `signal` `withCancellation`'s own watcher/heartbeat already govern
   * for the whole call — see this method's callers), so a cancellation requested mid-backoff is
   * honored immediately rather than waiting out the delay — see item 13 of this slice's brief.
   */
  private async runEpisodeWithInfrastructureRetry(taskId: string, generation: number, signal: AbortSignal, runOnce: () => Promise<Task>): Promise<Task> {
    const now = () => new Date().toISOString();
    const maxAttempts = this.config.maxInfrastructureRetries + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await runOnce();
      } catch (err) {
        // Cancellation and lease loss are never classified or retried here — they already have
        // their own correct, dedicated handling in the caller's own catch block (executeTask /
        // checkHumanReviewFeedback), unchanged by this slice. Retrying either would be actively
        // wrong: a human asked this to stop, or another process now legitimately owns the task.
        if (err instanceof CancellationError || err instanceof LeaseLostError) throw err;

        const classification = classifyOrchestratorFailure(err, this.inferFailurePhase(taskId));
        this.eventRepo.append(
          taskId,
          "INFRASTRUCTURE_FAILURE_DETECTED",
          { category: classification.category, retryable: classification.retryable, reason: classification.reason, attempt },
          now(),
        );

        if (!classification.retryable || attempt >= maxAttempts) throw err;

        const backoffMs = computeBackoffDelayMs(attempt, this.config.infrastructureRetryBaseDelayMs, this.config.infrastructureRetryMaxDelayMs);
        const delayMs =
          classification.retryAfterMs !== null ? Math.min(Math.max(backoffMs, classification.retryAfterMs), this.config.infrastructureRetryMaxDelayMs) : backoffMs;
        this.eventRepo.append(
          taskId,
          "INFRASTRUCTURE_RETRY_SCHEDULED",
          { attempt, maxAttempts, delayMs, retryAfterMs: classification.retryAfterMs },
          now(),
        );
        console.warn(`[orchestrator] task ${taskId} — infrastructure failure (category=${classification.category}), retrying attempt ${attempt + 1}/${maxAttempts} in ${delayMs}ms: ${classification.reason}`);

        await sleepUnlessAborted(delayMs, signal, () => new CancellationError());
        // Item 14: re-verify ownership before resuming real work — narrows (does not eliminate, see
        // assertStillOwned's own doc comment) the window between waking up and the next side effect.
        this.assertStillOwned(taskId, generation);
        this.eventRepo.append(taskId, "INFRASTRUCTURE_RETRY_STARTED", { attempt: attempt + 1 }, now());
      }
    }
  }

  /**
   * Best-effort phase hint for classifyOrchestratorFailure — inferred from the most recent
   * WORKSPACE_FAILED/SOURCE_CONTROL_FAILED event (both already appended, with their own catch
   * blocks, by provisionWorkspace/prepareChanges/ensurePullRequest before rethrowing) rather than
   * threading a phase parameter through every call site. `undefined` when neither has fired since
   * the episode began (e.g. an engine/AgentRun failure, which classifyOrchestratorFailure identifies
   * from the error's own type regardless of phase).
   */
  private inferFailurePhase(taskId: string): OrchestratorFailurePhase | undefined {
    const last = [...this.eventRepo.listForTask(taskId)].reverse().find((e) => e.type === "WORKSPACE_FAILED" || e.type === "SOURCE_CONTROL_FAILED");
    if (!last) return undefined;
    return last.type === "WORKSPACE_FAILED" ? "workspace_provisioning" : "commit_or_push_or_pr";
  }

  // -------------------------------------------------------------------------
  // Internal execution
  // -------------------------------------------------------------------------

  private async runWorkingEpisode(task: Task, signal: AbortSignal, generation: number): Promise<Task> {
    const now = () => new Date().toISOString();
    const project = this.requireProject(task.projectId);
    const engine = this.engines.resolve(project.codingEngine);
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);

    // Branch modes (see /docs/TASK_LIFECYCLE.md "Branch modes" and domain/types.ts BranchMode):
    // "existing" checks out task.workingBranch directly and never creates a branch — the clone's
    // own "base" IS the target branch. "new" (default, and the only behavior that existed before
    // branch modes did) creates an isolated branch — task.workingBranch is an optional custom name
    // (falling back to taskRecord.branchName, then the historical auto-derived name), and the base
    // to branch off of is task.baseBranch if the user overrode it, else the project's default.
    const branchMode = task.branchMode ?? "new";
    const branchName =
      branchMode === "existing"
        ? task.workingBranch! // required + validated at task-creation time — see TaskService.create
        : (task.taskRecord.branchName ?? task.workingBranch ?? `task/${task.id.slice(0, 8)}`);
    const cloneBaseBranch = branchMode === "existing" ? branchName : (task.baseBranch ?? project.defaultBranch);
    // The PR's own base (merge target) is always the actual branch this task's changes should land
    // on: for "new" mode that's whatever base it was branched from (which may not be the project's
    // default branch, if the user overrode it); for "existing" mode there is no separate "base to
    // branch from" concept, so it's always the project's default branch.
    const pullRequestBaseBranch = branchMode === "existing" ? project.defaultBranch : cloneBaseBranch;

    task.taskRecord.branchName = branchName;
    this.saveOwned(task, generation, now());

    const workspace = await this.provisionWorkspace(task, project, scProvider, branchName, cloneBaseBranch, branchMode, signal, generation);
    task.workspaceId = workspace.id;
    this.saveOwned(task, generation, now());

    // Phase 3, Slice 6 — one snapshot per working episode, reused by every implementer/reviewer
    // call below. See loadProjectContext's own doc comment.
    const projectContext = this.loadProjectContext(project);

    // V1.1 Slice 3 (see PLATFORM_GAPS.md GAP-016, "reproduce, then confirm fixed"): only for a task
    // created with a BugFixVerificationContract, and only once — against the workspace's pristine
    // starting state, before the Implementer has touched anything. Idempotent by construction (same
    // pattern as WORKSPACE_CREATED/COMMIT_CREATED elsewhere in this method): the check is "has this
    // already been recorded," not a separate recovery mechanism — a crash before this persists just
    // means the next resume finds `reproduction === null` and runs it again, fresh, off the same
    // still-untouched workspace; a crash after it persists means resume correctly skips it.
    if (task.taskRecord.bugFixVerification?.contract && !task.taskRecord.bugFixVerification.reproduction) {
      await this.runBugReproduction(task, project, workspace, signal, generation);
    }

    let lastValidation: ValidationResult | null = null;
    let lastImplementerResult: StepResult | null = null;
    // V1.1 Slice 1 — the platform's own git evidence from the most recent commit, threaded into the
    // Reviewer's context instead of the Implementer's self-reported file list. See
    // context-builder.ts's buildReviewerContext doc comment.
    let lastCommitResult: CommitResult | null = null;

    // ---- self-fix loop: implement -> validate -> (diagnose+fix) -> validate ----
    for (;;) {
      this.throwIfCancelled(signal);
      const attemptNumber = this.nextAttemptNumber(task.id, "implementer");
      const context = buildImplementerContext(task, project, workspace.path, lastValidation, null, null, projectContext);
      const step = await this.runAgent(task, project, engine, "implementer", context, attemptNumber, signal, generation, this.implementerOperation(task));

      if (step.status === "needs_input" && step.needsInput) {
        return this.raiseNeedsInput(task, fromImplementerDraft(step.needsInput), generation);
      }

      lastImplementerResult = step;
      lastValidation = await this.runValidationStep(task, workspace.path, project.commands, signal, generation);

      if (lastValidation.status === "passed") break;

      task.taskRecord.selfFixAttempts = attemptNumber;
      this.saveOwned(task, generation, now());

      if (attemptNumber >= this.config.maxSelfFixAttempts) {
        return this.raiseNeedsInput(task, fromExhaustedSelfFix(lastValidation.checks, attemptNumber), generation);
      }
      this.eventRepo.append(task.id, "RETRY_STARTED", { nextAttempt: attemptNumber + 1 }, now());
    }

    this.throwIfCancelled(signal);

    // Zero-change detection (see /docs/TASK_LIFECYCLE.md "Zero-change detection"): the implementer
    // may correctly decide, after real investigation, that no file should be changed at all (e.g.
    // the target already exists and the task forbids modifying existing files). Detecting that
    // BEFORE ever calling commitAll/push/openPullRequest avoids pushing a no-op branch and hitting
    // GitHub's PR-creation 422 ("No commits between base and head") — this is never reachable once
    // a PR already exists for this task, since that only happens after a real, non-empty commit
    // was pushed on a prior pass. `workspace.baseCommit` can in principle be null for a
    // WorkspaceProvider that doesn't record one — fail open (proceed to commit/push as before)
    // rather than block a task this check can't actually evaluate.
    if (workspace.baseCommit && (await hasNoRepositoryChanges(workspace.path, workspace.baseCommit, signal))) {
      this.eventRepo.append(task.id, "NO_CHANGES_DETECTED", { branch: workspace.branch }, now());
      return this.raiseNeedsInput(task, fromEmptyDiff(lastImplementerResult?.summary ?? ""), generation);
    }

    lastCommitResult = await this.prepareChanges(task, project, scProvider, workspace.path, workspace.branch, signal, generation);
    if (task.taskRecord.bugFixVerification?.contract) {
      await this.runFixVerification(task, project, workspace, signal, generation);
    }

    // ---- independent review loop (review/fix cycle) ----
    // Invariants preserved across every cycle (see /docs/TASK_LIFECYCLE.md "Review/fix cycle" and
    // /docs/GITHUB_INTEGRATION.md "PR idempotency"): one workspace (`workspace`, provisioned once
    // above), one branch (`workspace.branch`), one PR (ensurePullRequest's own idempotency guard).
    // A rejection re-runs only the Implementer + validation + commit/push — never re-provisions the
    // workspace, never creates a second branch, never opens a second PR.
    let cycles = 0;
    for (;;) {
      this.throwIfCancelled(signal);
      const reviewAttemptNumber = this.nextAttemptNumber(task.id, "reviewer");
      this.eventRepo.append(task.id, "REVIEW_STARTED", { attemptNumber: reviewAttemptNumber }, now());
      const reviewContext = buildReviewerContext(task, project, workspace.path, lastImplementerResult, lastValidation, projectContext, lastCommitResult?.changedFiles ?? null);
      let reviewStep = await this.runAgent(task, project, engine, "reviewer", reviewContext, reviewAttemptNumber, signal, generation, "reviewer");

      // V1.1 Slice 2 (see PLATFORM_GAPS.md GAP-016, "AI may request verification. CodeForge owns
      // verification evidence."): bounded to exactly one round trip per review attempt — if the
      // Reviewer's first response requests a check, the platform executes (or rejects) it and calls
      // the Reviewer again with the real evidence; that response's own VERDICT/VERIFICATION is the
      // one actually used. Any premature VERDICT in the first response is discarded unread, and a
      // second VERIFY line in the follow-up response is never parsed at all — see prompt-builder.ts.
      const verificationRequest = parseVerificationRequest(reviewStep.summary);
      let verificationEvidence: VerificationEvidence | null = null;
      if (verificationRequest) {
        this.throwIfCancelled(signal);
        // Item 4d-equivalent: authoritative ownership check immediately before executing a real
        // process against the (possibly shared/reused) workspace — see assertStillOwned's own doc
        // comment.
        this.assertStillOwned(task.id, generation);
        this.eventRepo.append(task.id, "REVIEWER_VERIFICATION_REQUESTED", { checkId: verificationRequest.checkId, purpose: verificationRequest.purpose }, now());
        verificationEvidence = await executeApprovedVerification({
          workspacePath: workspace.path,
          expectedBranch: workspace.branch,
          project,
          request: verificationRequest,
          signal,
        });
        this.eventRepo.append(task.id, "REVIEWER_VERIFICATION_COMPLETED", { ...verificationEvidence }, now());

        this.throwIfCancelled(signal);
        const followUpContext = buildReviewerContext(
          task,
          project,
          workspace.path,
          lastImplementerResult,
          lastValidation,
          projectContext,
          lastCommitResult?.changedFiles ?? null,
          verificationEvidence,
        );
        reviewStep = await this.runAgent(task, project, engine, "reviewer", followUpContext, this.nextAttemptNumber(task.id, "reviewer"), signal, generation, "reviewer");
      }

      const review = deriveReviewResult(reviewStep, verificationEvidence);
      this.eventRepo.append(
        task.id,
        "REVIEW_COMPLETED",
        { verdict: review.verdict, findings: review.findings, verificationMethod: review.verificationMethod, verification: review.verification },
        now(),
      );

      if (review.verdict === "approved") {
        // Deliberately no cancellation check between "approved" and transitioning to REVIEW: a
        // change that has already passed independent review is a real, validated result — a
        // cancellation arriving in this exact instant does not retroactively discard it. See
        // /docs/TASK_LIFECYCLE.md "Cancellation" race-resolution table (Case D).
        //
        // The PR is a required part of reaching REVIEW, not a best-effort side effect: if opening
        // it fails, this throws and the task lands in FAILED (via executeTask's catch), never a
        // false REVIEW claiming a PR that doesn't exist — see /docs/GITHUB_INTEGRATION.md.
        await this.ensurePullRequest(
          task,
          project,
          scProvider,
          workspace.path,
          workspace.branch,
          pullRequestBaseBranch,
          lastImplementerResult!,
          lastValidation!,
          review,
          lastCommitResult?.changedFiles ?? null,
          signal,
          generation,
        );

        task.status = transition(task.status, "gates_passed");
        task.taskRecord.selfFixAttempts = 0;
        this.saveOwned(task, generation, now());
        this.eventRepo.append(task.id, "TASK_MOVED_TO_REVIEW", { confidence: review.confidence }, now());
        return this.requireTask(task.id);
      }

      cycles += 1;
      this.eventRepo.append(task.id, "REVIEW_CHANGES_REQUESTED", { cycle: cycles, findings: review.findings, summary: review.summary }, now());

      if (cycles > this.config.maxReviewerRejections) {
        return this.failTask(task, describeReviewCycleExhaustion(review, cycles), generation);
      }

      task.taskRecord.decisions.push({
        source: "discovered",
        summary: `Independent review rejected the change: ${review.summary}`,
        recordedAt: now(),
      });
      this.saveOwned(task, generation, now());

      this.throwIfCancelled(signal);
      const attemptNumber = this.nextAttemptNumber(task.id, "implementer");
      // reviewerFeedback (not lastFailure): this fix follows a *passing* validation run — the
      // Implementer needs the Reviewer's findings, not a stale/misleading "validation failed"
      // framing. See context-builder.ts's buildImplementerContext doc comment.
      const fixContext = buildImplementerContext(task, project, workspace.path, null, review, null, projectContext);
      const fixStep = await this.runAgent(task, project, engine, "implementer", fixContext, attemptNumber, signal, generation, this.implementerOperation(task));
      if (fixStep.status === "needs_input" && fixStep.needsInput) {
        return this.raiseNeedsInput(task, fromImplementerDraft(fixStep.needsInput), generation);
      }
      lastImplementerResult = fixStep;
      lastValidation = await this.runValidationStep(task, workspace.path, project.commands, signal, generation);
      task.taskRecord.selfFixAttempts = attemptNumber;
      this.saveOwned(task, generation, now());

      if (lastValidation.status !== "passed") {
        return this.raiseNeedsInput(task, fromExhaustedSelfFix(lastValidation.checks, attemptNumber), generation);
      }
      lastCommitResult = await this.prepareChanges(task, project, scProvider, workspace.path, workspace.branch, signal, generation);
      if (task.taskRecord.bugFixVerification?.contract) {
        await this.runFixVerification(task, project, workspace, signal, generation);
      }
    }
  }

  /**
   * The human review feedback loop's own fix cycle — deliberately narrower
   * than the AI review/fix cycle in runWorkingEpisode: implement -> validate
   * -> commit -> push -> REVIEW, with no independent-review step in between
   * (the human who requested the changes is the one who will look again on
   * GitHub). Reuses the task's existing workspace/branch — never
   * re-provisions, never re-runs prepareChanges's PR step (the PR already
   * exists and stays open; pushing new commits to its branch is what
   * "updates" it). See /docs/TASK_LIFECYCLE.md "Human review feedback loop".
   *
   * Crash-safe by construction: reads the feedback to act on from
   * `task.taskRecord.pendingHumanReviewFeedback` (persisted by the caller —
   * checkHumanReviewFeedback — before this ever starts) rather than taking
   * it as a parameter, so a restarted process calling this via executeTask's
   * recovery dispatch resumes with exactly the same feedback, not a fresh
   * (or missing) one. See /docs/TASK_LIFECYCLE.md "Crash recovery".
   *
   * V1.1 Slice 3 scope note: deliberately does NOT re-run bug-fix
   * verification (see runFixVerification) even for a task with a
   * BugFixVerificationContract — this loop only fires after a task has
   * already reached REVIEW with a human-approved PR open, which is well
   * past this slice's reproduce/implement/verify scope. A commit made here
   * leaves `TaskRecord.bugFixVerification.fixVerification` referring to the
   * last commit this slice DID verify, not this loop's own new commit — see
   * PLATFORM_GAPS.md's Slice 3 note for this documented boundary.
   */
  private async runHumanFeedbackFixCycle(taskId: string, signal: AbortSignal, generation: number): Promise<Task> {
    const now = () => new Date().toISOString();
    let task = this.requireTask(taskId);
    const feedback = task.taskRecord.pendingHumanReviewFeedback;
    if (!feedback) {
      throw new Error(`Task ${taskId} has no pending human review feedback to resume`);
    }
    const project = this.requireProject(task.projectId);
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);
    const workspace = this.workspaceRepo.findByTaskId(taskId);
    if (!workspace) {
      throw new Error(`Task ${taskId} has no workspace to resume for human review feedback`);
    }

    this.throwIfCancelled(signal);

    const attemptNumber = this.nextAttemptNumber(taskId, "implementer");
    const context = buildImplementerContext(task, project, workspace.path, null, null, feedback, this.loadProjectContext(project));
    const engine = this.engines.resolve(project.codingEngine);
    const step = await this.runAgent(task, project, engine, "implementer", context, attemptNumber, signal, generation, "human_feedback_fix");
    if (step.status === "needs_input" && step.needsInput) {
      task = this.requireTask(taskId);
      task.taskRecord.pendingHumanReviewFeedback = null;
      return this.raiseNeedsInput(task, fromImplementerDraft(step.needsInput), generation);
    }

    task = this.requireTask(taskId);
    const validation = await this.runValidationStep(task, workspace.path, project.commands, signal, generation);
    task.taskRecord.selfFixAttempts = attemptNumber;
    this.saveOwned(task, generation, now());

    if (validation.status !== "passed") {
      // Same escalation path an ordinary self-fix exhaustion uses — a human-requested fix that
      // itself fails validation is exactly as unresolved as any other unfixed failure.
      task.taskRecord.pendingHumanReviewFeedback = null;
      return this.raiseNeedsInput(task, fromExhaustedSelfFix(validation.checks, attemptNumber), generation);
    }

    this.throwIfCancelled(signal);
    await this.prepareChanges(task, project, scProvider, workspace.path, workspace.branch, signal, generation);

    this.throwIfCancelled(signal);
    task = this.requireTask(taskId);
    task.status = transition(task.status, "gates_passed");
    task.taskRecord.selfFixAttempts = 0;
    task.taskRecord.pendingHumanReviewFeedback = null;
    this.saveOwned(task, generation, now());
    this.eventRepo.append(taskId, "TASK_MOVED_TO_REVIEW", { trigger: "human_review_feedback" }, now());
    return this.requireTask(taskId);
  }

  private async provisionWorkspace(
    task: Task,
    project: Project,
    scProvider: SourceControlProvider,
    branchName: string,
    cloneBaseBranch: string,
    branchMode: "new" | "existing",
    signal: AbortSignal,
    generation: number,
  ) {
    const now = () => new Date().toISOString();
    // Crash-recovery re-entry: WorkspaceProvider.provision() is itself idempotent (see its own doc
    // comment) and would just return this same row — but skip calling it (and emitting
    // WORKSPACE_CREATED/BRANCH_CREATED again) entirely, since nothing was actually (re-)created.
    // See /docs/TASK_LIFECYCLE.md "Crash recovery".
    const existing = this.workspaceRepo.findByTaskId(task.id);
    if (existing && existing.status === "ready") {
      // Workspace-fencing (see /docs/SECURITY_ARCHITECTURE.md, migrations/009_lock_generation.sql,
      // WorkspaceRepository.claimForGeneration): this execution's own reused workspace directory
      // must first become THIS generation's — strictly-increasing only. If a newer generation
      // already claimed it (this call is a stale execution catching up after losing the lease), the
      // claim loses and this stops before ever touching a single file in the shared checkout,
      // instead of racing a legitimately newer owner on disk.
      //
      // V1.1 Slice 4: an infrastructure-retried episode (see runEpisodeWithInfrastructureRetry) can
      // legitimately re-enter this method more than once within the SAME generation — the second
      // call must not treat "already claimed by us" as a failure the way a genuinely stale/older
      // generation's claim correctly would (see isClaimedForGeneration's own doc comment).
      if (!this.workspaceRepo.isClaimedForGeneration(existing.id, generation) && !this.workspaceRepo.claimForGeneration(existing.id, generation)) {
        throw new LeaseLostError();
      }
      return existing;
    }
    try {
      // Branch existence validation (see /docs/TASK_LIFECYCLE.md "Branch existence validation"):
      // TaskService.create already confirmed the branch existed *at task-creation time* — this
      // re-checks it *now*, right before actually cloning/checking it out, to catch the gap where a
      // branch was deleted (or renamed) in between. `cloneBaseBranch` is exactly the ref this
      // episode is about to `git clone --branch` (see provision() below): for "existing" mode it IS
      // the target working branch itself; for "new" mode it's the base the new branch will be
      // created from — either way, this is the one ref that must exist for provisioning to succeed.
      // A `null` result ("can't verify" — see SourceControlProvider.branchExists's own doc comment,
      // e.g. local-git's best-effort remote reachability) is never treated as "missing": this stays
      // advisory for providers that can't reliably confirm it, a hard gate only where it's a real,
      // checkable fact (GitHub).
      const stillExists = await scProvider.branchExists(project, cloneBaseBranch, signal);
      if (stillExists === false) {
        throw new BranchNotFoundAtExecutionError(cloneBaseBranch);
      }

      const credential = await scProvider.resolveCloneCredential(project, signal);
      const workspace = await this.workspaceProvider.provision(
        {
          taskId: task.id,
          repoUrl: project.repoUrl,
          baseBranch: cloneBaseBranch,
          taskBranch: branchName,
          mode: branchMode,
        },
        signal,
        credential,
      );
      this.eventRepo.append(task.id, "WORKSPACE_CREATED", { path: workspace.path, branch: workspace.branch }, now());
      if (branchMode !== "existing") {
        this.eventRepo.append(task.id, "BRANCH_CREATED", { branch: workspace.branch, baseBranch: cloneBaseBranch }, now());
      }
      // Freshly provisioned: claim it for this generation too (a fresh workspace starts at
      // active_generation 0, so this always succeeds) — keeps claimForGeneration as the single
      // source of truth for "who currently owns this workspace directory," whether reused or new.
      this.workspaceRepo.claimForGeneration(workspace.id, generation);
      return workspace;
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      this.eventRepo.append(task.id, "WORKSPACE_FAILED", { error: String(err) }, now());
      throw err;
    }
  }

  /**
   * The next AgentRun.attemptNumber for `role` on this task — derived from
   * the actual persisted count of prior AgentRun rows (of any status,
   * including `interrupted`/`failed` ones from a crash), not a separately
   * tracked in-memory-then-persisted counter. This is what makes attempt
   * numbering crash-safe: a counter like the old `selfFixAttempts + cycles`
   * arithmetic only advances at certain checkpoints (e.g. after a validation
   * run completes), so a crash between "AgentRun inserted" and that
   * checkpoint left the next real attempt computing the SAME number as the
   * interrupted one — two AgentRun rows with an identical (role,
   * attemptNumber). Counting real rows is correct by construction regardless
   * of when a crash happens. See /docs/TASK_LIFECYCLE.md "Crash recovery".
   */
  private nextAttemptNumber(taskId: string, role: AgentRole): number {
    return this.agentRunRepo.listForTask(taskId).filter((r) => r.role === role).length + 1;
  }

  private async runAgent(
    task: Task,
    project: Project,
    engine: ReturnType<CodingEngineRegistry["resolve"]>,
    role: AgentRole,
    context: ContextBundle,
    attemptNumber: number,
    signal: AbortSignal,
    generation: number,
    operation: OperationClass,
  ): Promise<StepResult> {
    const now = () => new Date().toISOString();
    const runId = randomUUID();

    // V1.1 Slice 5 — the platform's own routing decision (see routing/model-router.ts), made once
    // per invocation. `null` when no ModelRegistry/ProviderHealthRepository was wired, or when
    // every enabled candidate is currently unavailable (see selectModel's own doc comment) — never
    // fabricated. `priorModelIdsInOrder` is derived from persisted AgentRun rows — the same "count
    // real rows, never a separate counter" pattern nextAttemptNumber already uses — in FIRST-USE
    // order, so a self-fix retry that reuses the SAME model (a real, distinct model was never
    // actually exhausted) is correctly distinguished from a genuine fallback to a NEW model: see
    // `fallbackIndex` below, which is this model's position in that order, not merely "how many
    // times this role has been invoked before."
    const priorModelIdsInOrder: string[] = [];
    for (const run of this.agentRunRepo.listForTask(task.id)) {
      if (run.role === role && run.modelId !== null && !priorModelIdsInOrder.includes(run.modelId)) {
        priorModelIdsInOrder.push(run.modelId);
      }
    }
    const selection =
      this.modelRegistry && this.providerHealthRepo
        ? selectModel(this.modelRegistry, this.providerHealthRepo, {
            operation,
            engineKey: engine.key,
            fallbackIndex: priorModelIdsInOrder.length,
            now: now(),
          })
        : null;
    // The real, persisted fallbackIndex: this model's position among the DISTINCT models this
    // task+role has ever used, in the order each was first tried — 0 for the very first model,
    // even across multiple same-model self-fix retries; only a genuinely NEW model increments it.
    const fallbackIndex = selection
      ? priorModelIdsInOrder.includes(selection.modelId)
        ? priorModelIdsInOrder.indexOf(selection.modelId)
        : priorModelIdsInOrder.length
      : 0;

    this.agentRunRepo.insert({
      id: runId,
      taskId: task.id,
      role,
      engine: engine.key,
      attemptNumber,
      status: "running",
      input: context,
      result: null,
      error: null,
      cost: null,
      startedAt: now(),
      completedAt: null,
      // Fencing key for AgentRunRepository.complete() — see its own doc comment and
      // migrations/009_lock_generation.sql.
      ownerGeneration: generation,
      modelId: selection?.modelId ?? null,
      providerId: selection?.providerId ?? null,
      fallbackIndex,
    });
    task.currentAgentRunId = runId;
    this.saveOwned(task, generation, now());
    this.eventRepo.append(
      task.id,
      "AGENT_STARTED",
      { runId, role, attemptNumber, modelId: selection?.modelId ?? null, providerId: selection?.providerId ?? null, routingReason: selection?.reason ?? null },
      now(),
    );

    try {
      const invocation = await engine.run({
        role,
        context,
        workspacePath: context.repoPath,
        timeoutMs: this.config.agentInvocationTimeoutMs,
        signal,
        modelSelection: selection,
      });
      // A stale execution (lease already lost to a newer generation) reaching this point still
      // gets HERE — the fixture/adapter call itself isn't lease-aware — but `complete()` is
      // generation-fenced against the task's CURRENT lock_generation, so it silently refuses to
      // mutate this AgentRun if that's the case. The very next saveOwned() call downstream (in
      // runWorkingEpisode/runHumanFeedbackFixCycle) independently re-checks the same fencing and
      // raises LeaseLostError, so a stale completion here never gets treated as this execution's
      // real, actionable result.
      const completed = this.agentRunRepo.complete(runId, "completed", invocation.result, null, invocation.cost, now());
      if (selection) this.recordProviderHealthSuccess(selection.providerId, now());
      if (!completed) {
        // Stale generation: don't append AGENT_COMPLETED (it would misleadingly mix this
        // fenced-out result into the current owner's real event timeline). EXECUTION_LEASE_LOST
        // instead — the very next saveOwned() call downstream independently raises LeaseLostError,
        // which the caller (executeTask/checkHumanReviewFeedback) handles uniformly; this event is
        // just for immediate visibility right at the point the loss was actually discovered.
        console.error(`[orchestrator] task ${task.id} — AgentRun ${runId} (generation ${generation}) completed after losing the execution lease; result discarded.`);
        this.eventRepo.append(task.id, "EXECUTION_LEASE_LOST", { owner: this.ownerId, generation, at: "runAgent" }, now());
        return invocation.result;
      }
      this.eventRepo.append(task.id, "AGENT_COMPLETED", { runId, role, status: invocation.result.status }, now());
      return invocation.result;
    } catch (err) {
      if (err instanceof CancellationError) {
        // Usage the engine emitted before the stop is real: keep it (labelled partial), never a zero.
        this.agentRunRepo.complete(runId, "cancelled", null, "Cancelled by developer request", usageFromError(err), now());
        throw err;
      }
      this.agentRunRepo.complete(runId, "failed", null, String(err), usageFromError(err), now());
      // V1.1 Slice 5 (see PLATFORM_GAPS.md GAP-027/028's cross-task outage note) — a real,
      // observed engine failure updates the SAME persisted provider-health record every future
      // routing decision (this task's own retry, or any other task/worker) consults, never an
      // in-memory-only circuit breaker. Cancellation (handled above) deliberately never reaches
      // here: a human stopping the task is not evidence the provider is unhealthy.
      if (selection) this.recordProviderHealthFailure(selection.providerId, err, now());
      this.eventRepo.append(task.id, "AGENT_FAILED", { runId, role, error: String(err) }, now());
      this.logAgentFailure(task, engine.key, role, attemptNumber, err);
      throw err;
    }
  }

  private recordProviderHealthSuccess(providerId: string, now: string): void {
    if (!this.providerHealthRepo) return;
    this.providerHealthRepo.upsert(deriveHealthOnSuccess(providerId, this.providerHealthRepo.get(providerId), now));
  }

  private recordProviderHealthFailure(providerId: string, err: unknown, now: string): void {
    if (!this.providerHealthRepo) return;
    const classification = classifyOrchestratorFailure(err);
    this.providerHealthRepo.upsert(
      deriveHealthOnFailure(providerId, this.providerHealthRepo.get(providerId), classification.category, classification.retryAfterMs, now, {
        defaultCooldownMs: this.config.providerCooldownDefaultMs,
        maxCooldownMs: this.config.providerCooldownMaxMs,
      }),
    );
  }

  /** V1.1 Slice 5 — operation-aware routing input for the Implementer role (this slice's brief, item 21): a task created with a Slice 3 BugFixVerificationContract routes as "bug_fix", everything else as "implementation". Both currently resolve to the same candidate list — see selectModel's own doc comment — but the distinction is real and threaded through so a future routing policy revision can act on it without any caller changing. */
  private implementerOperation(task: Task): OperationClass {
    return task.taskRecord.bugFixVerification?.contract ? "bug_fix" : "implementation";
  }

  /**
   * Worker-terminal-visible failure summary (see /docs/CODING_ENGINE.md
   * "Retry behavior" and "Observability"): the per-attempt retry log lines
   * already come from the adapter itself (it's the only layer that knows
   * about individual retry attempts — see OpenCodeAdapter.run()); this is
   * the one line logged once per *agent invocation* (i.e. once per
   * self-fix/reviewer attempt) so `AGENT_FAILED`/`TASK_FAILED` are never
   * silent in the worker's terminal. Never logs `err` itself as an object —
   * only its already-sanitized `.message` (adapters never put secrets in
   * error messages, see coding-engine adapters' documented security
   * boundary) — so nothing here can leak a raw stack trace containing
   * environment/process details.
   */
  private logAgentFailure(task: Task, engineKey: string, role: AgentRole, attemptNumber: number, err: unknown): void {
    const meta = err instanceof EngineExecutionError ? err.meta : null;
    console.error(
      `[orchestrator] task ${task.id} ("${task.title}") — ${role} failed on self-fix attempt ${attemptNumber} ` +
        `[engine=${engineKey}${meta ? `, invocationAttempts=${meta.attempts}, retryable=${meta.retryable}, classification=${meta.classification}` : ""}]: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  private async runValidationStep(
    task: Task,
    workspacePath: string,
    commands: Project["commands"],
    signal: AbortSignal,
    generation: number,
  ): Promise<ValidationResult> {
    const now = () => new Date().toISOString();
    // Item 4a: an authoritative ownership check immediately before running validation commands
    // against the (possibly shared/reused) workspace — see assertStillOwned's own doc comment for
    // why this narrows, but cannot eliminate, the race against an external process.
    this.assertStillOwned(task.id, generation);
    this.eventRepo.append(task.id, "VALIDATION_STARTED", {}, now());

    // V1.1 Slice 4 (see PLATFORM_GAPS.md GAP-028, item 11/21.F of this slice's brief): when EVERY
    // failing check came back `outcome: "infrastructure_error"` (the command itself could not even
    // be spawned — missing binary, broken environment — never a real assertion failure), retry the
    // validation run itself, bounded and in place, BEFORE ever handing this result to the self-fix
    // loop. Deliberately local to this method, never routed through the episode-level
    // runEpisodeWithInfrastructureRetry: that wrapper re-enters the WHOLE episode from the top
    // (including a fresh Implementer call), which would be wasteful and wrong here — the code hasn't
    // been judged yet, only the check itself failed to run. If a real result (a genuine pass OR a
    // genuine failure) appears on any attempt, it's returned immediately, retry budget or not.
    let result = await runValidation(workspacePath, commands, signal);
    for (let attempt = 1; isAllInfrastructureError(result) && attempt <= this.config.maxInfraCheckRetries; attempt++) {
      this.eventRepo.append(
        task.id,
        "INFRASTRUCTURE_FAILURE_DETECTED",
        { category: "verification_infrastructure_failure", retryable: true, reason: describeInfrastructureChecks(result), attempt },
        now(),
      );
      const delayMs = computeBackoffDelayMs(attempt, this.config.infrastructureRetryBaseDelayMs, this.config.infrastructureRetryMaxDelayMs);
      this.eventRepo.append(task.id, "INFRASTRUCTURE_RETRY_SCHEDULED", { attempt, maxAttempts: this.config.maxInfraCheckRetries + 1, delayMs, retryAfterMs: null }, now());
      await sleepUnlessAborted(delayMs, signal, () => new CancellationError());
      this.assertStillOwned(task.id, generation);
      this.eventRepo.append(task.id, "INFRASTRUCTURE_RETRY_STARTED", { attempt: attempt + 1 }, now());
      result = await runValidation(workspacePath, commands, signal);
    }
    // Still all-infrastructure after exhausting the local retry budget — honestly recorded as such
    // (never silently promoted to a "real" failure the self-fix loop would misattribute to the code),
    // but not thrown: the self-fix loop's own existing exhaustion path (NEEDS_INPUT after
    // maxSelfFixAttempts) is what ultimately surfaces this to a human if it never clears, exactly the
    // same safety net every other unresolved validation failure already falls back to.
    if (isAllInfrastructureError(result)) {
      this.eventRepo.append(
        task.id,
        "INFRASTRUCTURE_FAILURE_DETECTED",
        { category: "verification_infrastructure_failure", retryable: false, reason: `${describeInfrastructureChecks(result)} (retry budget exhausted)`, attempt: this.config.maxInfraCheckRetries + 1 },
        now(),
      );
    }

    this.eventRepo.append(
      task.id,
      "VALIDATION_COMPLETED",
      {
        status: result.status,
        // V1.1 Slice 1 (GAP-004): the field a human/report should actually read — distinguishes
        // "checks ran and passed" from "nothing was configured" from "checks ran and failed."
        // `status` above is unchanged and still only gates the self-fix loop.
        outcome: result.outcome,
        checks: result.checks.map((c) => ({ name: c.name, passed: c.passed, outcome: c.outcome })),
      },
      now(),
    );
    return result;
  }

  /**
   * V1.1 Slice 3 — runs a task's BugFixVerificationContract check against the
   * workspace's PRISTINE starting state, before the Implementer has touched
   * anything, and persists the deterministic result. See PLATFORM_GAPS.md
   * GAP-016. Idempotent by construction: only ever called (see
   * runWorkingEpisode) when `task.taskRecord.bugFixVerification.reproduction`
   * is still `null` — a crash before this persists means the next resume
   * finds it still `null` and simply runs it again, fresh, off the same
   * still-untouched workspace; nothing here can turn an interruption into a
   * false success, because nothing is written until the real check has
   * actually completed.
   */
  private async runBugReproduction(task: Task, project: Project, workspace: Workspace, signal: AbortSignal, generation: number): Promise<void> {
    const contract = task.taskRecord.bugFixVerification!.contract!;
    const now = () => new Date().toISOString();
    this.assertStillOwned(task.id, generation);
    this.eventRepo.append(task.id, "BUG_REPRODUCTION_STARTED", { checkId: contract.checkId }, now());
    const evidence = await this.runContractCheckWithInfraRetry(task, project, workspace, contract, signal, generation);
    const status = deriveReproductionStatus(evidence, contract);
    task.taskRecord.bugFixVerification!.reproduction = { status, evidence };
    this.saveOwned(task, generation, now());
    this.eventRepo.append(task.id, "BUG_REPRODUCTION_COMPLETED", { status, ...evidence }, now());
  }

  /**
   * V1.1 Slice 3 — re-runs the SAME contract check against the commit
   * `prepareChanges` just produced, and OVERWRITES the task's own
   * `fixVerification` with fresh evidence bound to that new commit — see
   * BugFixVerification's own doc comment on why this is always the latest
   * verified state, never stale evidence from an earlier commit. Called
   * after every `prepareChanges` in runWorkingEpisode (the first commit and
   * every review/fix-cycle recommit), so a code change after a review
   * rejection always gets its own fresh verification before the next review
   * pass ever sees it — the previous cycle's evidence is fully replaced, not
   * merged or accumulated.
   */
  private async runFixVerification(task: Task, project: Project, workspace: Workspace, signal: AbortSignal, generation: number): Promise<void> {
    const contract = task.taskRecord.bugFixVerification!.contract!;
    const now = () => new Date().toISOString();
    this.assertStillOwned(task.id, generation);
    this.eventRepo.append(task.id, "FIX_VERIFICATION_STARTED", { checkId: contract.checkId }, now());
    const evidence = await this.runContractCheckWithInfraRetry(task, project, workspace, contract, signal, generation);
    const status = deriveFixVerificationStatus(evidence, contract);
    task.taskRecord.bugFixVerification!.fixVerification = { status, evidence };
    this.saveOwned(task, generation, now());
    this.eventRepo.append(task.id, "FIX_VERIFICATION_COMPLETED", { status, ...evidence }, now());
  }

  /**
   * V1.1 Slice 4 — shared by runBugReproduction/runFixVerification: retries the SAME contract check,
   * bounded and in place, when its outcome is `"timed_out"` or `"infrastructure_error"` (the check
   * never got a real chance to run) — see PLATFORM_GAPS.md GAP-028's own verification-infrastructure
   * note. Mirrors runValidationStep's identical local-retry treatment of the same underlying
   * `CheckOutcome`/`VerificationOutcome` values, deliberately NOT routed through the episode-level
   * runEpisodeWithInfrastructureRetry: retrying the whole episode would mean re-invoking the
   * Implementer for a problem that has nothing to do with the code. If the retry budget is exhausted,
   * the real (still timed_out/infrastructure_error) evidence is returned as-is — deriveReproductionStatus/
   * deriveFixVerificationStatus already pass that through as its own honest status rather than ever
   * converting it into a bug/fix judgment (see review/bug-fix-verification.ts).
   */
  private async runContractCheckWithInfraRetry(
    task: Task,
    project: Project,
    workspace: Workspace,
    contract: BugFixVerificationContract,
    signal: AbortSignal,
    generation: number,
  ): Promise<VerificationEvidence> {
    const now = () => new Date().toISOString();
    let evidence = await runContractCheck({ workspacePath: workspace.path, expectedBranch: workspace.branch, project, contract, signal });
    for (let attempt = 1; isCheckInfrastructureOutcome(evidence.outcome) && attempt <= this.config.maxInfraCheckRetries; attempt++) {
      this.eventRepo.append(
        task.id,
        "INFRASTRUCTURE_FAILURE_DETECTED",
        { category: "verification_infrastructure_failure", retryable: true, reason: `verification check "${contract.checkId}" ${evidence.outcome}`, attempt },
        now(),
      );
      const delayMs = computeBackoffDelayMs(attempt, this.config.infrastructureRetryBaseDelayMs, this.config.infrastructureRetryMaxDelayMs);
      this.eventRepo.append(task.id, "INFRASTRUCTURE_RETRY_SCHEDULED", { attempt, maxAttempts: this.config.maxInfraCheckRetries + 1, delayMs, retryAfterMs: null }, now());
      await sleepUnlessAborted(delayMs, signal, () => new CancellationError());
      this.assertStillOwned(task.id, generation);
      this.eventRepo.append(task.id, "INFRASTRUCTURE_RETRY_STARTED", { attempt: attempt + 1 }, now());
      evidence = await runContractCheck({ workspacePath: workspace.path, expectedBranch: workspace.branch, project, contract, signal });
    }
    if (isCheckInfrastructureOutcome(evidence.outcome)) {
      this.eventRepo.append(
        task.id,
        "INFRASTRUCTURE_FAILURE_DETECTED",
        {
          category: "verification_infrastructure_failure",
          retryable: false,
          reason: `verification check "${contract.checkId}" ${evidence.outcome} (retry budget exhausted)`,
          attempt: this.config.maxInfraCheckRetries + 1,
        },
        now(),
      );
    }
    return evidence;
  }

  /**
   * Commits and pushes the workspace's current state. Unlike Steps 1-6,
   * this is a real gate, not a best-effort side channel: a commit or push
   * failure throws and propagates out of `runWorkingEpisode` to
   * `executeTask`'s catch block, which lands the task in FAILED — never a
   * silently-skipped push with the task still sailing on to REVIEW. See
   * /docs/GITHUB_INTEGRATION.md "Failure recovery" and Step 7 instructions
   * §14-15 ("If push fails... do not mark task DONE").
   *
   * V1.1 Slice 1 (see PLATFORM_GAPS.md GAP-015): `scProvider.commitAll` and
   * `scProvider.push` now assert the workspace is actually on `branch`
   * before touching git history or the remote, and `push` verifies the
   * remote ref afterward rather than trusting a clean exit code alone.
   * `BranchMismatchError`/`PushVerificationError` are caught by name here so
   * their structured fields (expected/actual branch, expected/remote sha)
   * land in the `SOURCE_CONTROL_FAILED` event payload instead of being
   * flattened into an opaque `String(err)` — see those errors' own doc
   * comments for why the distinction matters to whoever reads this event
   * later. Both still rethrow: a branch mismatch is exactly as fatal to this
   * step as any other commit/push failure, never silently skipped.
   */
  private async prepareChanges(
    task: Task,
    project: Project,
    scProvider: SourceControlProvider,
    workspacePath: string,
    branch: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<CommitResult> {
    const now = () => new Date().toISOString();
    try {
      // Item 4b: authoritative ownership check immediately before the commit — see
      // assertStillOwned's own doc comment.
      this.assertStillOwned(task.id, generation);
      const commitResult = await scProvider.commitAll(project, workspacePath, `[task ${task.id.slice(0, 8)}] ${task.title}`, branch, signal);
      task.taskRecord.latestDiffRef = commitResult.commitSha;
      this.saveOwned(task, generation, now());
      this.eventRepo.append(
        task.id,
        "COMMIT_CREATED",
        { commitSha: commitResult.commitSha, branch, changedFiles: commitResult.changedFiles },
        now(),
      );

      // Item 4c: authoritative ownership check immediately before the push — deliberately a
      // separate check from the one before commitAll above, not one check covering both: the two
      // external calls are far enough apart in wall-clock time (git push can be slow) that a single
      // upfront check would leave a much wider unguarded window.
      this.assertStillOwned(task.id, generation);
      const pushResult = await scProvider.push(project, workspacePath, branch, signal);
      this.eventRepo.append(
        task.id,
        "BRANCH_PUSHED",
        { branch, pushedCommitSha: pushResult.pushedCommitSha, remoteBranchSha: pushResult.remoteBranchSha },
        now(),
      );
      return commitResult;
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      if (err instanceof LeaseLostError) throw err;
      if (err instanceof BranchMismatchError) {
        this.eventRepo.append(
          task.id,
          "SOURCE_CONTROL_FAILED",
          { step: "commit_or_push", error: err.message, expectedBranch: err.expectedBranch, actualBranch: err.actualBranch },
          now(),
        );
        throw err;
      }
      if (err instanceof PushVerificationError) {
        this.eventRepo.append(
          task.id,
          "SOURCE_CONTROL_FAILED",
          { step: "commit_or_push", error: err.message, branch: err.branch, expectedSha: err.expectedSha, remoteSha: err.remoteSha },
          now(),
        );
        throw err;
      }
      this.eventRepo.append(task.id, "SOURCE_CONTROL_FAILED", { step: "commit_or_push", error: String(err) }, now());
      throw err;
    }
  }

  /**
   * Opens (or, on a crash-recovery retry, finds) the task's Pull Request —
   * called exactly once, right before a task is allowed to transition to
   * REVIEW. Idempotent at two layers: this method's own short-circuit on an
   * already-recorded `taskRecord.pullRequest`, and the SourceControlProvider's
   * own "search before create" (see GitHubSourceControlProvider). See
   * /docs/GITHUB_INTEGRATION.md "PR idempotency".
   */
  private async ensurePullRequest(
    task: Task,
    project: Project,
    scProvider: SourceControlProvider,
    workspacePath: string,
    branch: string,
    baseBranch: string,
    implementerResult: StepResult,
    validation: ValidationResult,
    review: ReviewResult,
    changedFiles: string[] | null,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    if (task.taskRecord.pullRequest) return; // already opened on a prior attempt — nothing to do

    const now = () => new Date().toISOString();
    try {
      // Item 4d: authoritative ownership check immediately before PR creation — see
      // assertStillOwned's own doc comment.
      this.assertStillOwned(task.id, generation);
      const ref = await scProvider.openPullRequest(
        project,
        {
          workspacePath,
          branch,
          baseBranch,
          title: buildPullRequestTitle(task),
          description: buildPullRequestDescription(task, implementerResult.summary, validation, review, changedFiles),
        },
        signal,
      );
      task.taskRecord.pullRequest = ref;
      this.saveOwned(task, generation, now());
      this.eventRepo.append(task.id, "PULL_REQUEST_CREATED", { provider: ref.provider, number: ref.number, url: ref.url }, now());
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      if (err instanceof LeaseLostError) throw err;
      this.eventRepo.append(task.id, "SOURCE_CONTROL_FAILED", { step: "open_pull_request", error: String(err) }, now());
      throw err;
    }
  }

  /**
   * Fails a task cleanly with a clear, human-readable reason — used when the
   * review/fix cycle exhausts its configured budget (see
   * OrchestratorConfig.maxReviewerRejections) without ever reaching an
   * approved verdict. Deliberately FAILED, not NEEDS_INPUT: a Reviewer that
   * keeps finding new issues after repeated fix attempts within budget is a
   * bounded, evidence-backed failure to stop and report, not an open-ended
   * question — see /docs/TASK_LIFECYCLE.md "Review/fix cycle". Reuses the
   * same `infra_failure` transition and `TASK_FAILED` event the top-level
   * executeTask() catch block already uses for every other platform-level
   * failure, so this is visible through the exact same task/report/event
   * mechanisms — no new TaskStatus, no new failure-reporting path.
   */
  private failTask(task: Task, reason: string, generation: number): Task {
    const now = new Date().toISOString();
    task.status = transition(task.status, "infra_failure");
    task.completedAt = now;
    this.saveOwned(task, generation, now);
    this.eventRepo.append(task.id, "TASK_FAILED", { error: reason }, now);
    return this.requireTask(task.id);
  }

  private raiseNeedsInput(task: Task, record: NeedsInputRecordInput, generation: number): Task {
    assertNonTrivial(record);
    // Checked before inserting the HumanInputRequest row (not just before the task save below): a
    // stale, lease-lost execution must not leave behind an open "needs input" question for a task
    // it no longer legitimately owns, even if the subsequent task-status write would itself be
    // safely fenced.
    this.assertStillOwned(task.id, generation);
    const now = new Date().toISOString();
    const request = toHumanInputRequest(randomUUID(), task.id, record, now);
    this.humanInputRepo.insert(request);

    task.status = transition(task.status, "blocked");
    this.saveOwned(task, generation, now);
    this.eventRepo.append(task.id, "NEEDS_INPUT_RAISED", { requestId: request.id, question: record.question }, now);
    return this.requireTask(task.id);
  }

  private requireTask(id: string): Task {
    const task = this.taskRepo.findById(id);
    if (!task) throw new NotFoundError("Task", id);
    return task;
  }

  private requireProject(id: string): Project {
    const project = this.projectRepo.findById(id);
    if (!project) throw new NotFoundError("Project", id);
    return project;
  }

  /**
   * Phase 3, Slice 6 — loads this project's bounded, read-only Project Context section once per
   * working episode (see runWorkingEpisode/runHumanFeedbackFixCycle: every agent invocation within
   * the same episode reuses this same snapshot, rather than re-reading the manifest before every
   * individual agent call). `null` when either dependency wasn't wired (older test/CLI callers that
   * construct an Orchestrator without them — see the constructor's own doc comment) or when
   * `loadProjectContextSection` itself degrades to `null` (see that function's doc comment for every
   * case that does).
   */
  private loadProjectContext(project: Project): string | null {
    if (!this.projectWorkspaceRepo || !this.projectContextService) return null;
    return loadProjectContextSection(project.id, project.name, this.projectWorkspaceRepo, this.projectContextService);
  }
}

/**
 * V1.1 Slice 4 — true only when there is at least one declared check AND every one of them failed
 * with `outcome: "infrastructure_error"` (never spawned/completed for real) — i.e. this
 * ValidationResult carries no real signal about the code at all, in either direction. A mix of one
 * real failure and one infrastructure error is deliberately NOT all-infrastructure: a genuine test
 * failure exists, and that's a real result the self-fix loop must see immediately, not something to
 * retry past.
 */
function isAllInfrastructureError(result: ValidationResult): boolean {
  return result.checks.length > 0 && result.checks.every((c) => c.outcome === "infrastructure_error");
}

/** Human-readable summary of which declared checks failed to even run — for the INFRASTRUCTURE_FAILURE_DETECTED event's `reason` field. */
function describeInfrastructureChecks(result: ValidationResult): string {
  const names = result.checks.filter((c) => c.outcome === "infrastructure_error").map((c) => c.name);
  return `every declared check (${names.join(", ")}) failed to run at all`;
}

/** True for a VerificationEvidence outcome that means the check never got a real chance to run — see runContractCheckWithInfraRetry. Deliberately excludes "rejected" (a policy refusal, not an infrastructure hiccup — retrying it would spawn the exact same rejection every time). */
function isCheckInfrastructureOutcome(outcome: VerificationEvidence["outcome"]): boolean {
  return outcome === "timed_out" || outcome === "infrastructure_error";
}
