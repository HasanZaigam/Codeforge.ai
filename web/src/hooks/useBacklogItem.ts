import { useCallback } from "react";
import { usePolling } from "./usePolling.js";
import { backlogApi } from "../api/index.js";
import type { BacklogItemDetailDTO } from "../api/index.js";

const POLL_INTERVAL_MS = 3000;

/**
 * Backs the backlog item detail page. Polls only while the item is ANALYZING (the analysis runs in
 * the background — see BacklogService.requestAnalysis); or a proposal is CONVERTING, or a claim verification job is queued/running; every other state is stable until a human acts.
 * `adopt` swaps in a server response so an action's result shows immediately, without a loading flash.
 */
export function useBacklogItem(itemId: string) {
  const fetcher = useCallback(() => backlogApi.get(itemId), [itemId]);
  const { data, error, loading, refetch, setData } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: (d) => d?.item.status === "ANALYZING" || d?.proposal?.status === "CONVERTING" || (d?.verificationJobs ?? []).some((j) => j.status === "QUEUED" || j.status === "RUNNING"),
    deps: [itemId],
  });

  const adopt = useCallback(
    (update: (current: BacklogItemDetailDTO) => BacklogItemDetailDTO) => {
      setData((current) => (current ? update(current) : current));
    },
    [setData],
  );

  return { detail: data, error, loading, refetch, adopt };
}
