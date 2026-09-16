import { useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { formatAbsolute } from "../lib/time.js";

/**
 * Read-only project settings — every field here already exists on ProjectDTO; there is no backend
 * "update project" endpoint, so this deliberately does not present itself as an editor (no invented
 * capability — see the redesign's "do not invent backend data/behavior" constraint).
 */
export function ProjectSettingsPage() {
  const { project } = useOutletContext<ProjectOutletContext>();

  return (
    <div className="card card-padded stack" style={{ gap: 12 }}>
      <p className="field-hint">Project settings are currently read-only from this screen.</p>
      <dl className="info-callout" style={{ margin: 0 }}>
        <dt>Project name</dt>
        <dd>{project.name}</dd>
        <dt>Repository</dt>
        <dd>{project.repoUrl}</dd>
        <dt>Source control</dt>
        <dd>{project.sourceControlProvider}</dd>
        <dt>Coding engine</dt>
        <dd>{project.codingEngine}</dd>
        <dt>Default branch</dt>
        <dd>{project.defaultBranch}</dd>
        <dt>Validation commands declared</dt>
        <dd>{project.commandsDeclared.length > 0 ? project.commandsDeclared.join(", ") : "None"}</dd>
        <dt>Created</dt>
        <dd>{formatAbsolute(project.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatAbsolute(project.updatedAt)}</dd>
      </dl>
    </div>
  );
}
