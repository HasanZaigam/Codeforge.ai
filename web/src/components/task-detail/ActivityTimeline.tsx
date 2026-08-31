import type { TaskEventDTO } from "../../api/index.js";
import { labelForEvent } from "../../lib/eventLabels.js";
import { formatRelative } from "../../lib/time.js";
import { EmptyState } from "../common/EmptyState.js";

/** Renders the event log as plain language — see /docs/UI_ARCHITECTURE.md "Activity timeline". Raw TaskEventType names never reach the screen. */
export function ActivityTimeline({ events }: { events: TaskEventDTO[] }) {
  if (events.length === 0) {
    return <EmptyState message="No activity yet." />;
  }

  const lastIndex = events.length - 1;
  return (
    <div className="timeline">
      {events.map((event, i) => (
        <div className={`timeline-item${i === lastIndex ? " latest" : ""}`} key={event.id}>
          <div className="dot" />
          <div className="content">
            <span className="label">{labelForEvent(event.type)}</span>
            <span className="time">{formatRelative(event.createdAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
