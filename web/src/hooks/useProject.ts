import { useEffect, useState } from "react";
import { projectsApi } from "../api/index.js";
import type { ProjectDTO } from "../api/index.js";

/** A single project's own config doesn't change from background execution — one-shot fetch. */
export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectDTO>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    projectsApi
      .get(projectId)
      .then((p) => !cancelled && setProject(p))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { project, error, loading };
}
