import { Link } from "react-router-dom";
import type { ProjectDTO } from "../../api/index.js";

/** taskCount stays null until the backend exposes per-project counts on the list endpoint — this
 *  never fetches each project's tasks individually just to fill in a number here (see
 *  /docs/API.md; GET /projects returns no task count today). */
export function ProjectCard({ project, taskCount }: { project: ProjectDTO; taskCount: number | null }) {
  const initial = project.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <Link to={`/projects/${project.id}`} className="card project-card">
      <div className="project-card-top">
        <span className="project-card-avatar" aria-hidden="true">
          {initial}
        </span>
        <h3>{project.name}</h3>
      </div>
      <p className="repo">{project.repoUrl}</p>
      <p className="meta">
        {project.sourceControlProvider} · {project.codingEngine}
      </p>
      <p className="meta">{taskCount === null ? "—" : `${taskCount} task${taskCount === 1 ? "" : "s"}`}</p>
    </Link>
  );
}
