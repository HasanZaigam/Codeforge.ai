import { useEffect, useState } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";
import type { RepositorySetup } from "../components/projects/CreateProjectDialog.js";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { projectsApi, type ProjectDTO, type ProjectRepoDTO } from "../api/index.js";
import { Dialog, DialogActions } from "../components/common/Dialog.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { formatAbsolute } from "../lib/time.js";
import { Button } from "@/components/ui/button";
import { Section } from "../components/common/Section.js";
import { CircleCheckIcon, FolderGit2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { EmptyState } from "../components/common/EmptyState.js";
import { RepositoryCard } from "../components/projects/RepositoryCard.js";
import { ConnectRepositoryDialog } from "../components/projects/ConnectRepositoryDialog.js";
import { ProjectTokenBudgetSection } from "../components/projects/ProjectTokenBudgetSection.js";

/**
 * Project settings: the project's own facts, its REPOSITORIES (TD-62 — one for a monorepo, several for
 * a codebase split across repositories; each with its own default branch and validation commands),
 * and the Danger Zone. Name/coding engine stay read-only — there is no "update project" endpoint for
 * them, so this doesn't pretend to be an editor for those.
 */
export function ProjectSettingsPage() {
  const { project, refreshProject } = useOutletContext<ProjectOutletContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState<ProjectRepoDTO[]>(project.repositories ?? []);
  // Guided setup right after "Create project": how many repositories the user said they have. Read once
  // from the navigation state, then cleared below so a reload doesn't restart it.
  const [guidedSetup, setGuidedSetup] = useState<RepositorySetup | undefined>(
    () => (location.state as { repositorySetup?: RepositorySetup } | null)?.repositorySetup,
  );
  const [connecting, setConnecting] = useState(guidedSetup !== undefined && (project.repositories ?? []).length === 0);

  useEffect(() => {
    if (guidedSetup) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleConnected(repository: ProjectRepoDTO) {
    setConnecting(false);
    afterRepositoryChange([...repositories, repository]);
    // A single-repository project is ready as soon as its repository is connected.
    if (guidedSetup === "single") navigate(`/projects/${project.id}`);
  }

  // Every repository change is also reflected in the project header and the other tabs.
  function afterRepositoryChange(next: ProjectRepoDTO[]) {
    setRepositories(next);
    void refreshProject().catch(() => {});
  }

  const facts: Array<[string, string]> = [
    ["Project name", project.name],
    ["Coding engine", project.codingEngine],
    ["Repositories", repositories.length === 0 ? "None connected yet" : repositories.map((r) => r.name).join(", ")],
    ["Created", formatAbsolute(project.createdAt)],
    ["Updated", formatAbsolute(project.updatedAt)],
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Section title="Project details" description="Project settings are currently read-only from this screen.">
        <dl className="info-callout divide-y rounded-2xl border text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[160px_1fr] sm:gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <section className="flex flex-col gap-3" aria-labelledby="repositories-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 id="repositories-heading" className="text-lg font-semibold">
              Repositories
            </h2>
            <p className="text-sm text-muted-foreground">
              Connect one repository for a monorepo, or each repository the project is split across — frontend, backend,
              admin… Every task works in exactly one of them.
            </p>
          </div>
          <Button type="button" onClick={() => setConnecting(true)}>
            <PlusIcon data-icon="inline-start" />
            Connect repository
          </Button>
        </div>

        {guidedSetup === "multiple" && repositories.length > 0 && (
          <div className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center" role="status">
            <CircleCheckIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="flex-1 text-sm">
              <p className="font-medium">
                {repositories.length} repositor{repositories.length === 1 ? "y" : "ies"} connected: {repositories.map((r) => r.name).join(", ")}
              </p>
              <p className="text-muted-foreground">Connect each repository this project is split across, then you're ready to create tasks.</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" onClick={() => setConnecting(true)}>
                <PlusIcon data-icon="inline-start" />
                Connect another repository
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setGuidedSetup(undefined);
                  navigate(`/projects/${project.id}`);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}

        {repositories.length === 0 ? (
          <EmptyState
            icon={<FolderGit2Icon />}
            message="No repository connected yet. Connect one before creating tasks."
            action={<Button onClick={() => setConnecting(true)}>Connect your first repository</Button>}
          />
        ) : (
          repositories.map((repository) => (
            <RepositoryCard
              key={repository.id}
              projectId={project.id}
              repository={repository}
              onChanged={(updated) => afterRepositoryChange(repositories.map((r) => (r.id === updated.id ? updated : r)))}
              onRemoved={() => afterRepositoryChange(repositories.filter((r) => r.id !== repository.id))}
            />
          ))
        )}
      </section>

      <ProjectTokenBudgetSection projectId={project.id} />

      <DangerZone project={project} />

      {connecting && (
        <ConnectRepositoryDialog
          projectId={project.id}
          onClose={() => setConnecting(false)}
          onConnected={handleConnected}
        />
      )}
    </div>
  );
}

/**
 * Deleting a project is permanent (see ProjectService.delete/ProjectRepository.deleteCascade) —
 * same confirm-before-destructive-action shape as CancelTaskControl, one level more serious. The
 * backend itself blocks the delete (409 `PROJECT_HAS_ACTIVE_TASKS`) while any task is still
 * queued/executing/awaiting review, and its error message already names which ones — surfaced
 * as-is rather than re-derived here, since the frontend has no independent way to know that faster
 * than asking the server.
 */
function DangerZone({ project }: { project: ProjectDTO }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleConfirm() {
    setDeleting(true);
    setError(undefined);
    try {
      await projectsApi.delete(project.id);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this project. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-destructive/30 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-destructive">Danger Zone</h3>
        <p className="text-sm text-muted-foreground">
          Permanently deletes this project and all of its tasks. This cannot be undone. Blocked while any task is still queued,
          executing, or awaiting review — cancel or finish those first.
        </p>
      </div>
      <Button variant="destructive" type="button" className="shrink-0" onClick={() => setConfirming(true)}>
        <Trash2Icon data-icon="inline-start" />
        Delete project
      </Button>

      {confirming && (
        <Dialog title={`Delete "${project.name}"?`} onClose={() => (deleting ? undefined : setConfirming(false))}>
          <p className="text-sm text-muted-foreground">
            This permanently deletes <strong>{project.name}</strong> and every one of its tasks — activity history, reports, and
            all. This cannot be undone. The repository on GitHub itself is not affected.
          </p>
          {error && <ErrorState message={error} />}
          <DialogActions>
            <Button variant="outline" type="button" onClick={() => setConfirming(false)} disabled={deleting}>
              Keep Project
            </Button>
            <Button variant="destructive" type="button" onClick={handleConfirm} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Permanently"}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
