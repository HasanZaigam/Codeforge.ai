import { useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { projectsApi, type TaskDTO } from "../../api/index.js";

/**
 * Plain-language task creation only — title + description, no prompt
 * construction. See /docs/PRODUCT_REQUIREMENTS.md FR-3 and Step 4
 * instructions §9. The dialog closes and the board shows TODO immediately
 * (onCreated adds it optimistically) — the browser never waits for
 * execution to start.
 */
export function CreateTaskDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (task: TaskDTO) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const task = await projectsApi.createTask(projectId, { title: title.trim(), description: description.trim() });
      onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this task. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Create task" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="task-title">Title</label>
          <input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Fix OTP timeout login"
            required
            maxLength={300}
          />
        </div>
        <div className="field">
          <label htmlFor="task-description">Description</label>
          <textarea
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Client reports that OTP login fails after session timeout."
            required
            rows={5}
            maxLength={10000}
          />
          <p className="field-hint">Describe the problem in plain language — no need to write instructions for the AI.</p>
        </div>
        {error && <ErrorState message={error} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !title.trim() || !description.trim()}>
            {submitting ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
