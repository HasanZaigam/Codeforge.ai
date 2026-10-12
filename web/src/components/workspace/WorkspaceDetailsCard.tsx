import type { ProjectWorkspaceDTO } from "../../api/index.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";
import { formatAbsolute } from "../../lib/time.js";
import { ToneBadge } from "../common/ToneBadge.js";

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
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Workspace Details</h3>
        <p className="text-sm text-muted-foreground">The durable workspace record CodeForge keeps for this project.</p>
      </div>
      {loading && <LoadingState label="Loading workspace…" />}
      {!loading && (error || !valid) && <ErrorState message="Couldn't load the workspace for this project." />}
      {!loading && !error && valid && (
        <div className="space-y-3 rounded-3xl bg-card p-5 text-sm ring-1 ring-foreground/10">
          <ToneBadge tone="success">Active</ToneBadge>
          <dl className="divide-y rounded-2xl border">
            <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[140px_1fr]">
              <dt className="text-muted-foreground">Workspace ID</dt>
              <dd className="font-mono text-xs break-all">{workspace.id}</dd>
            </div>
            <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[140px_1fr]">
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatAbsolute(workspace.createdAt)}</dd>
            </div>
            <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[140px_1fr]">
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatAbsolute(workspace.updatedAt)}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
