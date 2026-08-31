import type { TaskDTO } from "../../api/index.js";
import { StatusBadge } from "../common/StatusBadge.js";
import { formatDuration } from "../../lib/time.js";

export function TaskHeader({ task }: { task: TaskDTO }) {
  const duration = formatDuration(task.startedAt, task.completedAt);
  return (
    <div className="task-detail-header">
      <div className="title-row">
        <h1>{task.title}</h1>
        <StatusBadge status={task.status} />
      </div>
      <p className="text-muted">{task.description}</p>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        {task.currentActivity}
        {duration && ` · took ${duration}`}
      </p>
    </div>
  );
}
