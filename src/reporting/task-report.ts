import type { AgentRun, CheckResult, Task, TaskEvent } from "../domain/types.js";

/** The concise report shape defined in /docs/TASK_LIFECYCLE.md — built only from persisted evidence, never fabricated. */
export interface TaskReport {
  title: string;
  whatWasWrong: string;
  whatChanged: string;
  filesChanged: number;
  checks: Array<{ name: string; passed: boolean }>;
  reviewFindings: Array<{ severity: string; category: string; summary: string }>;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  /** Present once the platform has opened/found a real Pull Request for this task — see /docs/GITHUB_INTEGRATION.md. */
  pullRequest: { url: string | null; number: number | null; branch: string | null; baseBranch: string } | null;
  commitSha: string | null;
}

export function buildTaskReport(task: Task, agentRuns: AgentRun[], events: TaskEvent[], baseBranch: string): TaskReport {
  const implementerRuns = agentRuns.filter((r) => r.role === "implementer" && r.result);
  const reviewerRuns = agentRuns.filter((r) => r.role === "reviewer" && r.result);
  const lastImplementer = implementerRuns[implementerRuns.length - 1];
  const lastReviewer = reviewerRuns[reviewerRuns.length - 1];
  const lastValidationEvent = [...events].reverse().find((e) => e.type === "VALIDATION_COMPLETED");
  const checks = (lastValidationEvent?.payload.checks as Array<Pick<CheckResult, "name" | "passed">> | undefined) ?? [];

  return {
    title: task.title,
    whatWasWrong: task.goal,
    whatChanged: lastImplementer?.result?.summary ?? "(no implementation summary recorded)",
    filesChanged: lastImplementer?.result?.filesChanged.length ?? 0,
    checks,
    reviewFindings: (lastReviewer?.result?.findings ?? []).map((f) => ({
      severity: f.severity,
      category: f.category,
      summary: f.summary,
    })),
    confidence: lastReviewer?.result?.confidence ?? null,
    status: statusLabel(task),
    pullRequest: task.taskRecord.pullRequest
      ? { url: task.taskRecord.pullRequest.url, number: task.taskRecord.pullRequest.number, branch: task.taskRecord.branchName, baseBranch }
      : null,
    commitSha: task.taskRecord.latestDiffRef,
  };
}

function statusLabel(task: Task): string {
  switch (task.status) {
    case "REVIEW":
      return "Ready for review";
    case "DONE":
      return "Done";
    case "NEEDS_INPUT":
      return "Needs input";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "In progress";
  }
}
