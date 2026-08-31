import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { projectsApi } from "../api/index.js";
import type { TaskDTO } from "../api/index.js";

const POLL_INTERVAL_MS = 3000;

function hasActiveWork(tasks: TaskDTO[] | undefined): boolean {
  return (tasks ?? []).some((t) => t.status === "TODO" || t.status === "WORKING");
}

/**
 * Backs the Kanban board. Polls only while at least one task in the project
 * is TODO/WORKING — once everything is REVIEW/NEEDS_INPUT/DONE/FAILED,
 * polling stops on its own. See /docs/UI_ARCHITECTURE.md "Polling strategy".
 */
export function useProjectTasks(projectId: string) {
  const fetcher = useCallback(() => projectsApi.listTasks(projectId), [projectId]);
  const { data, error, loading, refetch, setData } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: hasActiveWork,
    deps: [projectId],
  });

  /** Shows a just-created task on the board immediately, without waiting for the next poll. */
  const addOptimisticTask = useCallback(
    (task: TaskDTO) => {
      setData((current) => [task, ...(current ?? [])]);
    },
    [setData],
  );

  return { tasks: data, error, loading, refetch, addOptimisticTask };
}
