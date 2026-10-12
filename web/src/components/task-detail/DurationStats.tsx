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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((s) => (
        <div className="flex flex-col-reverse rounded-3xl bg-card px-4 py-3 ring-1 ring-foreground/10" key={s.label}>
          <span className="font-heading text-xl font-semibold tabular-nums">{s.value}</span>
          <span className="text-xs text-muted-foreground">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
