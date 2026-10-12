import { Link } from "react-router-dom";
import { ArrowUpRightIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";
import type { ProjectDTO } from "../../api/index.js";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/** taskCount stays null until the backend exposes per-project counts on the list endpoint — this
 *  never fetches each project's tasks individually just to fill in a number here (see
 *  /docs/API.md; GET /projects returns no task count today). */
export function ProjectCard({ project, taskCount }: { project: ProjectDTO; taskCount: number | null }) {
  const initial = project.name.trim().charAt(0).toUpperCase() || "?";
  const repos = project.repositories ?? [];
  return (
    <Link to={`/projects/${project.id}`} className="group block rounded-4xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      <Card className="h-full transition-shadow group-hover:shadow-md group-hover:ring-primary/30">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-xl bg-primary/10 font-heading font-semibold text-primary"
              aria-hidden="true"
            >
              {initial}
            </span>
            <ArrowUpRightIcon
              className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </div>
          <CardTitle className="pt-2">
            <h3 className="truncate">{project.name}</h3>
          </CardTitle>
          <CardDescription className="truncate font-mono text-xs">
            {repos.length === 0 ? "No repository connected yet" : repos.length === 1 ? repos[0]!.repoUrl : `${repos.length} repositories`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {repos.length > 1 ? (
            repos.map((r) => (
              <Badge key={r.id} variant="outline">
                {r.name}
              </Badge>
            ))
          ) : (
            <>
              {repos[0] && <Badge variant="secondary">{repos[0].sourceControlProvider}</Badge>}
              <Badge variant="secondary">{project.codingEngine}</Badge>
            </>
          )}
        </CardContent>
        <CardFooter className="justify-between text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {repos.length === 1 ? (
              <>
                <GitBranchIcon className="size-3.5" aria-hidden="true" />
                {repos[0]!.defaultBranch}
              </>
            ) : (
              <>
                <FolderGit2Icon className="size-3.5" aria-hidden="true" />
                {repos.length} repositor{repos.length === 1 ? "y" : "ies"}
              </>
            )}
          </span>
          <span>{taskCount === null ? "—" : `${taskCount} task${taskCount === 1 ? "" : "s"}`}</span>
        </CardFooter>
      </Card>
    </Link>
  );
}
