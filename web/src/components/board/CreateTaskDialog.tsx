import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { LoadingState } from "../common/LoadingState.js";
import { projectsApi, tasksApi, type TaskDTO, type BranchMode } from "../../api/index.js";

/** Mirrors the backend's `isSafeBranchName` charset (see src/api/schemas.ts) closely enough for
 *  instant client-side feedback — the server remains the source of truth and re-validates. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "task";
}

/**
 * Plain-language task creation — title + description, no prompt
 * construction — plus a branch-mode choice (see /docs/TASK_LIFECYCLE.md
 * "Branch modes"). "Create a new branch" (default, and the only mode that
 * existed before this feature) auto-suggests `task/<slugified-title>` off a
 * project-default base branch, both editable. "Work directly on an existing
 * branch" fetches the repository's real remote branches and requires
 * picking one — no branch name is ever typed by hand in that mode, so
 * there's nothing to sanitize on this path (the picker only ever offers
 * branches the server itself just listed).
 *
 * Also doubles as the "Edit task" form for a BACKLOG task: pass `task` and
 * this pre-fills every field from it, switches the submit action to
 * `tasksApi.edit` (POST /tasks/:taskId/edit — server-side gated to BACKLOG
 * only), and calls `onSaved` instead of `onCreated` with the updated
 * TaskDTO. Deliberately the same component/form rather than a parallel one
 * — see TaskCard.tsx's "Edit" action, which is the only current caller of
 * edit mode.
 */
export function CreateTaskDialog({
  projectId,
  defaultBranch,
  task,
  allTasks,
  onClose,
  onCreated,
  onSaved,
}: {
  projectId: string;
  /** The project's own default branch — pre-fills the "new branch" base-branch field. */
  defaultBranch: string;
  /** When present, the dialog opens in "edit" mode for this (BACKLOG) task instead of "create" mode. */
  task?: TaskDTO;
  /**
   * Every task in the project — used to populate the "Depends on" picker (see
   * /docs/TASK_LIFECYCLE.md "Task dependencies"). The current task (in edit mode) is always
   * excluded from its own dependency options. Optional/omittable: a caller with no task list yet
   * simply gets no dependency picker rather than a crash.
   */
  allTasks?: TaskDTO[];
  onClose: () => void;
  /** Create mode only. */
  onCreated?: (task: TaskDTO) => void;
  /** Edit mode only. */
  onSaved?: (task: TaskDTO) => void;
}) {
  const isEdit = !!task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const [branchMode, setBranchMode] = useState<BranchMode>(task?.branchMode ?? "new");
  const [baseBranch, setBaseBranch] = useState(task?.baseBranch ?? defaultBranch);
  const [branchName, setBranchName] = useState(task && task.branchMode !== "existing" ? (task.workingBranch ?? "") : "");
  // In edit mode the branch name (if any) is already pre-filled from the task — never let the
  // title-derived auto-suggest effect below clobber it, same as if a user had just typed it by hand.
  const [branchNameEdited, setBranchNameEdited] = useState(isEdit);

  const [existingBranch, setExistingBranch] = useState(task && task.branchMode === "existing" ? (task.workingBranch ?? "") : "");
  const [branches, setBranches] = useState<string[]>();
  const [branchesError, setBranchesError] = useState<string>();
  const [branchesLoading, setBranchesLoading] = useState(false);

  // Explicit, user-defined dependencies (see /docs/TASK_LIFECYCLE.md "Task dependencies") — no
  // AI inference, just a plain multi-select over this project's other tasks. Editable only while
  // BACKLOG: in edit mode that's already guaranteed (CreateTaskDialog's only edit-mode caller,
  // TaskCard, only ever opens it for a BACKLOG task), but the picker is disabled defensively below
  // too, in case a future caller opens edit mode against a task that has since left BACKLOG.
  const originalDependencyIds = useState(() => new Set(task?.dependencies.map((d) => d.id) ?? []))[0];
  const [selectedDependencyIds, setSelectedDependencyIds] = useState<string[]>([...originalDependencyIds]);
  const dependencyCandidates = (allTasks ?? []).filter((t) => t.id !== task?.id);
  const dependenciesLocked = isEdit && task!.status !== "BACKLOG";

  function toggleDependency(depId: string) {
    setSelectedDependencyIds((prev) => (prev.includes(depId) ? prev.filter((id) => id !== depId) : [...prev, depId]));
  }

  // Auto-suggest the new-branch name from the title, but never overwrite a name the user already
  // edited by hand — same "auto-suggested, never forced" contract as CreateProjectDialog's name field.
  useEffect(() => {
    if (branchMode === "new" && !branchNameEdited) {
      setBranchName(title.trim() ? `task/${slugify(title)}` : "");
    }
  }, [title, branchMode, branchNameEdited]);

  function loadBranches() {
    setBranchesLoading(true);
    setBranchesError(undefined);
    projectsApi
      .listBranches(projectId)
      .then((list) => setBranches(list))
      .catch((err) => setBranchesError(err instanceof Error ? err.message : "Could not load branches. Please try again."))
      .finally(() => setBranchesLoading(false));
  }

  // Fetch the real remote branch list the first time "existing branch" mode is selected — not
  // eagerly on dialog open, since most tasks never need it. A failed load's "Try again" (below)
  // calls loadBranches() directly rather than relying on this effect re-running, since `branches`
  // staying `undefined` across a failed attempt would otherwise never look like a dependency change.
  useEffect(() => {
    if (branchMode !== "existing" || branches !== undefined || branchesLoading) return;
    loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchMode, branches, branchesLoading, projectId]);

  const branchNameLooksSafe = branchMode !== "new" || !branchName || /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName);
  const branchNameMatchesBase = branchMode === "new" && !!branchName.trim() && branchName.trim() === baseBranch.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const input = {
        title: title.trim(),
        description: description.trim(),
        branchMode,
        ...(branchMode === "new"
          ? { baseBranch: baseBranch.trim() || undefined, branchName: branchName.trim() || undefined }
          : { existingBranch }),
      };
      if (isEdit) {
        let updated = await tasksApi.edit(task!.id, input);
        // Dependency edits are their own dedicated add/remove endpoints (see TaskService.addDependency/
        // removeDependency) — never bundled into POST /tasks/:id/edit. Diff against what the dialog
        // opened with and only send the actual changes.
        const toAdd = selectedDependencyIds.filter((id) => !originalDependencyIds.has(id));
        const toRemove = [...originalDependencyIds].filter((id) => !selectedDependencyIds.includes(id));
        if (toAdd.length > 0 || toRemove.length > 0) {
          await Promise.all([
            ...toAdd.map((depId) => tasksApi.addDependency(task!.id, depId)),
            ...toRemove.map((depId) => tasksApi.removeDependency(task!.id, depId)),
          ]);
          updated = await tasksApi.get(task!.id); // re-fetch so the returned TaskDTO carries the final dependency set
        }
        onSaved?.(updated);
      } else {
        const created = await projectsApi.createTask(projectId, {
          ...input,
          ...(selectedDependencyIds.length > 0 ? { dependencyIds: selectedDependencyIds } : {}),
        });
        onCreated?.(created);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${isEdit ? "save" : "create"} this task. Please try again.`);
      setSubmitting(false);
    }
  }

  const canSubmit =
    !!title.trim() &&
    !!description.trim() &&
    branchNameLooksSafe &&
    !branchNameMatchesBase &&
    (branchMode === "new" || (!!existingBranch && (branches?.length ?? 0) > 0));

  return (
    <Dialog title={isEdit ? "Edit task" : "Create task"} onClose={onClose}>
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

        <div className="field">
          <label htmlFor="task-branch-mode">Branch</label>
          <select
            id="task-branch-mode"
            value={branchMode}
            onChange={(e) => {
              setBranchMode(e.target.value as BranchMode);
              setError(undefined);
            }}
          >
            <option value="new">Create a new branch</option>
            <option value="existing">Work directly on an existing branch</option>
          </select>
        </div>

        {branchMode === "new" ? (
          <>
            <div className="field">
              <label htmlFor="task-base-branch">Base branch</label>
              <p className="field-hint">The branch the new isolated task branch is created from. Defaults to this project's default branch.</p>
              <input id="task-base-branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="task-branch-name">New branch name</label>
              <p className="field-hint">Auto-suggested from the title — edit it if you'd like a different name.</p>
              <input
                id="task-branch-name"
                value={branchName}
                onChange={(e) => {
                  setBranchName(e.target.value);
                  setBranchNameEdited(true);
                }}
                maxLength={200}
                aria-invalid={!branchNameLooksSafe}
              />
              {!branchNameLooksSafe && (
                <p className="field-warning" role="alert">
                  <span aria-hidden="true">⚠</span>
                  <span>Branch names may only contain letters, numbers, '.', '_', '-', '/', and can't start with '-'.</span>
                </p>
              )}
              {branchName.trim() && branchName.trim() === baseBranch.trim() && (
                <p className="field-warning" role="alert">
                  <span aria-hidden="true">⚠</span>
                  <span>The new branch name can't be the same as the base branch — choose a different name.</span>
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="task-existing-branch">Existing branch</label>
            <p className="field-hint">
              The agent commits and pushes directly onto this branch — no new branch is created. Only one active task
              may work on a given branch at a time.
            </p>
            {branchesLoading && <LoadingState label="Loading branches from the repository…" />}
            {branchesError && <ErrorState message={branchesError} onRetry={loadBranches} />}
            {!branchesLoading && !branchesError && branches && branches.length === 0 && (
              <p className="field-hint">No branches were found for this repository.</p>
            )}
            {!branchesLoading && !branchesError && branches && branches.length > 0 && (
              <select id="task-existing-branch" value={existingBranch} onChange={(e) => setExistingBranch(e.target.value)} required>
                <option value="" disabled>
                  Select a branch…
                </option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="task-dependencies">Depends on</label>
          <p className="field-hint">
            {dependenciesLocked
              ? "Dependencies can no longer be changed — this task has already left Backlog."
              : "This task can only be started once every task selected here is Done."}
          </p>
          {dependencyCandidates.length === 0 ? (
            <p className="field-hint">No other tasks in this project yet.</p>
          ) : (
            <div id="task-dependencies" className="dependency-picker" role="group" aria-label="Depends on">
              {dependencyCandidates.map((candidate) => (
                <label key={candidate.id} className="dependency-option">
                  <input
                    type="checkbox"
                    checked={selectedDependencyIds.includes(candidate.id)}
                    disabled={dependenciesLocked}
                    onChange={() => toggleDependency(candidate.id)}
                  />
                  <span>{candidate.title}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <ErrorState message={error} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit}>
            {isEdit ? (submitting ? "Saving…" : "Save changes") : submitting ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
