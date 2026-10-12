import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectRepoDTO, TaskDTO } from "../../api/index.js";
import { isActiveStatus } from "../../hooks/useTask.js";
import { StartTaskControl } from "../task-detail/StartTaskControl.js";
import { CancelTaskControl } from "../task-detail/CancelTaskControl.js";
import { CreateTaskDialog } from "./CreateTaskDialog.js";
import { FolderGit2Icon, PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Deliberately minimal — only what a developer needs to decide "is this
 * worth opening right now": title, a two-line description, and the current
 * activity. No logs, no technical detail — that lives in Task Details. See
 * Step 4 instructions §8.
 *
 * A BACKLOG task additionally shows three actions, all siblings of the
 * card's own Link (never nested inside it, so clicking any of them never
 * also navigates to Task Details): "Start Task" (StartTaskControl),
 * "Edit" (opens CreateTaskDialog in edit mode, pre-filled from this
 * task), and "Cancel task" (CancelTaskControl, which renders BACKLOG-specific
 * explanatory copy but keeps the action itself labeled "Cancel" — see its own
 * doc comment). All three hand the server's
 * updated TaskDTO back through the same `onChanged` callback so the board
 * reflects it immediately.
 */
/** "Depends on: A, B" (all of them) and, when any are still incomplete, "Blocked by: A" (only those) — derived, read-only, computed straight from `task.dependencies`. Mirrors BranchPlan's own "no extra fetch" shape. See /docs/TASK_LIFECYCLE.md "Task dependencies". */
function DependencyInfo({ task }: { task: TaskDTO }) {
  if (task.dependencies.length === 0) return null;
  const blockedBy = task.dependencies.filter((d) => !d.satisfied);
  return (
    <p className="text-xs text-muted-foreground">
      <span>Depends on: {task.dependencies.map((d) => d.title).join(", ")}</span>
      {blockedBy.length > 0 && (
        <>
          {" · "}
          <span className="font-medium text-tone-attention">Blocked by: {blockedBy.map((d) => d.title).join(", ")}</span>
        </>
      )}
    </p>
  );
}

export function TaskCard({
  task,
  defaultBranch,
  repositories,
  allTasks,
  onChanged,
}: {
  task: TaskDTO;
  /** The owning project's default branch — passed through to the Edit dialog's "new branch" base-branch field. */
  defaultBranch: string;
  /** The project's repositories — the card names the task's repository when there are several. */
  repositories?: ProjectRepoDTO[];
  /** Every task in the project — passed through to the Edit dialog's dependency picker (excluding this task itself). Optional: callers that don't yet have the full list (e.g. isolated tests) simply get no dependency picker. */
  allTasks?: TaskDTO[];
  onChanged?: (task: TaskDTO) => void;
}) {
  const active = isActiveStatus(task.status);
  // Only worth saying in a project with several repositories.
  const repositoryName = (repositories?.length ?? 0) > 1 ? repositories!.find((r) => r.id === task.repositoryId)?.name : undefined;
  const [editing, setEditing] = useState(false);

  function handleEditClick(e: React.MouseEvent) {
    // TaskCard renders this inside a clickable card — never let the click also navigate.
    e.preventDefault();
    e.stopPropagation();
    setEditing(true);
  }

  return (
    <div className="group rounded-2xl bg-card ring-1 ring-foreground/10 transition-shadow hover:shadow-md">
      <Link to={`/tasks/${task.id}`} className="block space-y-2 rounded-2xl p-3 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        {repositoryName && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            <FolderGit2Icon className="size-3" aria-hidden="true" />
            {repositoryName}
          </span>
        )}
        <h4 className="text-sm leading-snug font-medium group-hover:text-primary">{task.title}</h4>
        <p className="line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
        <p className={cn("flex items-center gap-1.5 text-xs", active ? "font-medium text-tone-active" : "text-muted-foreground")}>
          {active && <span className="size-1.5 animate-pulse rounded-full bg-tone-active" aria-hidden="true" />}
          <span>
            {task.currentActivity}
            {task.selfFixAttempts > 0 && ` · attempt ${task.selfFixAttempts + 1}`}
          </span>
        </p>
        <DependencyInfo task={task} />
      </Link>
      {task.status === "BACKLOG" && (
        <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
          <StartTaskControl task={task} onStarted={(updated) => onChanged?.(updated)} />
          <Button type="button" variant="ghost" size="xs" onClick={handleEditClick}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
          <CancelTaskControl task={task} onCancelled={(updated) => onChanged?.(updated)} />
        </div>
      )}
      {editing && (
        <CreateTaskDialog
          projectId={task.projectId}
          defaultBranch={defaultBranch}
          repositories={repositories}
          task={task}
          allTasks={allTasks}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            onChanged?.(updated);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
