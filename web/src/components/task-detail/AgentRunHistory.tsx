import type { AgentRunHistoryItemDTO, AgentRunStatus } from "../../api/index.js";
import { formatAbsolute, formatDuration } from "../../lib/time.js";
import { EmptyState } from "../common/EmptyState.js";
import { ToneBadge } from "../common/ToneBadge.js";
import { FindingList } from "./FindingList.js";
import type { Tone } from "../../lib/tone.js";

const STATUS_TONE: Record<AgentRunStatus, Tone> = {
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
  review_verification: "Review follow-up after a platform-run check",
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
    <ol className="space-y-3">
      {runs.map((run) => (
        <li className="space-y-2 rounded-2xl border p-4 text-sm" key={run.id}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{ROLE_LABEL[run.role]}</span>
            <span className="text-muted-foreground">attempt {run.attemptNumber}</span>
            {run.modelId && (
              <span className="font-mono text-xs text-muted-foreground">
                {" "}· {run.providerId ?? "unknown"}/{run.modelId}
                {run.fallbackIndex ? ` (fallback #${run.fallbackIndex})` : ""}
              </span>
            )}
            <ToneBadge tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</ToneBadge>
            <span className="text-muted-foreground">{TRIGGER_LABEL[run.trigger]}</span>
            {run.resumedAfterInterruption && (
              <ToneBadge tone="attention" title="The previous attempt was interrupted by a crash; this run is what resumed it.">
                Resumed after crash
              </ToneBadge>
            )}
          </div>

          <p className="text-xs text-muted-foreground" title={formatAbsolute(run.startedAt)}>
            Started {formatAbsolute(run.startedAt)}
            {run.completedAt && ` · took ${formatDuration(run.startedAt, run.completedAt) ?? "—"}`}
          </p>

          {run.verdict && (
            <p className="text-muted-foreground">
              Verdict: <strong className="text-foreground capitalize">{run.verdict}</strong>
            </p>
          )}

          {run.summary && <p>{run.summary}</p>}

          {run.filesChanged.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {run.filesChanged.length} file{run.filesChanged.length === 1 ? "" : "s"} changed: {run.filesChanged.join(", ")}
            </p>
          )}

          {run.findings && run.findings.length > 0 && <FindingList findings={run.findings} />}

          {run.humanReviewFeedback && (
            <div className="space-y-1 rounded-xl bg-muted/60 p-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Human reviewer feedback — {run.humanReviewFeedback.reviewerLogin}
              </p>
              <p>{run.humanReviewFeedback.comments}</p>
            </div>
          )}

          {run.error && (
            <details className="rounded-xl bg-destructive/5 p-3 text-destructive">
              <summary className="cursor-pointer text-xs font-medium">Technical error details</summary>
              <p className="mt-2 font-mono text-xs break-words whitespace-pre-wrap">{run.error}</p>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}
