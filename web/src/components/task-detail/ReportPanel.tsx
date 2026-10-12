import { CircleCheckIcon, CircleXIcon, CoinsIcon, ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import { tokenLabel } from "../../lib/tokens.js";
import type { TaskDTO, TaskReport } from "../../api/index.js";
import { EmptyState } from "../common/EmptyState.js";
import { Markdown } from "../common/Markdown.js";
import { Callout } from "../common/Callout.js";
import { Section } from "../common/Section.js";
import { formatAbsolute } from "../../lib/time.js";
import { DurationStats } from "./DurationStats.js";
import { AgentRunHistory } from "./AgentRunHistory.js";
import { UsageSummary } from "./UsageSummary.js";
import { FindingList } from "./FindingList.js";
import { cn } from "@/lib/utils";

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

  const tokens = <TaskTokenLine usage={report.usage} />;
  const isDone = task.status === "DONE";
  const isReview = task.status === "REVIEW";
  const isCancelled = task.status === "CANCELLED";
  const isFailed = task.status === "FAILED";

  return (
    <div className="flex flex-col gap-4">
      {isDone && (
        <Callout tone="success" title="Completed">
          <p className="text-muted-foreground">This task's changes were accepted.</p>
          {tokens}
        </Callout>
      )}
      {isReview && (
        <Callout tone="info" title="Awaiting your review">
          <p className="text-muted-foreground">
            The implementation passed automated execution and validation. This is not a guarantee it's perfect — review the
            evidence below before treating it as final.
          </p>
          {tokens}
        </Callout>
      )}
      {isCancelled && (
        <Callout tone="cancelled" title="Cancelled">
          <p className="text-muted-foreground">
            {task.cancelledBy ? "Cancelled by developer request. " : ""}
            {task.completedAt && `Stopped ${formatAbsolute(task.completedAt)}. `}
            The activity log below shows what had happened up to that point.
          </p>
          {tokens}
        </Callout>
      )}
      {isFailed && (
        <Callout tone="danger" title="Failed">
          {report.failureContext && (
            <p className="text-muted-foreground">
              Failed at: <strong className="text-foreground">{report.failureContext.stage}</strong>
              {report.failureContext.failedRole && (
                <>
                  {" "}
                  — <span className="capitalize">{report.failureContext.failedRole}</span>
                  {report.failureContext.attemptNumber && `, attempt ${report.failureContext.attemptNumber}`}
                </>
              )}
            </p>
          )}
          {report.failureCategory && (
            <p className="text-muted-foreground">
              Category: <strong className="text-foreground">{report.failureCategory.replace(/_/g, " ")}</strong>
              {report.failureCategory !== "task_failure" &&
                report.failureCategory !== "unknown_failure" &&
                " — an infrastructure problem, not a problem with the requested change."}
            </p>
          )}
          {report.failureReason ? (
            <Markdown text={report.failureReason} />
          ) : (
            <p className="text-muted-foreground">No failure reason was recorded.</p>
          )}
          {tokens}
        </Callout>
      )}

      {report.recoveredFromCrash && (
        <Callout tone="attention" title="Recovered from a crash">
          <p className="text-muted-foreground">
            Execution was interrupted at least once (e.g. a worker process restart) and automatically resumed — see "Agent runs"
            below for exactly which attempt was interrupted and which one resumed it. No work was lost or duplicated.
          </p>
        </Callout>
      )}

      {report.infrastructureFailures && report.infrastructureFailures.length > 0 && (
        <Callout tone="attention" title="Infrastructure retries">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {report.infrastructureFailures.map((f, i) => (
              <li key={i}>
                Attempt {f.attempt}: <strong className="text-foreground">{f.category.replace(/_/g, " ")}</strong>
                {f.retryable ? " (retryable)" : " (not retryable)"} — {f.reason}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <DurationStats durations={report.durations} />

      {report.bugFixVerification && (
        <Section
          title="Bug-fix verification"
          description={
            <>
              Platform-captured evidence (check <code className="font-mono">{report.bugFixVerification.contract.checkId}</code>), not
              an AI claim.
            </>
          }
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Reproduction</dt>
            <dd className="font-medium">{report.bugFixVerification.reproduction?.status.replace(/_/g, " ") ?? "not run yet"}</dd>
            <dt className="text-muted-foreground">Fix verification</dt>
            <dd className="font-medium">{report.bugFixVerification.fixVerification?.status.replace(/_/g, " ") ?? "not run yet"}</dd>
          </dl>
        </Section>
      )}

      <Section
        title="What changed"
        actions={
          <span className="text-xs text-muted-foreground">
            {report.filesChanged} file{report.filesChanged === 1 ? "" : "s"} changed
            {report.commitSha && ` · commit ${report.commitSha.slice(0, 7)}`}
          </span>
        }
      >
        <Markdown text={report.whatChanged} />
      </Section>

      {report.pullRequest && (
        <Section title="Pull Request">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <GitPullRequestIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            {report.pullRequest.url ? (
              <a
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                href={report.pullRequest.url}
                target="_blank"
                rel="noreferrer"
              >
                {report.pullRequest.number ? `#${report.pullRequest.number}` : "View Pull Request"}
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </a>
            ) : (
              "A Pull Request was opened."
            )}
            {report.pullRequest.branch && (
              <span className="text-muted-foreground">
                {" "}
                — <code className="font-mono text-xs">{report.pullRequest.branch}</code> →{" "}
                <code className="font-mono text-xs">{report.pullRequest.baseBranch}</code>
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            A human review and merge decision on GitHub is still required — this platform never auto-merges.
          </p>
        </Section>
      )}

      <Section title="Checks">
        {report.checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No checks have run yet.</p>
        ) : (
          <ul className="divide-y rounded-2xl border">
            {report.checks.map((check) => (
              <li className="flex items-center gap-3 px-4 py-2.5 text-sm" key={check.name}>
                {check.passed ? (
                  <CircleCheckIcon className="size-4 text-tone-success" aria-hidden="true" />
                ) : (
                  <CircleXIcon className="size-4 text-tone-danger" aria-hidden="true" />
                )}
                <span className="flex-1 font-medium capitalize">{check.name}</span>
                <span className={cn("text-xs", check.passed ? "text-tone-success" : "text-tone-danger")}>
                  {check.passed ? "passed" : "failed"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Independent review"
        actions={
          report.confidence && (
            <span className="text-xs text-muted-foreground">
              Confidence: <strong className="text-foreground capitalize">{report.confidence}</strong>
            </span>
          )
        }
      >
        {report.reviewFindings.length === 0 ? (
          report.reviewSummary ? (
            <Markdown text={report.reviewSummary} />
          ) : (
            <p className="text-sm text-muted-foreground">No concerns raised.</p>
          )
        ) : (
          <FindingList findings={report.reviewFindings} />
        )}
      </Section>

      <UsageSummary usage={report.usage} />

      <details
        className="group rounded-3xl bg-card text-card-foreground ring-1 ring-foreground/10"
        open={report.agentRuns.length > 0 && report.agentRuns.length <= 3}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 [&::-webkit-details-marker]:hidden">
          <h2 className="text-base font-semibold">Execution details</h2>
          <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="space-y-3 px-5 pb-5">
          {task.branchName && (
            <p className="text-sm text-muted-foreground">
              Branch: <code className="font-mono text-xs">{task.branchName}</code>
            </p>
          )}
          <h3 className="text-sm font-medium">Agent runs</h3>
          <AgentRunHistory runs={report.agentRuns} />
        </div>
      </details>
    </div>
  );
}

/**
 * "This task used N tokens" for the outcome callout (TD-63). Agent-run prompts aren't stored, so runs that
 * reported nothing can't be estimated — that's said plainly instead of guessing.
 */
function TaskTokenLine({ usage }: { usage: TaskReport["usage"] }) {
  if (!usage || usage.runsCounted === 0) return null;
  const total = usage.totalTokens ?? null;
  const missing = usage.runsCounted - usage.runsWithUsage;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <CoinsIcon className="size-3.5" aria-hidden="true" />
      {total === null ? (
        <span>The coding engine didn't report token usage for this task's {usage.runsCounted} AI run{usage.runsCounted === 1 ? "" : "s"}.</span>
      ) : (
        <span>
          Used <strong className="font-medium text-foreground">{tokenLabel(total, false)}</strong> across {usage.runsCounted} AI run
          {usage.runsCounted === 1 ? "" : "s"}
          {missing > 0 ? ` — ${missing} run${missing === 1 ? "" : "s"} reported no usage, so the real total is higher` : ""}.
        </span>
      )}
    </p>
  );
}

