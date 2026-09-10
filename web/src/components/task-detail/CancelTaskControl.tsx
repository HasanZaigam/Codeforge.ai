import { useState } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { tasksApi, type TaskDTO } from "../../api/index.js";

const CANCELLABLE_STATUSES: TaskDTO["status"][] = ["BACKLOG", "TODO", "WORKING", "NEEDS_INPUT"];

/**
 * Shown on the task detail page for any task the backend can actually
 * cancel (see /docs/TASK_LIFECYCLE.md "Cancellation" — TODO, WORKING, and
 * NEEDS_INPUT are all cancellable; REVIEW/DONE/CANCELLED/FAILED are not).
 * Never renders a button on those terminal/finished states — see Step 5
 * instructions §15. The frontend never sets status directly: this only
 * calls POST /tasks/:id/cancel and hands the resulting TaskDTO back to the
 * caller to adopt, exactly like NeedsInputPanel's submit flow.
 */
export function CancelTaskControl({ task, onCancelled }: { task: TaskDTO; onCancelled: (task: TaskDTO) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  if (!CANCELLABLE_STATUSES.includes(task.status)) return null;

  if (task.cancelRequested) {
    return (
      <span className="text-muted" style={{ fontSize: "0.85rem" }}>
        Cancelling…
      </span>
    );
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(undefined);
    try {
      const updated = await tasksApi.cancel(task.id);
      onCancelled(updated);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel this task. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // A BACKLOG task was never released to the AI developer, so the explanatory body text differs
  // from the "stop working" copy below — but the action is still "Cancel" everywhere, never
  // "Delete": cancelling transitions the task to CANCELLED and keeps its history record, it does
  // not remove it. Same POST /tasks/:id/cancel call either way — BACKLOG -> CANCELLED is just
  // another row in the same state machine (see task-state-machine.ts).
  const isBacklog = task.status === "BACKLOG";

  if (confirming) {
    return (
      <Dialog title="Cancel this task?" onClose={() => (submitting ? undefined : setConfirming(false))}>
        <p style={{ marginBottom: 16 }}>
          {isBacklog
            ? "This task will be removed from Backlog and never sent to the AI developer. It stays visible in Tasks as Cancelled, in case you need to refer back to it."
            : "The autonomous developer will stop working on this task. Any changes in its isolated workspace will be discarded " +
              "unless already pushed to a branch through the platform's normal source-control flow — the activity log will still " +
              "show what was done before cancelling."}
        </p>
        {error && <ErrorState message={error} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={submitting}>
            {isBacklog ? "Keep Task" : "Keep Working"}
          </button>
          <button type="button" className="btn btn-danger" onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Cancelling…" : "Confirm cancellation"}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <button className="btn-link-muted" onClick={() => setConfirming(true)}>
      Cancel task
    </button>
  );
}
