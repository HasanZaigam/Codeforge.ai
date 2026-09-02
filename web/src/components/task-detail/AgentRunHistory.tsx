import type { AgentRunHistoryItemDTO, AgentRunStatus } from "../../api/index.js";
import { formatAbsolute, formatDuration } from "../../lib/time.js";
import { EmptyState } from "../common/EmptyState.js";

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: "active",
  completed: "success",
  failed: "danger",
  timeout: "danger",
  cancelled: "cancelled",
  interrupted: "attention",
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timeout: "Timed out",
  cancelled: "Cancelled",
  interrupted: "Interrupted (crash recovery)",
};

const ROLE_LABEL: Record<AgentRunHistoryItemDTO["role"], string> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
};

const TRIGGER_LABEL: Record<AgentRunHistoryItemDTO["trigger"], string> = {
  initial: "Initial pass",
  self_fix_retry: "Self-fix retry",
  ai_review_fix: "AI reviewer fix",
  human_review_fix: "Human review fix",
  review: "Independent review",
};

/**
 * Every AgentRun for this task, in execution order — see /docs/TASK_LIFECYCLE.md "Execution
 * history and observability". Distinguishes the Implementer from the Reviewer, an original pass
 * from a self-fix retry / AI-reviewer fix / human-review fix, and flags any run that resumed after
 * a crash-interrupted attempt — all derived from data the platform already persists.
 */
export function AgentRunHistory({ runs }: { runs: AgentRunHistoryItemDTO[] }) {
  if (runs.length === 0) {
    return <EmptyState message="No agent runs yet." />;
  }

  return (
    <div className="agent-run-list">
      {runs.map((run) => (
        <div className="agent-run-item" key={run.id}>
          <div className="agent-run-item-header">
            <span className="agent-run-role">{ROLE_LABEL[run.role]}</span>
            <span className="text-muted">attempt {run.attemptNumber}</span>
            <span className={`status-badge tone-${STATUS_TONE[run.status]}`}>{STATUS_LABEL[run.status]}</span>
            <span className="text-muted">{TRIGGER_LABEL[run.trigger]}</span>
            {run.resumedAfterInterruption && (
              <span className="status-badge tone-attention" title="The previous attempt was interrupted by a crash; this run is what resumed it.">
                Resumed after crash
              </span>
            )}
          </div>

          <p className="text-muted agent-run-timing" title={formatAbsolute(run.startedAt)}>
            Started {formatAbsolute(run.startedAt)}
            {run.completedAt && ` · took ${formatDuration(run.startedAt, run.completedAt) ?? "—"}`}
          </p>

          {run.verdict && (
            <p className="text-muted">
              Verdict: <strong style={{ textTransform: "capitalize" }}>{run.verdict}</strong>
            </p>
          )}

          {run.summary && <p>{run.summary}</p>}

          {run.filesChanged.length > 0 && (
            <p className="text-muted" style={{ fontSize: "0.85rem" }}>
              {run.filesChanged.length} file{run.filesChanged.length === 1 ? "" : "s"} changed: {run.filesChanged.join(", ")}
            </p>
          )}

          {run.findings && run.findings.length > 0 && (
            <div className="findings-list">
              {run.findings.map((finding, i) => (
                <div className="finding-row" key={i}>
                  <span style={{ textTransform: "capitalize" }}>{finding.severity}</span>
                  <span>—</span>
                  <span>{finding.summary}</span>
                </div>
              ))}
            </div>
          )}

          {run.humanReviewFeedback && (
            <div className="human-review-feedback">
              <p className="text-muted" style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                Human reviewer feedback — {run.humanReviewFeedback.reviewerLogin}
              </p>
              <p>{run.humanReviewFeedback.comments}</p>
            </div>
          )}

          {run.error && (
            <details className="agent-run-error">
              <summary>Technical error details</summary>
              <p>{run.error}</p>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
