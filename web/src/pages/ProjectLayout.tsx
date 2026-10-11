import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useProject } from "../hooks/useProject.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import type { ProjectDTO } from "../api/index.js";

export interface ProjectOutletContext {
  project: ProjectDTO;
}

/**
 * The shared frame for every project-scoped screen (Overview/Tasks/Workspace/Settings) — fetches
 * the project once here and hands it down via Outlet context, so none of the four tab pages re-fetch
 * it. Replaces the old single-page ProjectBoardPage: Projects, Tasks, and Project Workspace are now
 * deliberately separate routes/screens (see /docs/UI_ARCHITECTURE.md) instead of one long page.
 */
export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, error, loading } = useProject(projectId!);

  if (loading) return <LoadingState label="Loading project…" />;
  if (error || !project) return <ErrorState message="Couldn't load this project." />;

  return (
    <div>
      <Link to="/" className="breadcrumb">
        ← Projects
      </Link>

      <div className="project-header">
        <h1>{project.name}</h1>
        <a className="project-header-repo" href={project.repoUrl} target="_blank" rel="noreferrer">
          {project.repoUrl}
        </a>
      </div>

      <nav className="project-tabs" aria-label="Project">
        <NavLink to="" end className={({ isActive }) => (isActive ? "active" : "")}>
          Overview
        </NavLink>
        <NavLink to="workspace" className={({ isActive }) => (isActive ? "active" : "")}>
          Workspace
        </NavLink>
        <NavLink to="tasks" className={({ isActive }) => (isActive ? "active" : "")}>
          Tasks
        </NavLink>
        <NavLink to="settings" className={({ isActive }) => (isActive ? "active" : "")}>
          Settings
        </NavLink>
      </nav>

      <div className="project-tab-content">
        <Outlet context={{ project } satisfies ProjectOutletContext} />
      </div>
    </div>
  );
}
