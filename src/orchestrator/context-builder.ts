import type { ContextBundle, HumanReviewFeedback, Project, ReviewEvidence, ReviewResult, StepResult, Task, ValidationResult } from "../domain/types.js";

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
  };
}

export function buildReviewerContext(
  task: Task,
  project: Project,
  workspacePath: string,
  implementerResult: StepResult,
  validation: ValidationResult,
): ContextBundle {
  const evidence: ReviewEvidence = {
    implementerSummary: implementerResult.summary,
    filesChanged: implementerResult.filesChanged,
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
  };
}
