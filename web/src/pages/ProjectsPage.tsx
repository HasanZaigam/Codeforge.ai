import { useState } from "react";
import { useProjects } from "../hooks/useProjects.js";
import { ProjectCard } from "../components/projects/ProjectCard.js";
import { CreateProjectDialog } from "../components/projects/CreateProjectDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { EmptyState } from "../components/common/EmptyState.js";
import type { ProjectDTO } from "../api/index.js";

export function ProjectsPage() {
  const { projects, error, loading, refetch } = useProjects();
  const [creating, setCreating] = useState(false);
  const [localProjects, setLocalProjects] = useState<ProjectDTO[]>([]);

  const allProjects = [...localProjects, ...(projects ?? [])];

  function handleCreated(project: ProjectDTO) {
    setLocalProjects((prev) => [project, ...prev]);
    setCreating(false);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="page-subtitle">Connect a repository and give it tasks in plain language.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Connect Project
        </button>
      </div>

      {loading && <LoadingState label="Loading projects…" />}
      {error && !loading && <ErrorState message="Couldn't load your projects." onRetry={refetch} />}
      {!loading && !error && allProjects.length === 0 && (
        <EmptyState
          icon="📁"
          message="No projects connected yet."
          action={
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Connect your first project
            </button>
          }
        />
      )}
      {!loading && !error && allProjects.length > 0 && (
        <div className="project-grid">
          {allProjects.map((project) => (
            <ProjectCard key={project.id} project={project} taskCount={null} />
          ))}
        </div>
      )}

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} onCreated={handleCreated} />}
    </div>
  );
}
