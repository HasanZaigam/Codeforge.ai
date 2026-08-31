import { Link } from "react-router-dom";
import type { ProjectDTO } from "../../api/index.js";

export function ProjectCard({ project, taskCount }: { project: ProjectDTO; taskCount: number | null }) {
  return (
    <Link to={`/projects/${project.id}`} className="card project-card">
      <h3>{project.name}</h3>
      <p className="repo">{project.repoUrl}</p>
      <p className="meta">
        {project.sourceControlProvider} · {project.codingEngine}
      </p>
      <p className="meta">{taskCount === null ? "—" : `${taskCount} task${taskCount === 1 ? "" : "s"}`}</p>
    </Link>
  );
}
