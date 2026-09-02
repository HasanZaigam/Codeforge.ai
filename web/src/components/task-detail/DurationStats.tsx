import type { ExecutionDurationsDTO } from "../../api/index.js";
import { formatDurationMs } from "../../lib/time.js";

const LABELS: Array<{ key: keyof ExecutionDurationsDTO; label: string }> = [
  { key: "totalMs", label: "Total" },
  { key: "implementationMs", label: "Implementation" },
  { key: "reviewMs", label: "Review" },
  { key: "validationMs", label: "Validation" },
  { key: "waitingForHumanReviewMs", label: "Waiting for human review" },
];

/**
 * Duration breakdown — every value is derived server-side from existing timestamps (see
 * execution-history.ts), never a separately tracked/persisted value. Only durations that are
 * actually computable are shown; nothing is estimated for a step that hasn't happened yet.
 */
export function DurationStats({ durations }: { durations: ExecutionDurationsDTO }) {
  const stats = LABELS.map(({ key, label }) => ({ label, value: formatDurationMs(durations[key]) })).filter((s) => s.value !== null);

  if (stats.length === 0) return null;

  return (
    <div className="duration-stats">
      {stats.map((s) => (
        <div className="duration-stat" key={s.label}>
          <span className="value">{s.value}</span>
          <span className="label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
