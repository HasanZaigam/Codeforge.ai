import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { backlogApi } from "../api/index.js";
import type { BacklogItemSummaryDTO } from "../api/index.js";

const POLL_INTERVAL_MS = 3000;

function hasAnalyzingItem(items: BacklogItemSummaryDTO[] | undefined): boolean {
  return (items ?? []).some((i) => i.status === "ANALYZING");
}

/** Backs the Backlog list. Polls only while at least one item is ANALYZING — same rule as useProjectTasks. */
export function useProjectBacklog(projectId: string) {
  const fetcher = useCallback(() => backlogApi.list(projectId), [projectId]);
  const { data, error, loading, refetch } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: hasAnalyzingItem,
    deps: [projectId],
  });

  return { items: data, error, loading, refetch };
}
