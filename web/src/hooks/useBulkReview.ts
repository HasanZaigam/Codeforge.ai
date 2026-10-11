import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { bulkBacklogApi } from "../api/index.js";
import type { BulkReviewDTO, ReviewFilterKey } from "../api/index.js";

/** Polls only while some item's analysis is queued or running (the worker is doing it in the background). */
export function useBulkReview(projectId: string, filter: ReviewFilterKey) {
  const fetcher = useCallback(() => bulkBacklogApi.review(projectId, filter), [projectId, filter]);
  return usePolling<BulkReviewDTO>(fetcher, {
    intervalMs: 3000,
    shouldPoll: (d) => (d?.rows ?? []).some((r) => r.analysis.state === "QUEUED" || r.analysis.state === "RUNNING"),
    deps: [projectId, filter],
  });
}
