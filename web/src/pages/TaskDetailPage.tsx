import { Link, useParams } from "react-router-dom";
import { useTask, isActiveStatus } from "../hooks/useTask.js";
import { useTaskEvents } from "../hooks/useTaskEvents.js";
import { useTaskInput } from "../hooks/useTaskInput.js";
import { useTaskReport } from "../hooks/useTaskReport.js";
import { useBranchState } from "../hooks/useBranchState.js";
import { TaskHeader } from "../components/task-detail/TaskHeader.js";
import { ActivityTimeline } from "../components/task-detail/ActivityTimeline.js";
import { NeedsInputPanel } from "../components/task-detail/NeedsInputPanel.js";
import { ReportPanel } from "../components/task-detail/ReportPanel.js";
import { CancelTaskControl } from "../components/task-detail/CancelTaskControl.js";
import { StartTaskControl } from "../components/task-detail/StartTaskControl.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { EmptyState } from "../components/common/EmptyState.js";
import { ChevronLeftIcon } from "lucide-react";

/** The technical-detail screen (Step 4 instructions §10) — everything the board card intentionally omits lives here. */
export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { task, error: taskError, loading: taskLoading, refetch: refetchTask } = useTask(taskId!);

  const active = isActiveStatus(task?.status);
  const isNeedsInput = task?.status === "NEEDS_INPUT";
  // Neither BACKLOG nor TODO has any evidence yet — nothing has executed, so there's no report or
  // branch state to fetch (the report endpoint pre-dates this milestone's addition of BACKLOG).
  const hasEvidence = task ? task.status !== "BACKLOG" && task.status !== "TODO" : false;

  const { events, error: eventsError } = useTaskEvents(taskId!, active);
  const { input, submit, submitting } = useTaskInput(taskId!, isNeedsInput);
  const { report, error: reportError } = useTaskReport(taskId!, hasEvidence);
  const { branchState } = useBranchState(taskId!, hasEvidence);

  if (taskLoading) return <LoadingState label="Loading task…" />;
  if (taskError || !task) return <ErrorState message="Couldn't load this task." onRetry={refetchTask} />;

  async function handleAnswer(answer: { selectedOption: string | null; freeText: string }) {
    const updated = await submit(answer);
    refetchTask();
    return updated;
  }

  return (
    <div className="space-y-6">
      <Link
        to={`/projects/${task.projectId}/tasks`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Back to tasks
      </Link>

      <div className="space-y-4 rounded-4xl bg-card p-6 ring-1 ring-foreground/10">
        <TaskHeader task={task} branchState={branchState} />
        <div className="flex flex-wrap gap-2 empty:hidden">
          <StartTaskControl task={task} onStarted={() => refetchTask()} />
          <CancelTaskControl task={task} onCancelled={() => refetchTask()} />
        </div>
      </div>

      {isNeedsInput && input && <NeedsInputPanel input={input} onSubmit={handleAnswer} submitting={submitting} />}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          {hasEvidence ? (
            <>
              <h2 className="text-lg font-semibold">Result</h2>
              {reportError ? <ErrorState message="Couldn't load the report." /> : <ReportPanel task={task} report={report} />}
            </>
          ) : (
            <EmptyState message="Nothing has run yet — results appear here once the task starts executing." />
          )}
        </div>

        <aside className="space-y-3 lg:sticky lg:top-6">
          <h2 className="text-lg font-semibold">Activity</h2>
          <div className="rounded-3xl bg-card p-5 ring-1 ring-foreground/10">
            {eventsError ? <ErrorState message="Couldn't load activity." /> : <ActivityTimeline events={events ?? []} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
