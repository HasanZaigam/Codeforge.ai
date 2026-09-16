import { useCallback, useEffect, useState } from "react";
import { projectsApi } from "../api/index.js";
import type { ProjectContextDTO } from "../api/index.js";

/**
 * Phase 3 "Project Context" (Slice 8, frontend). One-shot fetch on mount, same isolation pattern
 * as useProjectWorkspace: deliberately independent of task-board polling/state (see
 * /docs/UI_ARCHITECTURE.md) — nothing here ever re-fetches on its own, so a task-board refresh can
 * never silently reset an in-progress edit in ProjectContextPanel. `reload` is exposed only for the
 * panel's own explicit "Reload Latest" (conflict recovery) and initial-load retry actions.
 */
export function useProjectContext(projectId: string) {
  const [context, setContext] = useState<ProjectContextDTO>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    setError(undefined);
    return projectsApi
      .getContext(projectId)
      .then((c) => {
        setContext(c);
        return c;
      })
      .catch((err) => {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        throw normalized;
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    projectsApi
      .getContext(projectId)
      .then((c) => !cancelled && setContext(c))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { context, error, loading, reload };
}
