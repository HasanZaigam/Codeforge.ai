import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { tasksApi } from "../api/index.js";

const POLL_INTERVAL_MS = 3000;

/** Same "poll only while active" shape as useTaskEvents — see that file and /docs/UI_ARCHITECTURE.md. */
export function useTaskReport(taskId: string, active: boolean) {
  const fetcher = useCallback(() => tasksApi.getReport(taskId), [taskId]);
  const { data, error, loading, refetch } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: () => active,
    deps: [taskId, active],
  });

  return { report: data, error, loading, refetch };
}
