import type { BacklogEventDTO } from "../../api/index.js";
import { labelForBacklogEvent } from "../../lib/backlogLabels.js";
import { formatDurationMs } from "../../lib/time.js";
import { EmptyState } from "../common/EmptyState.js";
import { Timeline } from "../common/Timeline.js";

/** A few facts straight from the event's own persisted payload — never fabricated. */
function detailFor(event: BacklogEventDTO): string | null {
  const p = event.payload;
  const parts: string[] = [];
  if (typeof p.providerId === "string" || typeof p.modelId === "string") {
    parts.push([p.providerId, p.modelId].filter((v) => typeof v === "string").join(" / "));
  }
  if (typeof p.durationMs === "number") parts.push(formatDurationMs(p.durationMs) ?? "");
  if (typeof p.attempt === "number") parts.push(typeof p.maxAttempts === "number" ? `attempt ${p.attempt} of ${p.maxAttempts}` : `attempt ${p.attempt}`);
  if (typeof p.retryInMs === "number") parts.push(`retry in ${Math.round(p.retryInMs / 1000)}s`);
  if (typeof p.claims === "number" && p.claims > 0) {
    parts.push(`${p.claims} claim${p.claims === 1 ? "" : "s"}${typeof p.claimsContradicted === "number" ? ` — ${p.claimsContradicted} contradicted` : ""}`);
  }
  const category = typeof p.category === "string" ? p.category : typeof p.failureCategory === "string" ? p.failureCategory : null;
  if (category) parts.push(category.replace(/_/g, " "));
  return parts.filter(Boolean).join(" · ") || null;
}

export function BacklogActivity({ events }: { events: BacklogEventDTO[] }) {
  if (events.length === 0) return <EmptyState message="No activity yet." />;
  return (
    <Timeline
      entries={events.map((event) => ({
        id: event.id,
        label: labelForBacklogEvent(event.type),
        detail: detailFor(event),
        createdAt: event.createdAt,
      }))}
    />
  );
}
