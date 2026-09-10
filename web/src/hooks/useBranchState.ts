import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { tasksApi } from "../api/index.js";

const POLL_INTERVAL_MS = 15000; // slower than task/report polling — this is advisory display data, not part of the task lifecycle

/**
 * Stale/behind + merge/conflict state for a task's branch (see
 * /docs/TASK_LIFECYCLE.md "Stale/behind detection" and "Merge/conflict
 * state") — same "poll only while relevant" shape as useTaskReport.
 * `active` should be true once a task has a real branch to report on (i.e.
 * past TODO) — see TaskDetailPage's own `hasEvidence` flag.
 */
export function useBranchState(taskId: string, active: boolean) {
  const fetcher = useCallback(() => tasksApi.getBranchState(taskId), [taskId]);
  const { data, error, loading } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: () => active,
    deps: [taskId, active],
  });

  return { branchState: data, error, loading };
}
