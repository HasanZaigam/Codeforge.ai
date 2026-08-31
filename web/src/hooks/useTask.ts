import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { tasksApi } from "../api/index.js";
import type { TaskDTO } from "../api/index.js";

const POLL_INTERVAL_MS = 3000;

/** Stops polling once the task reaches a stable state — NEEDS_INPUT included, since only local action (answering) or another poll cycle after that answer changes it further. */
export function isActiveStatus(status: TaskDTO["status"] | undefined): boolean {
  return status === "TODO" || status === "WORKING";
}

export function useTask(taskId: string) {
  const fetcher = useCallback(() => tasksApi.get(taskId), [taskId]);
  const { data, error, loading, refetch } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: (task) => isActiveStatus(task?.status),
    deps: [taskId],
  });

  return { task: data, error, loading, refetch };
}
