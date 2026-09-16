import type { ProjectWorkspaceDTO } from "../../api/index.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";
import { formatAbsolute } from "../../lib/time.js";

/**
 * Extracted verbatim from the old ProjectBoardPage's "Workspace Details" block (Phase 3 "Project
 * Workspace", Slice 2) — same fields, same text, same malformed-payload fallback. Deliberately kept
 * secondary (see ProjectWorkspacePage): this is the durable ProjectWorkspace *record* (existence/
 * timestamps), not the AI-facing knowledge that lives in Project Context, and `updatedAt` is never
 * reinterpreted as task or project activity.
 */
export function WorkspaceDetailsCard({
  workspace,
  loading,
  error,
}: {
  workspace: ProjectWorkspaceDTO | undefined;
  loading: boolean;
  error: Error | undefined;
}) {
  const valid = !!workspace && typeof workspace.id === "string" && typeof workspace.createdAt === "string" && typeof workspace.updatedAt === "string";

  return (
    <div>
      <h3>Workspace Details</h3>
      {loading && <LoadingState label="Loading workspace…" />}
      {!loading && (error || !valid) && <ErrorState message="Couldn't load the workspace for this project." />}
      {!loading && !error && valid && (
        <div className="card card-padded stack" style={{ gap: 4 }}>
          <p>
            <span className="status-badge tone-success">Active</span>
          </p>
          <p className="text-muted">Workspace ID: {workspace.id}</p>
          <p className="text-muted">Created: {formatAbsolute(workspace.createdAt)}</p>
          <p className="text-muted">Updated: {formatAbsolute(workspace.updatedAt)}</p>
        </div>
      )}
    </div>
  );
}
