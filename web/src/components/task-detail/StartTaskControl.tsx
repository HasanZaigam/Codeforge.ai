import { useState } from "react";
import { ErrorState } from "../common/ErrorState.js";
import { tasksApi, type TaskDTO } from "../../api/index.js";

/**
 * Renders the "Start Task" action for a BACKLOG task — the explicit human
 * release gate this milestone introduces (see /docs/TASK_LIFECYCLE.md "Task
 * lifecycle"): task creation now leaves a task in BACKLOG, and the worker
 * never touches it until a human calls POST /tasks/:id/start via this
 * control. Deliberately a plain text button, not a checkbox/toggle — this
 * is an irreversible "hand this off to the AI developer" action, not a
 * selection state.
 *
 * Mirrors CancelTaskControl's own shape: renders nothing for any status
 * other than BACKLOG, calls the API directly, and hands the resulting
 * TaskDTO back to the caller to adopt — the frontend never sets status
 * itself. On failure, the task is left exactly as it was (still BACKLOG)
 * and a clear error is shown via the same ErrorState component used
 * elsewhere, per /docs/UI_ARCHITECTURE.md "Error UX".
 */
export function StartTaskControl({ task, onStarted }: { task: TaskDTO; onStarted: (task: TaskDTO) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  if (task.status !== "BACKLOG") return null;

  async function handleStart(e: React.MouseEvent) {
    // TaskCard renders this inside a clickable card — never let the click also navigate.
    e.preventDefault();
    e.stopPropagation();
    setSubmitting(true);
    setError(undefined);
    try {
      const updated = await tasksApi.start(task.id);
      onStarted(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start this task. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="start-task-control">
      <button type="button" className="btn-link" onClick={handleStart} disabled={submitting}>
        {submitting ? "Starting…" : "▶ Start Task"}
      </button>
      {error && <ErrorState message={error} />}
    </div>
  );
}
