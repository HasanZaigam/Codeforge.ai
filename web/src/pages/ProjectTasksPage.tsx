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
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The dedicated "what work is being executed?" screen — see /docs/UI_ARCHITECTURE.md. Same task
 *  data/lifecycle as before (useProjectTasks, unchanged); only the surrounding page changed. */
export function ProjectTasksPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { tasks, error, loading, refetch, addOptimisticTask, replaceTask } = useProjectTasks(project.id);
  const [creating, setCreating] = useState(false);
  const isMobile = useIsMobile();

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">Tasks</h2>
          <p className="text-sm text-muted-foreground">Plain-language work items for this project.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          Create Task
        </Button>
      </div>

      {loading && <LoadingState label="Loading tasks…" />}
      {error && !loading && <ErrorState message="Couldn't load tasks for this project." onRetry={refetch} />}
      {!loading &&
        !error &&
        (isMobile ? (
          <MobileTaskList tasks={tasks ?? []} defaultBranch={project.defaultBranch} repositories={project.repositories} onTaskChanged={replaceTask} />
        ) : (
          <KanbanBoard tasks={tasks ?? []} defaultBranch={project.defaultBranch} repositories={project.repositories} onTaskChanged={replaceTask} />
        ))}

      {creating && (
        <CreateTaskDialog
          projectId={project.id}
          defaultBranch={project.defaultBranch}
          repositories={project.repositories}
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
