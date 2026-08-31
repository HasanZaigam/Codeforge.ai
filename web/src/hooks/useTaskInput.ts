import { useCallback, useEffect, useState } from "react";
import { humanInputApi } from "../api/index.js";
import type { HumanAnswer, HumanInputRequestDTO, TaskDTO } from "../api/index.js";

/**
 * Loads the open NEEDS_INPUT question (only meaningful while the task is in
 * that status) and exposes a submit() that answers it. The frontend never
 * sets task status itself — submit() only calls POST /tasks/:id/input and
 * hands the resulting TaskDTO back to the caller to adopt.
 */
export function useTaskInput(taskId: string, active: boolean) {
  const [input, setInput] = useState<HumanInputRequestDTO | null>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(active);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    humanInputApi
      .get(taskId)
      .then((r) => !cancelled && setInput(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [taskId, active]);

  const submit = useCallback(
    async (answer: HumanAnswer): Promise<TaskDTO> => {
      setSubmitting(true);
      setError(undefined);
      try {
        return await humanInputApi.submit(taskId, answer);
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        throw wrapped;
      } finally {
        setSubmitting(false);
      }
    },
    [taskId],
  );

  return { input, error, loading, submitting, submit };
}
