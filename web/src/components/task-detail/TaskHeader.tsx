import type { BranchStateDTO, TaskDTO } from "../../api/index.js";
import { StatusBadge } from "../common/StatusBadge.js";
import { formatDuration } from "../../lib/time.js";
import { BranchStateNote } from "./BranchStateNote.js";
import { ActivityIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";

/**
 * The branch plan configured at creation/edit time (`branchMode`/`workingBranch`/`baseBranch`) —
 * shown only before real execution has picked an actual branch (`task.branchName` still null;
 * BranchStateNote/ReportPanel take over once it's set — see their own doc comments). No extra
 * fetch: every field this reads is already on the TaskDTO the page already has.
 */
function BranchPlan({ task }: { task: TaskDTO }) {
  if (task.branchName) return null; // execution has already picked the real branch — see ReportPanel's "Branch:" line

  if (task.branchMode === "existing") {
    return (
      <p className="inline-flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <GitBranchIcon className="size-3.5" aria-hidden="true" />
        Will use existing branch: <code className="font-mono text-xs text-foreground">{task.workingBranch}</code>
      </p>
    );
  }

  const base = task.baseBranch ?? "the repository's default branch";
  return (
    <p className="inline-flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      <GitBranchIcon className="size-3.5" aria-hidden="true" />
      {task.workingBranch ? (
        <>
          Will create branch <code className="font-mono text-xs text-foreground">{task.workingBranch}</code> from{" "}
          <code className="font-mono text-xs text-foreground">{base}</code>
        </>
      ) : (
        <>Will create a new branch from {task.baseBranch ? <code className="font-mono text-xs text-foreground">{base}</code> : base}</>
      )}
    </p>
  );
}

/**
 * "Depends on: A, B" (all of them) and, when any are still incomplete, "Blocked by: A" (only
 * those) — derived, read-only, straight off `task.dependencies` (see /docs/TASK_LIFECYCLE.md "Task
 * dependencies"). No graph visualization, just plain text — mirrors BranchPlan's own "no extra
 * fetch, no persisted status" shape immediately above.
 */
function DependencyInfo({ task }: { task: TaskDTO }) {
  if (task.dependencies.length === 0) return null;
  const blockedBy = task.dependencies.filter((d) => !d.satisfied);
  return (
    <p className="text-sm text-muted-foreground">
      <span>Depends on: {task.dependencies.map((d) => d.title).join(", ")}</span>
      {blockedBy.length > 0 && (
        <>
          {" · "}
          <span className="font-medium text-tone-attention">Blocked by: {blockedBy.map((d) => d.title).join(", ")}</span>
        </>
      )}
    </p>
  );
}

export function TaskHeader({ task, branchState }: { task: TaskDTO; branchState?: BranchStateDTO }) {
  const duration = formatDuration(task.startedAt, task.completedAt);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <h1 className="min-w-0 flex-1 text-2xl font-semibold">{task.title}</h1>
        <StatusBadge status={task.status} className="mt-1.5 h-6 px-2.5 text-sm" />
      </div>
      <p className="max-w-3xl text-muted-foreground">{task.description}</p>
      {task.repositoryName && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <FolderGit2Icon className="size-3.5" aria-hidden="true" />
          Repository <span className="font-medium text-foreground">{task.repositoryName}</span>
        </p>
      )}
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <ActivityIcon className="size-3.5" aria-hidden="true" />
        <span>
          {task.currentActivity}
          {duration && ` · took ${duration}`}
        </span>
      </p>
      <DependencyInfo task={task} />
      <BranchPlan task={task} />
      <BranchStateNote task={task} branchState={branchState} />
    </div>
  );
}
