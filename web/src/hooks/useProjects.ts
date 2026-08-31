import { useCallback, useEffect, useState } from "react";
import { projectsApi } from "../api/index.js";
import type { ProjectDTO } from "../api/index.js";

/** Projects change rarely (created by the developer, not by background execution) — a one-shot fetch with manual refetch is enough; no polling needed. */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectDTO[]>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(undefined);
    projectsApi
      .list()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return { projects, error, loading, refetch: load };
}
