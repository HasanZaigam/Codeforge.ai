import { Link, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { useProjectTasks } from "../hooks/useProjectTasks.js";
import { STATUS_META, BOARD_COLUMNS, CONDITIONAL_BOARD_COLUMNS } from "../lib/statusMeta.js";
import type { TaskStatus } from "../api/index.js";
import { ChatPanel } from "../components/chat/ChatPanel.js";
import { ProjectTokenMeter } from "../components/projects/ProjectTokenMeter.js";
import { useState } from "react";
import { StatusBadge } from "../components/common/StatusBadge.js";
import { TONE_DOT } from "../lib/tone.js";
import { ArrowRightIcon, FolderGit2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Statuses that genuinely need a human to look at them, in priority order — everything else is just a count. */
const ATTENTION_STATUSES: TaskStatus[] = ["NEEDS_INPUT", "REVIEW", "FAILED"];

/**
 * The command center for a project: Chat first (the primary way work enters the system), then a
 * compact "what needs me?" task summary, then a Workspace shortcut. Repository/engine/branch
 * metadata that already lives in Settings is intentionally NOT repeated here as a large card — see
 * the compact meta line below the project name instead. Reads the SAME useProjectTasks hook Tasks
 * uses; nothing here is a fabricated status or count.
 */
export function ProjectOverviewPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const repos = project.repositories ?? [];
  // Bumped after every Chat reply so the token meter reflects what that reply used.
  const [usageVersion, setUsageVersion] = useState(0);
  const { tasks, error: tasksError, loading: tasksLoading } = useProjectTasks(project.id);

  const statusCounts = new Map<TaskStatus, number>();
  for (const task of tasks ?? []) {
    statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
  }
  const statusesToShow = [...BOARD_COLUMNS, ...CONDITIONAL_BOARD_COLUMNS.filter((s) => statusCounts.has(s))];
  const attentionTasks = (tasks ?? [])
    .filter((t) => ATTENTION_STATUSES.includes(t.status))
    .sort((a, b) => ATTENTION_STATUSES.indexOf(a.status) - ATTENTION_STATUSES.indexOf(b.status));

  return (
    <div className="space-y-4">
      <ProjectTokenMeter projectId={project.id} refreshKey={usageVersion} />

      <div className="flex flex-wrap gap-2">
        {repos.length === 1 && (
          <>
            <Badge variant="secondary">{repos[0]!.sourceControlProvider}</Badge>
            <Badge variant="secondary">branch: {repos[0]!.defaultBranch}</Badge>
          </>
        )}
        {repos.length > 1 &&
          repos.map((r) => (
            <Badge key={r.id} variant="outline" title={r.repoUrl}>
              <FolderGit2Icon data-icon="inline-start" />
              {r.name}
            </Badge>
          ))}
      </div>

      {repos.length === 0 && (
        <div className="flex flex-col gap-3 rounded-3xl border border-dashed p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="font-medium">Connect a repository to start</p>
            <p className="text-sm text-muted-foreground">
              One repository for a monorepo, or each one the project is split across. Tasks need a repository to work in.
            </p>
          </div>
          <Link to={`/projects/${project.id}/settings`} className={buttonVariants()}>
            Connect repository
          </Link>
        </div>
      )}

      {/* DOM order is Chat-first (matches the mobile stacking order: Chat → Tasks → Workspace); on
          desktop the grid puts Chat in the wide left column and Tasks/Workspace in a narrow right rail. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="overflow-hidden rounded-4xl bg-card ring-1 ring-foreground/10 lg:sticky lg:top-6">
          <ChatPanel projectId={project.id} onReply={() => setUsageVersion((v) => v + 1)} />
        </section>

        <div className="space-y-4">
          <Card className="overview-block">
            <CardHeader>
              <CardTitle>
                <h3>Tasks</h3>
              </CardTitle>
              <CardAction>
                <Link to={`/projects/${project.id}/tasks`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  View all
                  <ArrowRightIcon data-icon="inline-end" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              {tasksLoading && <p className="text-sm text-muted-foreground">Loading task summary…</p>}
              {tasksError && !tasksLoading && (
                <p className="text-sm text-muted-foreground">Couldn't load a task summary right now.</p>
              )}
              {!tasksLoading && !tasksError && (tasks?.length ?? 0) === 0 && (
                <p className="text-sm text-muted-foreground">No tasks yet.</p>
              )}

              {!tasksLoading && !tasksError && (tasks?.length ?? 0) > 0 && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {statusesToShow.map((status) => (
                      <span
                        key={status}
                        className="overview-status-pill flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span className={cn("size-2 rounded-full", TONE_DOT[STATUS_META[status].tone])} aria-hidden="true" />
                          {STATUS_META[status].label}
                        </span>
                        <strong className="tabular-nums">{statusCounts.get(status) ?? 0}</strong>
                      </span>
                    ))}
                  </div>

                  {attentionTasks.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Needs attention ({attentionTasks.length})
                      </p>
                      <ul className="space-y-1">
                        {attentionTasks.map((t) => (
                          <li key={t.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm hover:bg-muted/60">
                            <StatusBadge status={t.status} />
                            <Link className="min-w-0 truncate hover:underline" to={`/tasks/${t.id}`}>
                              {t.title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing needs your attention right now.</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="overview-block">
            <CardHeader>
              <CardTitle>
                <h3>Workspace</h3>
              </CardTitle>
              <CardAction>
                <Link to={`/projects/${project.id}/workspace`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  Open
                  <ArrowRightIcon data-icon="inline-end" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-sm font-medium">Project context</p>
              <p className="text-sm text-muted-foreground">
                Architecture, rules and validation guidance are available to CodeForge.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
