import { ListTodoIcon } from "lucide-react";
import type { ProjectRepoDTO, TaskDTO, TaskStatus } from "../../api/index.js";
import { BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS, STATUS_META } from "../../lib/statusMeta.js";
import { TONE_DOT } from "../../lib/tone.js";
import { TaskCard } from "./TaskCard.js";
import { EmptyState } from "../common/EmptyState.js";
import { cn } from "@/lib/utils";

/**
 * Horizontal scroll on all viewport sizes (see /docs/UI_ARCHITECTURE.md
 * "Responsive strategy") — five roughly-phone-width columns snap-scroll
 * naturally on mobile without a separate tab/stack layout to maintain.
 * FAILED and CANCELLED are not among the five requested columns; both are
 * comparatively rare outcomes (an infrastructure failure, or a developer
 * deciding to stop a task), so each only appears as an extra column when at
 * least one task actually has that status — see TECHNICAL_DECISIONS.md TD-25.
 */
export function KanbanBoard({
  tasks,
  defaultBranch,
  repositories,
  onTaskChanged,
}: {
  tasks: TaskDTO[];
  /** The owning project's default branch — threaded through to each BACKLOG TaskCard's Edit dialog. */
  defaultBranch: string;
  /** The project's repositories — passed through to each card (repository badge + Edit dialog). */
  repositories?: ProjectRepoDTO[];
  onTaskChanged?: (task: TaskDTO) => void;
}) {
  // Every task in the project — passed straight through to each TaskCard's Edit dialog, which
  // needs the full same-project task list to populate its "Depends on" picker (excluding itself).
  const allTasks = tasks;
  const byStatus = new Map<TaskStatus, TaskDTO[]>();
  for (const task of tasks) {
    const bucket = byStatus.get(task.status) ?? [];
    bucket.push(task);
    byStatus.set(task.status, bucket);
  }

  const columns: TaskStatus[] = [...BOARD_COLUMNS, ...CONDITIONAL_BOARD_COLUMNS.filter((status) => byStatus.has(status))];

  if (tasks.length === 0) {
    return <EmptyState icon={<ListTodoIcon />} message="No tasks yet. Create one to get started." />;
  }

  return (
    <div className="board -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
      {columns.map((status) => {
        const columnTasks = byStatus.get(status) ?? [];
        const tone = STATUS_META[status].tone;
        return (
          <div
            className="board-column flex w-[280px] shrink-0 snap-start flex-col rounded-3xl bg-muted/50 p-2"
            key={status}
          >
            <div className="flex items-center justify-between px-2 pt-1 pb-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className={cn("size-2 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
                {STATUS_META[status].label}
              </span>
              <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                {columnTasks.length}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {columnTasks.length === 0 ? (
                <p className="rounded-2xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">No tasks</p>
              ) : (
                columnTasks.map((task) => (
                  <TaskCard key={task.id} task={task} defaultBranch={defaultBranch} repositories={repositories} allTasks={allTasks} onChanged={onTaskChanged} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
