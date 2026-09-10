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
    <div>
      <Link to={`/projects/${task.projectId}`} className="breadcrumb">
        ← Back to board
      </Link>

      <TaskHeader task={task} branchState={branchState} />

      <div style={{ marginBottom: 24 }}>
        <StartTaskControl task={task} onStarted={() => refetchTask()} />
        <CancelTaskControl task={task} onCancelled={() => refetchTask()} />
      </div>

      {isNeedsInput && input && (
        <div className="section">
          <NeedsInputPanel input={input} onSubmit={handleAnswer} submitting={submitting} />
        </div>
      )}

      <div className="section">
        <h2>Activity</h2>
        {eventsError ? <ErrorState message="Couldn't load activity." /> : <ActivityTimeline events={events ?? []} />}
      </div>

      {hasEvidence && (
        <div className="section">
          <h2>Result</h2>
          {reportError ? <ErrorState message="Couldn't load the report." /> : <ReportPanel task={task} report={report} />}
        </div>
      )}
    </div>
  );
}
