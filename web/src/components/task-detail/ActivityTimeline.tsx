import type { TaskEventDTO } from "../../api/index.js";
import { labelForEvent } from "../../lib/eventLabels.js";
import { detailForEvent } from "../../lib/eventDetail.js";
import { EmptyState } from "../common/EmptyState.js";
import { Timeline } from "../common/Timeline.js";

/**
 * Renders the event log as plain language — see /docs/UI_ARCHITECTURE.md "Activity timeline" and
 * TASK_LIFECYCLE.md "Execution history and observability". Raw TaskEventType names never reach the
 * screen; the small detail line under each item comes straight from that event's own persisted
 * payload (see eventDetail.ts) — never fabricated, never a second event system.
 */
export function ActivityTimeline({ events }: { events: TaskEventDTO[] }) {
  if (events.length === 0) {
    return <EmptyState message="No activity yet." />;
  }

  return (
    <Timeline
      entries={events.map((event) => ({
        id: event.id,
        label: labelForEvent(event.type),
        detail: detailForEvent(event),
        createdAt: event.createdAt,
      }))}
    />
  );
}
