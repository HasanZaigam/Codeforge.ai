import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useProject } from "../hooks/useProject.js";
import { useProjectTasks } from "../hooks/useProjectTasks.js";
import { useProjectWorkspace } from "../hooks/useProjectWorkspace.js";
import { KanbanBoard } from "../components/board/KanbanBoard.js";
import { CreateTaskDialog } from "../components/board/CreateTaskDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { formatAbsolute } from "../lib/time.js";

export function ProjectBoardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, error: projectError, loading: projectLoading } = useProject(projectId!);
  const { tasks, error: tasksError, loading: tasksLoading, refetch, addOptimisticTask, replaceTask } = useProjectTasks(projectId!);
  const { workspace, error: workspaceError, loading: workspaceLoading } = useProjectWorkspace(projectId!);
  const [creating, setCreating] = useState(false);

  if (projectLoading) return <LoadingState label="Loading project…" />;
  if (projectError || !project) return <ErrorState message="Couldn't load this project." />;

  // A malformed/incomplete workspace payload (e.g. missing id/timestamps) is treated the same as
  // a fetch failure below — render the safe fallback rather than showing garbled data or crashing.
  const workspaceValid =
    !!workspace && typeof workspace.id === "string" && typeof workspace.createdAt === "string" && typeof workspace.updatedAt === "string";

  return (
    <div>
      <Link to="/" className="breadcrumb">
        ← Projects
      </Link>
      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          <p className="page-subtitle">{project.repoUrl}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Create Task
        </button>
      </div>

      <div className="section">
        <h2>Workspace</h2>
        {workspaceLoading && <LoadingState label="Loading workspace…" />}
        {!workspaceLoading && (workspaceError || !workspaceValid) && (
          <ErrorState message="Couldn't load the workspace for this project." />
        )}
        {!workspaceLoading && !workspaceError && workspaceValid && (
          <div className="card card-padded stack" style={{ gap: 4 }}>
            <p>
              <span className="status-badge tone-success">Active</span>
            </p>
            <p className="text-muted">Workspace ID: {workspace.id}</p>
            <p className="text-muted">Created: {formatAbsolute(workspace.createdAt)}</p>
            <p className="text-muted">Updated: {formatAbsolute(workspace.updatedAt)}</p>
          </div>
        )}
      </div>

      {tasksLoading && <LoadingState label="Loading tasks…" />}
      {tasksError && !tasksLoading && <ErrorState message="Couldn't load tasks for this project." onRetry={refetch} />}
      {!tasksLoading && !tasksError && (
        <KanbanBoard tasks={tasks ?? []} defaultBranch={project.defaultBranch} onTaskChanged={replaceTask} />
      )}

      {creating && (
        <CreateTaskDialog
          projectId={project.id}
          defaultBranch={project.defaultBranch}
          allTasks={tasks ?? []}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            addOptimisticTask(task);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
