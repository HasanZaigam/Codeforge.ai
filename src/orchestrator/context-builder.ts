import type { BugFixVerification, ContextBundle, HumanReviewFeedback, Project, ReviewEvidence, ReviewResult, StepResult, Task, ValidationResult, VerificationEvidence } from "../domain/types.js";
import { resolveApprovedVerificationChecks } from "../review/reviewer-verification.js";

/**
 * V1.1 Slice 3 — derives ContextBundle.bugFixEvidence straight from the
 * task's own persisted TaskRecord, the same "read what the platform already
 * captured, thread it through" pattern every other evidence field in this
 * file already follows. `null` when the task has no contract at all;
 * otherwise always the CURRENT reproduction/fixVerification the platform has
 * on record — never stale, because the orchestrator overwrites
 * `fixVerification` with fresh evidence after every commit (see
 * orchestrator.ts's runWorkingEpisode).
 */
function deriveBugFixEvidence(bugFixVerification: BugFixVerification | null): ContextBundle["bugFixEvidence"] {
  if (!bugFixVerification?.contract) return null;
  return { reproduction: bugFixVerification.reproduction, fixVerification: bugFixVerification.fixVerification };
}

/**
 * Builds the small, purpose-built context bundle handed to each agent
 * invocation from the persisted task record — never a replayed transcript.
 * See /docs/CONTEXT_ARCHITECTURE.md.
 *
 * `lastFailure`, `reviewerFeedback`, and `humanReviewFeedback` are mutually
 * exclusive in practice — see ContextBundle's own doc comment. The
 * Orchestrator's self-fix loop passes `lastFailure` (a failed validation
 * run); the AI review/fix cycle passes `reviewerFeedback` (an independent
 * Reviewer's rejection); the human review feedback loop passes
 * `humanReviewFeedback` (a human's GitHub PR review) — each follows a
 * different, non-overlapping point in the task's lifecycle.
 */
export function buildImplementerContext(
  task: Task,
  project: Project,
  workspacePath: string,
  lastFailure: ValidationResult | null,
  reviewerFeedback: ReviewResult | null = null,
  humanReviewFeedback: HumanReviewFeedback | null = null,
  // Phase 3, Slice 6 — see domain/types.ts ContextBundle.projectContext's own doc comment. Optional
  // (defaults to null) so every pre-existing call site/test that doesn't care about project context
  // needs no change.
  projectContext: string | null = null,
): ContextBundle {
  return {
    taskGoal: task.goal,
    taskPlan: task.taskRecord.plan,
    priorDecisions: task.taskRecord.decisions,
    repoPath: workspacePath,
    projectConventionPointer: `See CLAUDE.md (and AGENTS.md, if present) at the root of ${project.repoUrl}`,
    lastFailure,
    reviewEvidence: null,
    reviewerFeedback,
    humanReviewFeedback,
    projectContext,
    // V1.1 Slice 2 — verification requests are a Reviewer-only capability; see ContextBundle's own
    // doc comment.
    approvedVerificationChecks: [],
    verificationEvidence: null,
    bugFixEvidence: deriveBugFixEvidence(task.taskRecord.bugFixVerification),
  };
}

export function buildReviewerContext(
  task: Task,
  project: Project,
  workspacePath: string,
  implementerResult: StepResult,
  validation: ValidationResult,
  // Phase 3, Slice 6 — see buildImplementerContext's own doc comment above.
  projectContext: string | null = null,
  // V1.1 Slice 1 (see PLATFORM_GAPS.md "AI claims are not execution evidence"): the platform's own
  // git evidence (from CommitResult.changedFiles — a `git status --porcelain` reading taken before
  // this task's changes were even staged), never `implementerResult.filesChanged` (derived from the
  // coding engine's own tool-call log, a claim about what it believes it touched, not a fact about
  // what the repository actually shows). `null` only for a caller that hasn't committed yet — no
  // production call site should ever reach the Reviewer in that state, but this stays honest rather
  // than silently falling back to the AI's own claim.
  changedFiles: string[] | null = null,
  // V1.1 Slice 2 — present only on the follow-up invocation after the Reviewer requested a
  // verification and the platform executed (or rejected) it. See ContextBundle.verificationEvidence.
  verificationEvidence: VerificationEvidence | null = null,
): ContextBundle {
  const evidence: ReviewEvidence = {
    implementerSummary: implementerResult.summary,
    filesChanged: changedFiles ?? implementerResult.filesChanged,
    diffRef: implementerResult.diffRef,
    validation,
  };
  return {
    taskGoal: task.goal,
    taskPlan: task.taskRecord.plan,
    // Reviewer gets prior human decisions but deliberately NOT the implementer's own transcript —
    // independence is the point (see AGENT_ARCHITECTURE.md).
    priorDecisions: task.taskRecord.decisions,
    repoPath: workspacePath,
    projectConventionPointer: `See CLAUDE.md (and AGENTS.md, if present) at the root of ${project.repoUrl}`,
    lastFailure: null,
    reviewEvidence: evidence,
    reviewerFeedback: null,
    humanReviewFeedback: null,
    projectContext,
    // V1.1 Slice 2 — never offered when the follow-up call already carries real evidence: the
    // Reviewer's job at that point is to use the evidence it already has, not request another one
    // (see prompt-builder.ts's own bounding of this to one round trip per review attempt).
    approvedVerificationChecks: verificationEvidence ? [] : resolveApprovedVerificationChecks(project),
    verificationEvidence,
    bugFixEvidence: deriveBugFixEvidence(task.taskRecord.bugFixVerification),
  };
}
