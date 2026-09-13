import { useEffect, useState } from "react";
import { projectsApi } from "../api/index.js";
import type { ProjectWorkspaceDTO } from "../api/index.js";

/**
 * Phase 3 "Project Workspace" (Slice 2, frontend). One-shot fetch, same shape as useProject —
 * this data doesn't change from background execution either. Deliberately isolated from the
 * rest of the page's data-fetching: a failure here must never affect tasks/board rendering,
 * so this hook is only ever consumed by the workspace section itself, never awaited by anything
 * else on the page.
 */
export function useProjectWorkspace(projectId: string) {
  const [workspace, setWorkspace] = useState<ProjectWorkspaceDTO>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    projectsApi
      .getWorkspace(projectId)
      .then((w) => !cancelled && setWorkspace(w))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { workspace, error, loading };
}
