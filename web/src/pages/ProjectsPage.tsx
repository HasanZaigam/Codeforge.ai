import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderGit2Icon, PlusIcon } from "lucide-react";
import { useProjects } from "../hooks/useProjects.js";
import { ProjectCard } from "../components/projects/ProjectCard.js";
import { CreateProjectDialog, type RepositorySetup } from "../components/projects/CreateProjectDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { EmptyState } from "../components/common/EmptyState.js";
import { PageHeader } from "../components/common/PageHeader.js";
import type { ProjectDTO } from "../api/index.js";
import { Button } from "@/components/ui/button";

export function ProjectsPage() {
  const { projects, error, loading, refetch } = useProjects();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const allProjects = projects ?? [];

  // A new project has no repository yet — go straight to connecting one, carrying how many the user
  // said they have (see ProjectSettingsPage's guided setup).
  function handleCreated(project: ProjectDTO, setup: RepositorySetup) {
    setCreating(false);
    navigate(`/projects/${project.id}/settings`, { state: { repositorySetup: setup } });
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Group your repositories into projects and give them tasks in plain language."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            Create Project
          </Button>
        }
      />

      {loading && <LoadingState label="Loading projects…" />}
      {error && !loading && <ErrorState message="Couldn't load your projects." onRetry={refetch} />}
      {!loading && !error && allProjects.length === 0 && (
        <EmptyState
          icon={<FolderGit2Icon />}
          message="No projects yet."
          action={<Button onClick={() => setCreating(true)}>Create your first project</Button>}
        />
      )}
      {!loading && !error && allProjects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {allProjects.map((project) => (
            <ProjectCard key={project.id} project={project} taskCount={null} />
          ))}
        </div>
      )}

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} onCreated={handleCreated} />}
    </div>
  );
}
