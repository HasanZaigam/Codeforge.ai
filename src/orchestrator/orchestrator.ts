import { randomUUID } from "node:crypto";
import type { AgentRole, ContextBundle, HumanAnswer, HumanReviewFeedback, Project, ReviewResult, StepResult, Task, ValidationResult, Workspace } from "../domain/types.js";
import { transition, canTransition, InvalidTransitionError } from "../domain/task-state-machine.js";
import { CancellationError, LeaseLostError } from "../domain/errors.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { AgentRunRepository } from "../persistence/repositories/agent-run-repository.js";
import type { HumanInputRepository } from "../persistence/repositories/human-input-repository.js";
import type { WorkspaceRepository } from "../persistence/repositories/workspace-repository.js";
import { EngineExecutionError, type CodingEngineRegistry } from "../coding-engine/coding-engine.js";
import type { WorkspaceProvider } from "../workspace/workspace-provider.js";
import type { SourceControlProvider, SourceControlProviderRegistry } from "../source-control/source-control-provider.js";
import { runValidation } from "../validation/validation-runner.js";
import { buildImplementerContext, buildReviewerContext } from "./context-builder.js";
import { deriveReviewResult } from "../review/reviewer.js";
import { buildHumanReviewFeedback, deriveHumanReviewOutcome } from "../review/human-review-feedback.js";
import { buildPullRequestDescription, buildPullRequestTitle } from "./pull-request-content.js";
import { assertNonTrivial, describeReviewCycleExhaustion, fromExhaustedSelfFix, fromImplementerDraft, toHumanInputRequest, type NeedsInputRecordInput } from "./needs-input.js";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "./config.js";
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
    private readonly ownerId: string,
    private readonly config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
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

    if (task.status === "TODO") {
      if (!this.taskRepo.claimTodo(taskId, this.ownerId, this.config.taskLeaseMs, now())) {
        return this.requireTask(taskId);
      }
      this.eventRepo.append(taskId, "TASK_CLAIMED", { owner: this.ownerId }, now());
      this.eventRepo.append(taskId, "TASK_STARTED", {}, now());
      task = this.requireTask(taskId);
    } else if (task.status === "WORKING") {
      if (!this.taskRepo.claimWorking(taskId, this.ownerId, this.config.taskLeaseMs, now())) {
        return task;
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
        task = await this.withCancellation(taskId, (signal) => this.runHumanFeedbackFixCycle(taskId, signal));
      } else {
        task = await this.withCancellation(taskId, (signal) => this.runWorkingEpisode(task, signal));
      }
    } catch (err) {
      if (err instanceof CancellationError) {
        task = await this.finalizeCancellation(this.requireTask(taskId), this.workspaceRepo.findByTaskId(taskId));
      } else if (err instanceof LeaseLostError) {
        // Another process's claim won — see withCancellation's heartbeat and LeaseLostError's own
        // doc comment for why this must NOT touch task status or the workspace: whoever now holds
        // the lease may be actively, legitimately using both. Just stop and observe current state.
        console.error(`[orchestrator] task ${taskId} — lost the execution lease to another process mid-run; stopping without touching task state.`);
        task = this.requireTask(taskId);
      } else {
        // Only genuine platform/infra failures land here — model judgment calls are always
        // routed to NEEDS_INPUT via raiseNeedsInput(), never thrown.
        task = this.requireTask(taskId);
        task.status = transition(task.status, "infra_failure");
        task.completedAt = now();
        this.taskRepo.save(task, now());
        this.eventRepo.append(taskId, "TASK_FAILED", { error: String(err) }, now());
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

      // TODO or NEEDS_INPUT: nothing is currently executing anywhere — finalize immediately.
      const won =
        task.status === "TODO"
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
   * Polls a REVIEW task's PR for new human feedback (see
   * SourceControlProvider.listPullRequestFeedback) and, if a "changes
   * requested" review is found, runs a bounded fix cycle in the SAME
   * workspace/branch before returning the task to REVIEW — see
   * /docs/TASK_LIFECYCLE.md "Human review feedback loop". A no-op for any
   * task that isn't REVIEW with a PR already opened. Safe to call
   * repeatedly/concurrently for the same taskId: at most one call wins the
   * REVIEW->WORKING claim (claimReviewForHumanFeedback), and every feedback
   * item is recorded in `processedHumanFeedbackIds` before it can trigger a
   * second fix cycle — see requirement "duplicate GitHub feedback is
   * ignored".
   */
  async checkHumanReviewFeedback(taskId: string): Promise<Task> {
    const now = () => new Date().toISOString();
    let task = this.requireTask(taskId);
    if (task.status !== "REVIEW" || !task.taskRecord.pullRequest) return task;

    const project = this.requireProject(task.projectId);
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);

    let items;
    try {
      items = await scProvider.listPullRequestFeedback(project, task.taskRecord.pullRequest, new AbortController().signal);
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
      this.taskRepo.save(task, now());
      return this.requireTask(taskId);
    }

    // Actionable: claim the task (REVIEW -> WORKING) before doing anything else — this is the
    // single atomic guard against two concurrent pollers both starting a fix cycle.
    if (!this.taskRepo.claimReviewForHumanFeedback(taskId, this.ownerId, this.config.taskLeaseMs, now())) {
      return this.requireTask(taskId); // lost the race — another process is already handling this
    }

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
        task = await this.withCancellation(taskId, (signal) => this.runHumanFeedbackFixCycle(taskId, signal));
      }
    } catch (err) {
      if (err instanceof CancellationError) {
        task = await this.finalizeCancellation(this.requireTask(taskId), this.workspaceRepo.findByTaskId(taskId));
      } else if (err instanceof LeaseLostError) {
        // See executeTask's identical branch and LeaseLostError's own doc comment — never touch
        // task status or the workspace here; another process now legitimately owns both.
        console.error(`[orchestrator] task ${taskId} — lost the execution lease to another process mid-run; stopping without touching task state.`);
        task = this.requireTask(taskId);
      } else {
        task = this.requireTask(taskId);
        task.status = transition(task.status, "infra_failure");
        task.completedAt = now();
        this.taskRepo.save(task, now());
        this.eventRepo.append(taskId, "TASK_FAILED", { error: String(err) }, now());
      }
    } finally {
      this.taskRepo.releaseLock(taskId, this.ownerId, now());
    }
    return this.requireTask(taskId);
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
      const renewed = this.taskRepo.claimWorking(taskId, this.ownerId, this.config.taskLeaseMs, new Date().toISOString());
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
  // Internal execution
  // -------------------------------------------------------------------------

  private async runWorkingEpisode(task: Task, signal: AbortSignal): Promise<Task> {
    const now = () => new Date().toISOString();
    const project = this.requireProject(task.projectId);
    const engine = this.engines.resolve(project.codingEngine);
    const scProvider = this.sourceControlProviders.resolve(project.sourceControlProvider);

    const branchName = task.taskRecord.branchName ?? `task/${task.id.slice(0, 8)}`;
    task.taskRecord.branchName = branchName;
    this.taskRepo.save(task, now());

    const workspace = await this.provisionWorkspace(task, project, scProvider, branchName, signal);
    task.workspaceId = workspace.id;
    this.taskRepo.save(task, now());

    let lastValidation: ValidationResult | null = null;
    let lastImplementerResult: StepResult | null = null;

    // ---- self-fix loop: implement -> validate -> (diagnose+fix) -> validate ----
    for (;;) {
      this.throwIfCancelled(signal);
      const attemptNumber = this.nextAttemptNumber(task.id, "implementer");
      const context = buildImplementerContext(task, project, workspace.path, lastValidation);
      const step = await this.runAgent(task, project, engine, "implementer", context, attemptNumber, signal);

      if (step.status === "needs_input" && step.needsInput) {
        return this.raiseNeedsInput(task, fromImplementerDraft(step.needsInput));
      }

      lastImplementerResult = step;
      lastValidation = await this.runValidationStep(task, workspace.path, project.commands, signal);

      if (lastValidation.status === "passed") break;

      task.taskRecord.selfFixAttempts = attemptNumber;
      this.taskRepo.save(task, now());

      if (attemptNumber >= this.config.maxSelfFixAttempts) {
        return this.raiseNeedsInput(task, fromExhaustedSelfFix(lastValidation.checks, attemptNumber));
      }
      this.eventRepo.append(task.id, "RETRY_STARTED", { nextAttempt: attemptNumber + 1 }, now());
    }

    this.throwIfCancelled(signal);
    await this.prepareChanges(task, project, scProvider, workspace.path, workspace.branch, signal);

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
      const reviewContext = buildReviewerContext(task, project, workspace.path, lastImplementerResult, lastValidation);
      const reviewStep = await this.runAgent(task, project, engine, "reviewer", reviewContext, reviewAttemptNumber, signal);
      const review = deriveReviewResult(reviewStep);
      this.eventRepo.append(task.id, "REVIEW_COMPLETED", { verdict: review.verdict, findings: review.findings }, now());

      if (review.verdict === "approved") {
        // Deliberately no cancellation check between "approved" and transitioning to REVIEW: a
        // change that has already passed independent review is a real, validated result — a
        // cancellation arriving in this exact instant does not retroactively discard it. See
        // /docs/TASK_LIFECYCLE.md "Cancellation" race-resolution table (Case D).
        //
        // The PR is a required part of reaching REVIEW, not a best-effort side effect: if opening
        // it fails, this throws and the task lands in FAILED (via executeTask's catch), never a
        // false REVIEW claiming a PR that doesn't exist — see /docs/GITHUB_INTEGRATION.md.
        await this.ensurePullRequest(task, project, scProvider, workspace.path, workspace.branch, lastImplementerResult!, lastValidation!, review, signal);

        task.status = transition(task.status, "gates_passed");
        task.taskRecord.selfFixAttempts = 0;
        this.taskRepo.save(task, now());
        this.eventRepo.append(task.id, "TASK_MOVED_TO_REVIEW", { confidence: review.confidence }, now());
        return this.requireTask(task.id);
      }

      cycles += 1;
      this.eventRepo.append(task.id, "REVIEW_CHANGES_REQUESTED", { cycle: cycles, findings: review.findings, summary: review.summary }, now());

      if (cycles > this.config.maxReviewerRejections) {
        return this.failTask(task, describeReviewCycleExhaustion(review, cycles));
      }

      task.taskRecord.decisions.push({
        source: "discovered",
        summary: `Independent review rejected the change: ${review.summary}`,
        recordedAt: now(),
      });
      this.taskRepo.save(task, now());

      this.throwIfCancelled(signal);
      const attemptNumber = this.nextAttemptNumber(task.id, "implementer");
      // reviewerFeedback (not lastFailure): this fix follows a *passing* validation run — the
      // Implementer needs the Reviewer's findings, not a stale/misleading "validation failed"
      // framing. See context-builder.ts's buildImplementerContext doc comment.
      const fixContext = buildImplementerContext(task, project, workspace.path, null, review);
      const fixStep = await this.runAgent(task, project, engine, "implementer", fixContext, attemptNumber, signal);
      if (fixStep.status === "needs_input" && fixStep.needsInput) {
        return this.raiseNeedsInput(task, fromImplementerDraft(fixStep.needsInput));
      }
      lastImplementerResult = fixStep;
      lastValidation = await this.runValidationStep(task, workspace.path, project.commands, signal);
      task.taskRecord.selfFixAttempts = attemptNumber;
      this.taskRepo.save(task, now());

      if (lastValidation.status !== "passed") {
        return this.raiseNeedsInput(task, fromExhaustedSelfFix(lastValidation.checks, attemptNumber));
      }
      await this.prepareChanges(task, project, scProvider, workspace.path, workspace.branch, signal);
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
   */
  private async runHumanFeedbackFixCycle(taskId: string, signal: AbortSignal): Promise<Task> {
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
    const context = buildImplementerContext(task, project, workspace.path, null, null, feedback);
    const engine = this.engines.resolve(project.codingEngine);
    const step = await this.runAgent(task, project, engine, "implementer", context, attemptNumber, signal);
    if (step.status === "needs_input" && step.needsInput) {
      task = this.requireTask(taskId);
      task.taskRecord.pendingHumanReviewFeedback = null;
      return this.raiseNeedsInput(task, fromImplementerDraft(step.needsInput));
    }

    task = this.requireTask(taskId);
    const validation = await this.runValidationStep(task, workspace.path, project.commands, signal);
    task.taskRecord.selfFixAttempts = attemptNumber;
    this.taskRepo.save(task, now());

    if (validation.status !== "passed") {
      // Same escalation path an ordinary self-fix exhaustion uses — a human-requested fix that
      // itself fails validation is exactly as unresolved as any other unfixed failure.
      task.taskRecord.pendingHumanReviewFeedback = null;
      return this.raiseNeedsInput(task, fromExhaustedSelfFix(validation.checks, attemptNumber));
    }

    this.throwIfCancelled(signal);
    await this.prepareChanges(task, project, scProvider, workspace.path, workspace.branch, signal);

    this.throwIfCancelled(signal);
    task = this.requireTask(taskId);
    task.status = transition(task.status, "gates_passed");
    task.taskRecord.selfFixAttempts = 0;
    task.taskRecord.pendingHumanReviewFeedback = null;
    this.taskRepo.save(task, now());
    this.eventRepo.append(taskId, "TASK_MOVED_TO_REVIEW", { trigger: "human_review_feedback" }, now());
    return this.requireTask(taskId);
  }

  private async provisionWorkspace(
    task: Task,
    project: Project,
    scProvider: SourceControlProvider,
    branchName: string,
    signal: AbortSignal,
  ) {
    const now = () => new Date().toISOString();
    // Crash-recovery re-entry: WorkspaceProvider.provision() is itself idempotent (see its own doc
    // comment) and would just return this same row — but skip calling it (and emitting
    // WORKSPACE_CREATED/BRANCH_CREATED again) entirely, since nothing was actually (re-)created.
    // See /docs/TASK_LIFECYCLE.md "Crash recovery".
    const existing = this.workspaceRepo.findByTaskId(task.id);
    if (existing && existing.status === "ready") {
      return existing;
    }
    try {
      const credential = await scProvider.resolveCloneCredential(project, signal);
      const workspace = await this.workspaceProvider.provision(
        {
          taskId: task.id,
          repoUrl: project.repoUrl,
          baseBranch: project.defaultBranch,
          taskBranch: branchName,
        },
        signal,
        credential,
      );
      this.eventRepo.append(task.id, "WORKSPACE_CREATED", { path: workspace.path, branch: workspace.branch }, now());
      this.eventRepo.append(task.id, "BRANCH_CREATED", { branch: workspace.branch, baseBranch: project.defaultBranch }, now());
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
  ): Promise<StepResult> {
    const now = () => new Date().toISOString();
    const runId = randomUUID();
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
    });
    task.currentAgentRunId = runId;
    this.taskRepo.save(task, now());
    this.eventRepo.append(task.id, "AGENT_STARTED", { runId, role, attemptNumber }, now());

    try {
      const invocation = await engine.run({
        role,
        context,
        workspacePath: context.repoPath,
        timeoutMs: this.config.agentInvocationTimeoutMs,
        signal,
      });
      this.agentRunRepo.complete(runId, "completed", invocation.result, null, invocation.cost, now());
      this.eventRepo.append(task.id, "AGENT_COMPLETED", { runId, role, status: invocation.result.status }, now());
      return invocation.result;
    } catch (err) {
      if (err instanceof CancellationError) {
        this.agentRunRepo.complete(runId, "cancelled", null, "Cancelled by developer request", null, now());
        throw err;
      }
      this.agentRunRepo.complete(runId, "failed", null, String(err), null, now());
      this.eventRepo.append(task.id, "AGENT_FAILED", { runId, role, error: String(err) }, now());
      this.logAgentFailure(task, engine.key, role, attemptNumber, err);
      throw err;
    }
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
  ): Promise<ValidationResult> {
    const now = () => new Date().toISOString();
    this.eventRepo.append(task.id, "VALIDATION_STARTED", {}, now());
    const result = await runValidation(workspacePath, commands, signal);
    this.eventRepo.append(
      task.id,
      "VALIDATION_COMPLETED",
      { status: result.status, checks: result.checks.map((c) => ({ name: c.name, passed: c.passed })) },
      now(),
    );
    return result;
  }

  /**
   * Commits and pushes the workspace's current state. Unlike Steps 1-6,
   * this is a real gate, not a best-effort side channel: a commit or push
   * failure throws and propagates out of `runWorkingEpisode` to
   * `executeTask`'s catch block, which lands the task in FAILED — never a
   * silently-skipped push with the task still sailing on to REVIEW. See
   * /docs/GITHUB_INTEGRATION.md "Failure recovery" and Step 7 instructions
   * §14-15 ("If push fails... do not mark task DONE").
   */
  private async prepareChanges(
    task: Task,
    project: Project,
    scProvider: SourceControlProvider,
    workspacePath: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<void> {
    const now = () => new Date().toISOString();
    try {
      const commitSha = await scProvider.commitAll(project, workspacePath, `[task ${task.id.slice(0, 8)}] ${task.title}`, signal);
      task.taskRecord.latestDiffRef = commitSha;
      this.taskRepo.save(task, now());
      this.eventRepo.append(task.id, "COMMIT_CREATED", { commitSha }, now());

      await scProvider.push(project, workspacePath, branch, signal);
      this.eventRepo.append(task.id, "BRANCH_PUSHED", { branch }, now());
    } catch (err) {
      if (err instanceof CancellationError) throw err;
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
    implementerResult: StepResult,
    validation: ValidationResult,
    review: ReviewResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (task.taskRecord.pullRequest) return; // already opened on a prior attempt — nothing to do

    const now = () => new Date().toISOString();
    try {
      const ref = await scProvider.openPullRequest(
        project,
        {
          workspacePath,
          branch,
          baseBranch: project.defaultBranch,
          title: buildPullRequestTitle(task),
          description: buildPullRequestDescription(task, implementerResult.summary, validation, review),
        },
        signal,
      );
      task.taskRecord.pullRequest = ref;
      this.taskRepo.save(task, now());
      this.eventRepo.append(task.id, "PULL_REQUEST_CREATED", { provider: ref.provider, number: ref.number, url: ref.url }, now());
    } catch (err) {
      if (err instanceof CancellationError) throw err;
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
  private failTask(task: Task, reason: string): Task {
    const now = new Date().toISOString();
    task.status = transition(task.status, "infra_failure");
    task.completedAt = now;
    this.taskRepo.save(task, now);
    this.eventRepo.append(task.id, "TASK_FAILED", { error: reason }, now);
    return this.requireTask(task.id);
  }

  private raiseNeedsInput(task: Task, record: NeedsInputRecordInput): Task {
    assertNonTrivial(record);
    const now = new Date().toISOString();
    const request = toHumanInputRequest(randomUUID(), task.id, record, now);
    this.humanInputRepo.insert(request);

    task.status = transition(task.status, "blocked");
    this.taskRepo.save(task, now);
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
}
