import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { ChevronLeftIcon, ExternalLinkIcon, FolderGit2Icon, GitBranchIcon, LayoutDashboardIcon, ListTodoIcon, PlusIcon, Settings2Icon, FolderCodeIcon } from "lucide-react";
import { useProject } from "../hooks/useProject.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import type { ProjectDTO } from "../api/index.js";
import { cn } from "@/lib/utils";

export interface ProjectOutletContext {
  project: ProjectDTO;
  /** Re-reads the project after a change made on one of its screens (e.g. a repository connected in Settings). */
  refreshProject: () => Promise<void>;
}

const TABS = [
  { to: "", end: true, label: "Overview", icon: LayoutDashboardIcon },
  { to: "workspace", end: false, label: "Workspace", icon: FolderCodeIcon },
  { to: "tasks", end: false, label: "Tasks", icon: ListTodoIcon },
  { to: "settings", end: false, label: "Settings", icon: Settings2Icon },
] as const;

/**
 * The shared frame for every project-scoped screen (Overview/Tasks/Workspace/Settings) — fetches
 * the project once here and hands it down via Outlet context, so none of the four tab pages re-fetch
 * it. Projects, Tasks, and Project Workspace are deliberately separate routes/screens (see
 * /docs/UI_ARCHITECTURE.md) instead of one long page.
 */
export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, error, loading, refresh } = useProject(projectId!);

  if (loading) return <LoadingState label="Loading project…" />;
  if (error || !project) return <ErrorState message="Couldn't load this project." />;

  const initial = project.name.trim().charAt(0).toUpperCase() || "?";
  const repos = project.repositories ?? [];

  return (
    <div className="space-y-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Projects
      </Link>

      <div className="flex items-start gap-4">
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 font-heading text-lg font-semibold text-primary"
          aria-hidden="true"
        >
          {initial}
        </span>
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {repos.length === 0 && (
              <Link to="settings" className="inline-flex items-center gap-1 text-primary hover:underline">
                <PlusIcon className="size-3.5" aria-hidden="true" />
                Connect a repository
              </Link>
            )}
            {repos.length === 1 && (
              <>
                <a
                  className="inline-flex min-w-0 items-center gap-1 hover:text-foreground"
                  href={repos[0]!.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="truncate">{repos[0]!.repoUrl}</span>
                  <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
                </a>
                <span className="inline-flex items-center gap-1">
                  <GitBranchIcon className="size-3.5" aria-hidden="true" />
                  {repos[0]!.defaultBranch}
                </span>
              </>
            )}
            {repos.length > 1 && (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <FolderGit2Icon className="size-3.5" aria-hidden="true" />
                {repos.map((r) => (
                  <span key={r.id} className="rounded-full border px-2 py-0.5 text-xs text-foreground" title={r.repoUrl}>
                    {r.name}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      </div>

      <nav
        className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0"
        aria-label="Project"
      >
        {TABS.map(({ to, end, label, icon: Icon }) => (
          <NavLink
            key={label}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "active border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div>
        <Outlet context={{ project, refreshProject: refresh } satisfies ProjectOutletContext} />
      </div>
    </div>
  );
}
