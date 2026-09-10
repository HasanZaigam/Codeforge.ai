import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useProject } from "../hooks/useProject.js";
import { useProjectTasks } from "../hooks/useProjectTasks.js";
import { KanbanBoard } from "../components/board/KanbanBoard.js";
import { CreateTaskDialog } from "../components/board/CreateTaskDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";

export function ProjectBoardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, error: projectError, loading: projectLoading } = useProject(projectId!);
  const { tasks, error: tasksError, loading: tasksLoading, refetch, addOptimisticTask, replaceTask } = useProjectTasks(projectId!);
  const [creating, setCreating] = useState(false);

  if (projectLoading) return <LoadingState label="Loading project…" />;
  if (projectError || !project) return <ErrorState message="Couldn't load this project." />;

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
