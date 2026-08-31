import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { tasksApi } from "../api/index.js";

const POLL_INTERVAL_MS = 3000;

/** `active` is driven by the parent's current task status (see isActiveStatus in useTask.ts) — one source of truth for "is this task still moving." */
export function useTaskEvents(taskId: string, active: boolean) {
  const fetcher = useCallback(() => tasksApi.listEvents(taskId), [taskId]);
  const { data, error, loading, refetch } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: () => active,
    deps: [taskId, active],
  });

  return { events: data, error, loading, refetch };
}
