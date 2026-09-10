import { useState } from "react";
import { Link } from "react-router-dom";
import type { TaskDTO } from "../../api/index.js";
import { isActiveStatus } from "../../hooks/useTask.js";
import { StartTaskControl } from "../task-detail/StartTaskControl.js";
import { CancelTaskControl } from "../task-detail/CancelTaskControl.js";
import { CreateTaskDialog } from "./CreateTaskDialog.js";

/**
 * Deliberately minimal — only what a developer needs to decide "is this
 * worth opening right now": title, a two-line description, and the current
 * activity. No logs, no technical detail — that lives in Task Details. See
 * Step 4 instructions §8.
 *
 * A BACKLOG task additionally shows three actions, all siblings of the
 * card's own Link (never nested inside it, so clicking any of them never
 * also navigates to Task Details): "▶ Start Task" (StartTaskControl),
 * "✎ Edit" (opens CreateTaskDialog in edit mode, pre-filled from this
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
    <p className="text-muted dependency-info" style={{ fontSize: "0.8rem" }}>
      <span>Depends on: {task.dependencies.map((d) => d.title).join(", ")}</span>
      {blockedBy.length > 0 && (
        <>
          {" · "}
          <span className="dependency-blocked">Blocked by: {blockedBy.map((d) => d.title).join(", ")}</span>
        </>
      )}
    </p>
  );
}

export function TaskCard({
  task,
  defaultBranch,
  allTasks,
  onChanged,
}: {
  task: TaskDTO;
  /** The owning project's default branch — passed through to the Edit dialog's "new branch" base-branch field. */
  defaultBranch: string;
  /** Every task in the project — passed through to the Edit dialog's dependency picker (excluding this task itself). Optional: callers that don't yet have the full list (e.g. isolated tests) simply get no dependency picker. */
  allTasks?: TaskDTO[];
  onChanged?: (task: TaskDTO) => void;
}) {
  const active = isActiveStatus(task.status);
  const [editing, setEditing] = useState(false);

  function handleEditClick(e: React.MouseEvent) {
    // TaskCard renders this inside a clickable card — never let the click also navigate.
    e.preventDefault();
    e.stopPropagation();
    setEditing(true);
  }

  return (
    <div className="card task-card">
      <Link to={`/tasks/${task.id}`} className="task-card-link">
        <h4>{task.title}</h4>
        <p className="description">{task.description}</p>
        <p className={`activity${active ? " active" : ""}`}>
          {task.currentActivity}
          {task.selfFixAttempts > 0 && ` · attempt ${task.selfFixAttempts + 1}`}
        </p>
        <DependencyInfo task={task} />
      </Link>
      {task.status === "BACKLOG" && (
        <div className="task-card-actions">
          <StartTaskControl task={task} onStarted={(updated) => onChanged?.(updated)} />
          <button type="button" className="btn-link" onClick={handleEditClick}>
            ✎ Edit
          </button>
          <CancelTaskControl task={task} onCancelled={(updated) => onChanged?.(updated)} />
        </div>
      )}
      {editing && (
        <CreateTaskDialog
          projectId={task.projectId}
          defaultBranch={defaultBranch}
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
