import { Link, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectTasks } from "../hooks/useProjectTasks.js";
import { STATUS_META, BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS } from "../lib/statusMeta.js";
import { formatAbsolute } from "../lib/time.js";
import type { TaskStatus } from "../api/index.js";

/**
 * "What's the state of this project?" — a summary landing screen, not a working surface. Real work
 * (the task board, Project Context editing) lives one tab over; this page only ever reads data
 * already fetched by existing hooks (useProjectTasks — the same one Tasks uses), never invents
 * fields the backend doesn't return (no fabricated "ACTIVE/INACTIVE" status, no fake task counts).
 */
export function ProjectOverviewPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { tasks, error: tasksError, loading: tasksLoading } = useProjectTasks(project.id);

  const statusCounts = new Map<TaskStatus, number>();
  for (const task of tasks ?? []) {
    statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
  }
  const statusesToShow = [...BOARD_COLUMNS, ...CONDITIONAL_BOARD_COLUMNS.filter((s) => statusCounts.has(s))];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card card-padded stack" style={{ gap: 4 }}>
        <h3>Project details</h3>
        <p className="text-muted">Repository: {project.repoUrl}</p>
        <p className="text-muted">
          {project.sourceControlProvider} · {project.codingEngine} · default branch <code>{project.defaultBranch}</code>
        </p>
        <p className="text-muted">Created {formatAbsolute(project.createdAt)}</p>
        <p className="text-muted">Updated {formatAbsolute(project.updatedAt)}</p>
      </div>

      <div className="card card-padded stack" style={{ gap: 12 }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h3>Tasks</h3>
          <Link to={`/projects/${project.id}/tasks`} className="btn-link">
            View all tasks →
          </Link>
        </div>
        {tasksLoading && <p className="text-muted">Loading task summary…</p>}
        {tasksError && !tasksLoading && <p className="text-muted">Couldn't load a task summary right now.</p>}
        {!tasksLoading && !tasksError && (tasks?.length ?? 0) === 0 && <p className="text-muted">No tasks yet.</p>}
        {!tasksLoading && !tasksError && (tasks?.length ?? 0) > 0 && (
          <div className="overview-status-grid">
            {statusesToShow.map((status) => (
              <div key={status} className="overview-status-cell">
                <span className={`status-badge tone-${STATUS_META[status].tone}`}>{STATUS_META[status].label}</span>
                <span className="overview-status-count">{statusCounts.get(status) ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card card-padded stack" style={{ gap: 4 }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h3>Workspace</h3>
          <Link to={`/projects/${project.id}/workspace`} className="btn-link">
            Open workspace →
          </Link>
        </div>
        <p className="text-muted">Persistent project knowledge and AI guidance used by every task in this project.</p>
      </div>
    </div>
  );
}
