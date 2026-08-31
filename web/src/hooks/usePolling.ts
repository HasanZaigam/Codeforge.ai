import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export interface UsePollingResult<T> {
  data: T | undefined;
  error: Error | undefined;
  /** True only while there is no data yet (the very first load). */
  loading: boolean;
  refetch: () => void;
  /** Escape hatch for optimistic local updates (e.g. inserting a just-created task) ahead of the next poll. */
  setData: Dispatch<SetStateAction<T | undefined>>;
}

export interface UsePollingOptions<T> {
  intervalMs: number;
  /** Polling stops once this returns false for the latest data — see /docs/UI_ARCHITECTURE.md "Polling strategy". */
  shouldPoll: (data: T | undefined) => boolean;
  /** Re-runs the initial fetch (and resets to loading) when any of these change. */
  deps?: unknown[];
}

/**
 * Generic self-rescheduling poll (setTimeout-after-response, not
 * setInterval) so a slow request never overlaps the next one — the same
 * principle the backend worker uses for its own poll loop (see
 * src/worker/worker.ts). Pauses while the tab is hidden and resumes with an
 * immediate refetch when it becomes visible again.
 */
export function usePolling<T>(fetcher: () => Promise<T>, options: UsePollingOptions<T>): UsePollingResult<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const shouldPollRef = useRef(options.shouldPoll);
  shouldPollRef.current = options.shouldPoll;

  const [generation, setGeneration] = useState(0);
  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  const deps = options.deps ?? [];

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(undefined);

    async function runOnce() {
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        setData(result);
        setError(undefined);
        setLoading(false);
        scheduleNext(result);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
        scheduleNext(undefined);
      }
    }

    function scheduleNext(latest: T | undefined) {
      if (cancelled || !shouldPollRef.current(latest)) return;
      if (document.hidden) return; // resumed by the visibilitychange listener below
      timer = setTimeout(runOnce, options.intervalMs);
    }

    function onVisibilityChange() {
      if (!document.hidden && !cancelled) runOnce();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    runOnce();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, options.intervalMs, ...deps]);

  return { data, error, loading, refetch, setData };
}
