import type { BacklogAnalysisJobDTO } from "../../api/index.js";
import { FAILURE_CATEGORY_LABELS } from "../../lib/backlogLabels.js";
import { formatAbsolute } from "../../lib/time.js";

const categoryText = (job: BacklogAnalysisJobDTO) => (job.failureCategory ? FAILURE_CATEGORY_LABELS[job.failureCategory] : "unknown error");

/** The background analysis job's state, straight from the server's job — the click only enqueues, a worker runs it. */
export function AnalysisJobPanel({ job }: { job: BacklogAnalysisJobDTO | null }) {
  if (!job || job.status === "SUCCEEDED") return null;
  const reason = job.failureReason ? <p className="text-sm text-muted-foreground">{job.failureReason}</p> : null;
  const model = [job.providerId, job.modelId].filter(Boolean).join(" / ");

  if (job.status === "QUEUED") {
    if (job.failureCategory || job.attemptCount > 0) {
      return (
        <div>
          <p>
            Retry scheduled — attempt {job.attemptCount} of {job.maxAttempts} failed ({categoryText(job)}); next attempt after{" "}
            {formatAbsolute(job.availableAt)}.
          </p>
          {reason}
        </div>
      );
    }
    return <p>Queued — waiting for a worker to pick it up.</p>;
  }
  if (job.status === "RUNNING") {
    if (job.cancelRequested) return <p>Cancelling…</p>;
    return (
      <p>
        Running — attempt {job.attemptCount} of {job.maxAttempts}
        {model && ` (${model})`}
      </p>
    );
  }
  if (job.status === "CANCELLED") return <p>Analysis cancelled.</p>;
  return (
    <div>
      <p>
        Analysis failed — {categoryText(job)} (used {job.attemptCount} of {job.maxAttempts} attempts). Nothing was accepted and no task can
        be created from this analysis. You can analyze again.
      </p>
      {reason}
    </div>
  );
}
