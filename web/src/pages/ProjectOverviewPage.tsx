import { Link, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectTasks } from "../hooks/useProjectTasks.js";
import { STATUS_META, BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS } from "../lib/statusMeta.js";
import type { TaskStatus } from "../api/index.js";
import { ChatPanel } from "../components/chat/ChatPanel.js";

/** Statuses that genuinely need a human to look at them, in priority order — everything else is just a count. */
const ATTENTION_STATUSES: TaskStatus[] = ["NEEDS_INPUT", "REVIEW", "FAILED"];

/**
 * The command center for a project: Chat first (the primary way work enters the system), then a
 * compact "what needs me?" task summary, then a Workspace shortcut. Repository/engine/branch
 * metadata that already lives in Settings is intentionally NOT repeated here as a large card — see
 * the compact meta line below the project name instead. Reads the SAME useProjectTasks hook Tasks
 * uses; nothing here is a fabricated status or count.
 */
export function ProjectOverviewPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { tasks, error: tasksError, loading: tasksLoading } = useProjectTasks(project.id);

  const statusCounts = new Map<TaskStatus, number>();
  for (const task of tasks ?? []) {
    statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
  }
  const statusesToShow = [...BOARD_COLUMNS, ...CONDITIONAL_BOARD_COLUMNS.filter((s) => statusCounts.has(s))];
  const attentionTasks = (tasks ?? [])
    .filter((t) => ATTENTION_STATUSES.includes(t.status))
    .sort((a, b) => ATTENTION_STATUSES.indexOf(a.status) - ATTENTION_STATUSES.indexOf(b.status));

  return (
    <div className="overview-page">
      <div className="overview-meta">
        <span className="status-badge tone-neutral">{project.sourceControlProvider}</span>
        <span className="status-badge tone-neutral">branch: {project.defaultBranch}</span>
      </div>

      {/* DOM order is Chat-first (matches the mobile stacking order: header → Chat → Tasks → Workspace);
          on desktop, .overview-main reverses the visual order via flex-direction so Chat lands on the
          right (65%) and Tasks/Workspace form the left column (35%) — see index.css. */}
      <div className="overview-main">
        <section className="overview-chat-col">
          <div className="overview-chat-card">
            <ChatPanel projectId={project.id} />
          </div>
        </section>

        <div className="overview-left-col">
          <section className="overview-block overview-block-tasks">
            <div className="overview-block-header">
              <h3>Tasks</h3>
              <Link to={`/projects/${project.id}/tasks`} className="btn-link">
                View all →
              </Link>
            </div>

            {tasksLoading && <p className="field-hint">Loading task summary…</p>}
            {tasksError && !tasksLoading && <p className="field-hint">Couldn't load a task summary right now.</p>}
            {!tasksLoading && !tasksError && (tasks?.length ?? 0) === 0 && <p className="field-hint">No tasks yet.</p>}

            {!tasksLoading && !tasksError && (tasks?.length ?? 0) > 0 && (
              <>
                <div className="overview-status-pills">
                  {statusesToShow.map((status) => (
                    <span key={status} className={`overview-status-pill tone-${STATUS_META[status].tone}`}>
                      {STATUS_META[status].label} <strong>{statusCounts.get(status) ?? 0}</strong>
                    </span>
                  ))}
                </div>

                {attentionTasks.length > 0 ? (
                  <div>
                    <p className="overview-attention-label">Needs attention ({attentionTasks.length})</p>
                    <ul className="overview-attention-list">
                      {attentionTasks.map((t) => (
                        <li key={t.id}>
                          <span className={`status-badge tone-${STATUS_META[t.status].tone}`}>{STATUS_META[t.status].label}</span>
                          <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="field-hint">Nothing needs your attention right now.</p>
                )}
              </>
            )}
          </section>

          <section className="overview-block overview-block-workspace">
            <div className="overview-block-header">
              <h3>Workspace</h3>
              <Link to={`/projects/${project.id}/workspace`} className="btn-link">
                Open →
              </Link>
            </div>
            <p className="overview-workspace-label">Project context</p>
            <p className="field-hint">Architecture, rules and validation guidance are available to CodeForge.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
