import { useState } from "react";
import { ListTodoIcon } from "lucide-react";
import type { ProjectRepoDTO, TaskDTO, TaskStatus } from "../../api/index.js";
import { BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS, STATUS_META } from "../../lib/statusMeta.js";
import { TONE_DOT } from "../../lib/tone.js";
import { TaskCard } from "./TaskCard.js";
import { EmptyState } from "../common/EmptyState.js";
import { cn } from "@/lib/utils";

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
  repositories,
  onTaskChanged,
}: {
  tasks: TaskDTO[];
  defaultBranch: string;
  /** The project's repositories — passed through to each card (repository badge + Edit dialog). */
  repositories?: ProjectRepoDTO[];
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
    return <EmptyState icon={<ListTodoIcon />} message="No tasks yet. Create one to get started." />;
  }

  const visible = selected === "ALL" ? tasks : (byStatus.get(selected) ?? []);
  const chipClass =
    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors aria-selected:border-primary aria-selected:bg-primary aria-selected:text-primary-foreground";

  return (
    <div className="space-y-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Filter tasks by status">
        <button type="button" role="tab" aria-selected={selected === "ALL"} className={chipClass} onClick={() => setSelected("ALL")}>
          All <span className="text-xs opacity-70 tabular-nums">{tasks.length}</span>
        </button>
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={selected === status}
            className={chipClass}
            onClick={() => setSelected(status)}
          >
            <span className={cn("size-1.5 rounded-full", TONE_DOT[STATUS_META[status].tone])} aria-hidden="true" />
            {STATUS_META[status].label} <span className="text-xs opacity-70 tabular-nums">{byStatus.get(status)?.length ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">No tasks with this status.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((task) => (
            <TaskCard key={task.id} task={task} defaultBranch={defaultBranch} repositories={repositories} allTasks={tasks} onChanged={onTaskChanged} />
          ))}
        </div>
      )}
    </div>
  );
}
