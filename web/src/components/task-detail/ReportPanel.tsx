import type { TaskDTO, TaskReport } from "../../api/index.js";
import { EmptyState } from "../common/EmptyState.js";
import { Markdown } from "../common/Markdown.js";
import { formatAbsolute } from "../../lib/time.js";
import { DurationStats } from "./DurationStats.js";
import { AgentRunHistory } from "./AgentRunHistory.js";
import { UsageSummary } from "./UsageSummary.js";

/**
 * Shows only evidence the backend actually reports — never fabricated
 * counts (see /docs/API.md TaskReport and TECHNICAL_DECISIONS.md TD-13).
 * REVIEW is framed as "passed execution/validation, awaiting your review,"
 * not "definitely correct" — see Step 4 instructions §14. CANCELLED is
 * framed neutrally, never as a failure — see Step 5 instructions §17.
 */
export function ReportPanel({ task, report }: { task: TaskDTO; report: TaskReport | undefined }) {
  if (!report) {
    return <EmptyState message="No report yet." />;
  }

  const isDone = task.status === "DONE";
  const isReview = task.status === "REVIEW";
  const isCancelled = task.status === "CANCELLED";
  const isFailed = task.status === "FAILED";

  return (
    <div className="stack">
      {isDone && (
        <div className="card card-padded" style={{ borderColor: "var(--tone-success-text)" }}>
          <h2 style={{ color: "var(--tone-success-text)", marginBottom: 8 }}>✓ Completed</h2>
          <p className="text-muted">This task's changes were accepted.</p>
        </div>
      )}
      {isReview && (
        <div className="card card-padded" style={{ borderColor: "var(--tone-info-text)" }}>
          <h2 style={{ color: "var(--tone-info-text)", marginBottom: 8 }}>Awaiting your review</h2>
          <p className="text-muted">
            The implementation passed automated execution and validation. This is not a guarantee it's perfect — review the
            evidence below before treating it as final.
          </p>
        </div>
      )}
      {isCancelled && (
        <div className="card card-padded" style={{ borderColor: "var(--tone-cancelled-text)" }}>
          <h2 style={{ color: "var(--tone-cancelled-text)", marginBottom: 8 }}>Cancelled</h2>
          <p className="text-muted">
            {task.cancelledBy ? "Cancelled by developer request. " : ""}
            {task.completedAt && `Stopped ${formatAbsolute(task.completedAt)}. `}
            The activity log below shows what had happened up to that point.
          </p>
        </div>
      )}
      {isFailed && (
        <div className="card card-padded" style={{ borderColor: "var(--tone-danger-text)" }}>
          <h2 style={{ color: "var(--tone-danger-text)", marginBottom: 8 }}>Failed</h2>
          {report.failureContext && (
            <p className="text-muted" style={{ marginBottom: 8 }}>
              Failed at: <strong>{report.failureContext.stage}</strong>
              {report.failureContext.failedRole && (
                <>
                  {" "}
                  — <span style={{ textTransform: "capitalize" }}>{report.failureContext.failedRole}</span>
                  {report.failureContext.attemptNumber && `, attempt ${report.failureContext.attemptNumber}`}
                </>
              )}
            </p>
          )}
          {report.failureCategory && (
            <p className="text-muted" style={{ marginBottom: 8 }}>
              Category: <strong>{report.failureCategory.replace(/_/g, " ")}</strong>
              {report.failureCategory !== "task_failure" && report.failureCategory !== "unknown_failure" && " — an infrastructure problem, not a problem with the requested change."}
            </p>
          )}
          {report.failureReason ? (
            <Markdown text={report.failureReason} />
          ) : (
            <p className="text-muted">No failure reason was recorded.</p>
          )}
        </div>
      )}

      {report.recoveredFromCrash && (
        <div className="card card-padded" style={{ borderColor: "var(--tone-attention-text)" }}>
          <h2 style={{ color: "var(--tone-attention-text)", marginBottom: 8, fontSize: "0.95rem" }}>Recovered from a crash</h2>
          <p className="text-muted">
            Execution was interrupted at least once (e.g. a worker process restart) and automatically resumed — see "Agent runs"
            below for exactly which attempt was interrupted and which one resumed it. No work was lost or duplicated.
          </p>
        </div>
      )}

      {report.infrastructureFailures && report.infrastructureFailures.length > 0 && (
        <div className="card card-padded" style={{ borderColor: "var(--tone-attention-text)" }}>
          <h2 style={{ color: "var(--tone-attention-text)", marginBottom: 8, fontSize: "0.95rem" }}>Infrastructure retries</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {report.infrastructureFailures.map((f, i) => (
              <li key={i} className="text-muted">
                Attempt {f.attempt}: <strong>{f.category.replace(/_/g, " ")}</strong>
                {f.retryable ? " (retryable)" : " (not retryable)"} — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.bugFixVerification && (
        <div className="section">
          <h2>Bug-fix verification</h2>
          <p className="text-muted">Platform-captured evidence (check <code>{report.bugFixVerification.contract.checkId}</code>), not an AI claim.</p>
          <p>Reproduction: <strong>{report.bugFixVerification.reproduction?.status.replace(/_/g, " ") ?? "not run yet"}</strong></p>
          <p>Fix verification: <strong>{report.bugFixVerification.fixVerification?.status.replace(/_/g, " ") ?? "not run yet"}</strong></p>
        </div>
      )}

      <DurationStats durations={report.durations} />

      <div className="section">
        <h2>What changed</h2>
        <Markdown text={report.whatChanged} />
        <p className="text-muted" style={{ marginTop: 8 }}>
          {report.filesChanged} file{report.filesChanged === 1 ? "" : "s"} changed
          {report.commitSha && ` · commit ${report.commitSha.slice(0, 7)}`}
        </p>
      </div>

      {report.pullRequest && (
        <div className="section">
          <h2>Pull Request</h2>
          <p>
            {report.pullRequest.url ? (
              <a href={report.pullRequest.url} target="_blank" rel="noreferrer">
                {report.pullRequest.number ? `#${report.pullRequest.number}` : "View Pull Request"}
              </a>
            ) : (
              "A Pull Request was opened."
            )}
            {report.pullRequest.branch && (
              <span className="text-muted">
                {" "}
                — <code>{report.pullRequest.branch}</code> → <code>{report.pullRequest.baseBranch}</code>
              </span>
            )}
          </p>
          <p className="text-muted" style={{ marginTop: 4 }}>
            A human review and merge decision on GitHub is still required — this platform never auto-merges.
          </p>
        </div>
      )}

      <div className="section">
        <h2>Checks</h2>
        {report.checks.length === 0 ? (
          <p className="text-muted">No checks have run yet.</p>
        ) : (
          <div className="checks-list">
            {report.checks.map((check) => (
              <div className={`check-row ${check.passed ? "passed" : "failed"}`} key={check.name}>
                <span>{check.passed ? "✓" : "✗"}</span>
                <span style={{ textTransform: "capitalize" }}>{check.name}</span>
                <span className="text-muted">{check.passed ? "passed" : "failed"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h2>Independent review</h2>
        {report.confidence && (
          <p className="text-muted" style={{ marginBottom: 8 }}>
            Confidence: <strong style={{ textTransform: "capitalize" }}>{report.confidence}</strong>
          </p>
        )}
        {report.reviewFindings.length === 0 ? (
          report.reviewSummary ? (
            <Markdown text={report.reviewSummary} />
          ) : (
            <p className="text-muted">No concerns raised.</p>
          )
        ) : (
          <div className="findings-list">
            {report.reviewFindings.map((finding, i) => (
              <div className="finding-row" key={i}>
                <span style={{ textTransform: "capitalize" }}>{finding.severity}</span>
                <span>—</span>
                <span>{finding.summary}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <UsageSummary usage={report.usage} />

      <div className="section">
        <details className="execution-details" open={report.agentRuns.length > 0 && report.agentRuns.length <= 3}>
          <summary>
            <h2 style={{ display: "inline" }}>Execution details</h2>
          </summary>
          <div className="execution-details-body">
            {task.branchName && (
              <p className="text-muted" style={{ fontSize: "0.85rem" }}>
                Branch: <code>{task.branchName}</code>
              </p>
            )}
            <h3 style={{ fontSize: "0.85rem", marginTop: 12, marginBottom: 8 }}>Agent runs</h3>
            <AgentRunHistory runs={report.agentRuns} />
          </div>
        </details>
      </div>
    </div>
  );
}
