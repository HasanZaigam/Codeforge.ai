/**
 * Generic bounded exponential backoff with jitter, engine-agnostic (no
 * OpenCode/provider knowledge here — see engine-failure-classifier.ts for
 * that). Used by OpenCodeAdapter to space out retries of transient provider
 * failures. See /docs/CODING_ENGINE.md "Retry behavior".
 */

/** Full jitter (AWS's recommended strategy): delay is uniformly random in [0, cappedExponentialDelay]. */
export function computeBackoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.floor(Math.random() * capped);
}

/**
 * Waits `delayMs`, but resolves immediately (throwing `onAbort`'s result) if
 * `signal` aborts first — so a cancellation requested mid-backoff stops the
 * retry loop right away instead of waiting out the full delay. See
 * /docs/TASK_LIFECYCLE.md "Cancellation".
 */
export function sleepUnlessAborted(delayMs: number, signal: AbortSignal, onAbort: () => Error): Promise<void> {
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbortHandler);
      resolve();
    }, delayMs);
    const onAbortHandler = () => {
      clearTimeout(timer);
      reject(onAbort());
    };
    signal.addEventListener("abort", onAbortHandler, { once: true });
  });
}
