import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectWorkspace } from "../hooks/useProjectWorkspace.js";
import { ProjectContextPanel } from "../components/workspace/ProjectContextPanel.js";
import { WorkspaceDetailsCard } from "../components/workspace/WorkspaceDetailsCard.js";

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

  return (
    <div className="workspace-layout">
      <nav className="workspace-nav" aria-label="Workspace sections">
        <button type="button" className={section === "context" ? "active" : ""} onClick={() => setSection("context")}>
          <span className="workspace-nav-label">Project Context</span>
          <span className="workspace-nav-hint">AI guidance & rules</span>
        </button>
        <button type="button" className={section === "details" ? "active" : ""} onClick={() => setSection("details")}>
          <span className="workspace-nav-label">Workspace Details</span>
          <span className="workspace-nav-hint">Status, ID, timestamps</span>
        </button>
      </nav>

      <div className="workspace-main">
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
