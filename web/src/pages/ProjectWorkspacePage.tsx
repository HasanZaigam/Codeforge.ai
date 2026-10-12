import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectWorkspace } from "../hooks/useProjectWorkspace.js";
import { ProjectContextPanel } from "../components/workspace/ProjectContextPanel.js";
import { WorkspaceDetailsCard } from "../components/workspace/WorkspaceDetailsCard.js";
import { BookOpenTextIcon, DatabaseIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Section = "context" | "details";

/**
 * "What does the AI need to know about this project?" — a dedicated Project Workspace screen,
 * distinct from a task execution's ephemeral working directory (src/workspace/*, untouched). Left
 * nav mirrors the reference design's sidebar; the two sections stay mounted at all times and are
 * only toggled via the `hidden` attribute (never conditionally rendered) so switching sections can
 * never discard in-progress Project Context edits or trigger a refetch — see ProjectContextPanel's
 * own isolation guarantees, which this page must not undermine.
 */
export function ProjectWorkspacePage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const { workspace, error: workspaceError, loading: workspaceLoading } = useProjectWorkspace(project.id);
  const [section, setSection] = useState<Section>("context");

  const navItem = (active: boolean) =>
    cn(
      "flex shrink-0 flex-col items-start gap-0.5 rounded-2xl px-4 py-3 text-left transition-colors",
      active ? "active bg-card shadow-sm ring-1 ring-foreground/10" : "hover:bg-muted/60",
    );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 lg:sticky lg:top-6 lg:mx-0 lg:flex-col lg:px-0" aria-label="Workspace sections">
        <button type="button" className={navItem(section === "context")} onClick={() => setSection("context")}>
          <span className="flex items-center gap-2 text-sm font-medium">
            <BookOpenTextIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Project Context
          </span>
          <span className="text-xs text-muted-foreground">AI guidance & rules</span>
        </button>
        <button type="button" className={navItem(section === "details")} onClick={() => setSection("details")}>
          <span className="flex items-center gap-2 text-sm font-medium">
            <DatabaseIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Workspace Details
          </span>
          <span className="text-xs text-muted-foreground">Status, ID, timestamps</span>
        </button>
      </nav>

      <div className="min-w-0">
        <div hidden={section !== "context"}>
          <ProjectContextPanel projectId={project.id} />
        </div>
        <div hidden={section !== "details"}>
          <WorkspaceDetailsCard workspace={workspace} loading={workspaceLoading} error={workspaceError} />
        </div>
      </div>
    </div>
  );
}
