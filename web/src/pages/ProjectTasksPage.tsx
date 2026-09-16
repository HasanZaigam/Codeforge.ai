import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectTasks } from "../hooks/useProjectTasks.js";
import { useIsMobile } from "../hooks/useIsMobile.js";
import { KanbanBoard } from "../components/board/KanbanBoard.js";
import { MobileTaskList } from "../components/board/MobileTaskList.js";
import { CreateTaskDialog } from "../components/board/CreateTaskDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";

/** The dedicated "what work is being executed?" screen — see /docs/UI_ARCHITECTURE.md. Same task
 *  data/lifecycle as before (useProjectTasks, unchanged); only the surrounding page changed. */
export function ProjectTasksPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { tasks, error, loading, refetch, addOptimisticTask, replaceTask } = useProjectTasks(project.id);
  const [creating, setCreating] = useState(false);
  const isMobile = useIsMobile();

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Tasks</h2>
          <p className="page-subtitle">Plain-language work items for this project.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Create Task
        </button>
      </div>

      {loading && <LoadingState label="Loading tasks…" />}
      {error && !loading && <ErrorState message="Couldn't load tasks for this project." onRetry={refetch} />}
      {!loading &&
        !error &&
        (isMobile ? (
          <MobileTaskList tasks={tasks ?? []} defaultBranch={project.defaultBranch} onTaskChanged={replaceTask} />
        ) : (
          <KanbanBoard tasks={tasks ?? []} defaultBranch={project.defaultBranch} onTaskChanged={replaceTask} />
        ))}

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
