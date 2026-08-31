import { Link } from "react-router-dom";
import type { TaskDTO } from "../../api/index.js";
import { isActiveStatus } from "../../hooks/useTask.js";

/**
 * Deliberately minimal — only what a developer needs to decide "is this
 * worth opening right now": title, a two-line description, and the current
 * activity. No logs, no technical detail — that lives in Task Details. See
 * Step 4 instructions §8.
 */
export function TaskCard({ task }: { task: TaskDTO }) {
  const active = isActiveStatus(task.status);
  return (
    <Link to={`/tasks/${task.id}`} className="card task-card">
      <h4>{task.title}</h4>
      <p className="description">{task.description}</p>
      <p className={`activity${active ? " active" : ""}`}>
        {task.currentActivity}
        {task.selfFixAttempts > 0 && ` · attempt ${task.selfFixAttempts + 1}`}
      </p>
    </Link>
  );
}
