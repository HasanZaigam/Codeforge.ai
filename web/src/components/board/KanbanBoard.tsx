import type { TaskDTO, TaskStatus } from "../../api/index.js";
import { BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS, STATUS_META } from "../../lib/statusMeta.js";
import { TaskCard } from "./TaskCard.js";
import { EmptyState } from "../common/EmptyState.js";

/**
 * Horizontal scroll on all viewport sizes (see /docs/UI_ARCHITECTURE.md
 * "Responsive strategy") — five roughly-phone-width columns snap-scroll
 * naturally on mobile without a separate tab/stack layout to maintain.
 * FAILED and CANCELLED are not among the five requested columns; both are
 * comparatively rare outcomes (an infrastructure failure, or a developer
 * deciding to stop a task), so each only appears as an extra column when at
 * least one task actually has that status — see TECHNICAL_DECISIONS.md TD-25.
 */
export function KanbanBoard({ tasks }: { tasks: TaskDTO[] }) {
  const byStatus = new Map<TaskStatus, TaskDTO[]>();
  for (const task of tasks) {
    const bucket = byStatus.get(task.status) ?? [];
    bucket.push(task);
    byStatus.set(task.status, bucket);
  }

  const columns: TaskStatus[] = [...BOARD_COLUMNS, ...CONDITIONAL_BOARD_COLUMNS.filter((status) => byStatus.has(status))];

  if (tasks.length === 0) {
    return <EmptyState icon="🗂️" message="No tasks yet. Create one to get started." />;
  }

  return (
    <div className="board">
      {columns.map((status) => {
        const columnTasks = byStatus.get(status) ?? [];
        return (
          <div className="board-column" key={status}>
            <div className="board-column-header">
              <span className="board-column-title">{STATUS_META[status].label}</span>
              <span className="board-column-count">{columnTasks.length}</span>
            </div>
            <div className="board-column-body">
              {columnTasks.length === 0 ? (
                <p className="text-muted" style={{ fontSize: "0.85rem" }}>
                  No tasks
                </p>
              ) : (
                columnTasks.map((task) => <TaskCard key={task.id} task={task} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
