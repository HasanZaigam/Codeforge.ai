import { useState } from "react";
import type { TaskDTO, TaskStatus } from "../../api/index.js";
import { BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS, STATUS_META } from "../../lib/statusMeta.js";
import { TaskCard } from "./TaskCard.js";
import { EmptyState } from "../common/EmptyState.js";

/**
 * The mobile-native counterpart to KanbanBoard (see /docs/UI_ARCHITECTURE.md "Responsive
 * strategy") — a horizontally-scrolling multi-column board doesn't work one-handed on a phone, so
 * mobile gets a completely different representation instead of a squeezed-down board: a row of
 * status filter chips (same tones/labels as StatusBadge — one shared source of truth, statusMeta.ts)
 * above a single vertical list of full-width TaskCards for whichever status is selected.
 */
export function MobileTaskList({
  tasks,
  defaultBranch,
  onTaskChanged,
}: {
  tasks: TaskDTO[];
  defaultBranch: string;
  onTaskChanged?: (task: TaskDTO) => void;
}) {
  const byStatus = new Map<TaskStatus, TaskDTO[]>();
  for (const task of tasks) {
    const bucket = byStatus.get(task.status) ?? [];
    bucket.push(task);
    byStatus.set(task.status, bucket);
  }
  const statuses: TaskStatus[] = [...BOARD_COLUMNS, ...CONDITIONAL_BOARD_COLUMNS.filter((s) => byStatus.has(s))];
  const [selected, setSelected] = useState<"ALL" | TaskStatus>("ALL");

  if (tasks.length === 0) {
    return <EmptyState icon="🗂️" message="No tasks yet. Create one to get started." />;
  }

  const visible = selected === "ALL" ? tasks : (byStatus.get(selected) ?? []);

  return (
    <div className="mobile-task-list">
      <div className="status-chip-row" role="tablist" aria-label="Filter tasks by status">
        <button
          type="button"
          role="tab"
          aria-selected={selected === "ALL"}
          className={`status-chip${selected === "ALL" ? " active" : ""}`}
          onClick={() => setSelected("ALL")}
        >
          All <span className="status-chip-count">{tasks.length}</span>
        </button>
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={selected === status}
            className={`status-chip tone-${STATUS_META[status].tone}${selected === status ? " active" : ""}`}
            onClick={() => setSelected(status)}
          >
            {STATUS_META[status].label} <span className="status-chip-count">{byStatus.get(status)?.length ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-muted" style={{ padding: "12px 0" }}>
          No tasks with this status.
        </p>
      ) : (
        <div className="mobile-task-list-items">
          {visible.map((task) => (
            <TaskCard key={task.id} task={task} defaultBranch={defaultBranch} allTasks={tasks} onChanged={onTaskChanged} />
          ))}
        </div>
      )}
    </div>
  );
}
