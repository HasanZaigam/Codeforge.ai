import type { BranchStateDTO, TaskDTO } from "../../api/index.js";
import { StatusBadge } from "../common/StatusBadge.js";
import { formatDuration } from "../../lib/time.js";
import { BranchStateNote } from "./BranchStateNote.js";

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
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        Will use existing branch: <code>{task.workingBranch}</code>
      </p>
    );
  }

  const base = task.baseBranch ?? "the repository's default branch";
  return (
    <p className="text-muted" style={{ fontSize: "0.85rem" }}>
      {task.workingBranch ? (
        <>
          Will create branch <code>{task.workingBranch}</code> from <code>{base}</code>
        </>
      ) : (
        <>Will create a new branch from {task.baseBranch ? <code>{base}</code> : base}</>
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
    <p className="text-muted dependency-info" style={{ fontSize: "0.85rem" }}>
      <span>Depends on: {task.dependencies.map((d) => d.title).join(", ")}</span>
      {blockedBy.length > 0 && (
        <>
          {" · "}
          <span className="dependency-blocked">Blocked by: {blockedBy.map((d) => d.title).join(", ")}</span>
        </>
      )}
    </p>
  );
}

export function TaskHeader({ task, branchState }: { task: TaskDTO; branchState?: BranchStateDTO }) {
  const duration = formatDuration(task.startedAt, task.completedAt);
  return (
    <div className="task-detail-header">
      <div className="title-row">
        <h1>{task.title}</h1>
        <StatusBadge status={task.status} />
      </div>
      <p className="text-muted">{task.description}</p>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        {task.currentActivity}
        {duration && ` · took ${duration}`}
      </p>
      <DependencyInfo task={task} />
      <BranchPlan task={task} />
      <BranchStateNote task={task} branchState={branchState} />
    </div>
  );
}
