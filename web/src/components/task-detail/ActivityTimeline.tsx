import type { TaskEventDTO } from "../../api/index.js";
import { labelForEvent } from "../../lib/eventLabels.js";
import { detailForEvent } from "../../lib/eventDetail.js";
import { formatAbsolute, formatRelative } from "../../lib/time.js";
import { EmptyState } from "../common/EmptyState.js";

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

  const lastIndex = events.length - 1;
  return (
    <div className="timeline">
      {events.map((event, i) => {
        const detail = detailForEvent(event);
        return (
          <div className={`timeline-item${i === lastIndex ? " latest" : ""}`} key={event.id}>
            <div className="dot" />
            <div className="content">
              <span className="label">{labelForEvent(event.type)}</span>
              {detail && <span className="detail">{detail}</span>}
              <span className="time" title={formatAbsolute(event.createdAt)}>
                {formatRelative(event.createdAt)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
