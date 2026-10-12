import { useEffect, useState, type FormEvent } from "react";
import { Dialog, DialogActions } from "../common/Dialog.js";
import { TriangleAlertIcon } from "lucide-react";
import { ErrorState } from "../common/ErrorState.js";
import { LoadingState } from "../common/LoadingState.js";
import { Link } from "react-router-dom";
import { projectsApi, tasksApi, type TaskDTO, type BranchMode, type ProjectRepoDTO } from "../../api/index.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

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
  repositories,
  task,
  allTasks,
  onClose,
  onCreated,
  onSaved,
}: {
  projectId: string;
  /** The project's own default branch — pre-fills the "new branch" base-branch field when no repository list is given. */
  defaultBranch: string;
  /**
   * The project's repositories. A task works in exactly one: with a single repository it's chosen
   * automatically; with several the user must pick (never guessed); with none, nothing can be created
   * yet. Omitted only by callers that predate multi-repository projects — then no repository is sent.
   */
  repositories?: ProjectRepoDTO[];
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

  const repoOptions = repositories ?? [];
  const [repositoryId, setRepositoryId] = useState<string>(
    task?.repositoryId ?? (repoOptions.length === 1 ? repoOptions[0]!.id : ""),
  );
  const selectedRepo = repoOptions.find((r) => r.id === repositoryId);
  const needsRepositoryChoice = repositories !== undefined && !selectedRepo;

  const [branchMode, setBranchMode] = useState<BranchMode>(task?.branchMode ?? "new");
  const [baseBranch, setBaseBranch] = useState(task?.baseBranch ?? selectedRepo?.defaultBranch ?? defaultBranch);
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

  // Branches, default branch and the existing-branch choice all belong to ONE repository — switching
  // repository resets them to that repository's own.
  function handleRepositoryChange(nextId: string) {
    setRepositoryId(nextId);
    const repo = repoOptions.find((r) => r.id === nextId);
    if (repo) setBaseBranch(repo.defaultBranch);
    setBranches(undefined);
    setBranchesError(undefined);
    setExistingBranch("");
    setError(undefined);
  }

  function loadBranches() {
    setBranchesLoading(true);
    setBranchesError(undefined);
    projectsApi
      .listBranches(projectId, selectedRepo?.id)
      .then((list) => setBranches(list))
      .catch((err) => setBranchesError(err instanceof Error ? err.message : "Could not load branches. Please try again."))
      .finally(() => setBranchesLoading(false));
  }

  // Fetch the real remote branch list the first time "existing branch" mode is selected — not
  // eagerly on dialog open, since most tasks never need it. A failed load's "Try again" (below)
  // calls loadBranches() directly rather than relying on this effect re-running, since `branches`
  // staying `undefined` across a failed attempt would otherwise never look like a dependency change.
  useEffect(() => {
    if (branchMode !== "existing" || branches !== undefined || branchesLoading || needsRepositoryChoice) return;
    loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchMode, branches, branchesLoading, projectId, repositoryId]);

  const branchNameLooksSafe = branchMode !== "new" || !branchName || /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName);
  const branchNameMatchesBase = branchMode === "new" && !!branchName.trim() && branchName.trim() === baseBranch.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const input = {
        ...(selectedRepo ? { repositoryId: selectedRepo.id } : {}),
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
    !needsRepositoryChoice &&
    !!title.trim() &&
    !!description.trim() &&
    branchNameLooksSafe &&
    !branchNameMatchesBase &&
    (branchMode === "new" || (!!existingBranch && (branches?.length ?? 0) > 0));

  return (
    <Dialog title={isEdit ? "Edit task" : "Create task"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="task-title">Title</Label>
          <Input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Fix OTP timeout login"
            required
            maxLength={300}
          />
        </div>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="task-description">Description</Label>
          <Textarea
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Client reports that OTP login fails after session timeout."
            required
            rows={5}
            maxLength={10000}
          />
          <p className="text-sm text-muted-foreground">Describe the problem in plain language — no need to write instructions for the AI.</p>
        </div>

        {repositories !== undefined && repoOptions.length === 0 && (
          <div className="mb-4 rounded-2xl bg-tone-attention/10 px-4 py-3 text-sm text-tone-attention" role="alert">
            This project has no repository connected yet.{" "}
            <Link className="font-medium underline underline-offset-4" to={`/projects/${projectId}/settings`}>
              Connect one in Settings
            </Link>{" "}
            before creating tasks.
          </div>
        )}
        {repoOptions.length > 1 && (
          <div className="mb-4 flex flex-col gap-2">
            <Label htmlFor="task-repository">Repository</Label>
            <p className="text-sm text-muted-foreground">Which codebase this task changes. A task works in exactly one repository.</p>
            <NativeSelect className="w-full" id="task-repository" value={repositoryId} onChange={(e) => handleRepositoryChange(e.target.value)} required>
              <option value="" disabled>
                Select a repository…
              </option>
              {repoOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}

        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="task-branch-mode">Branch</Label>
          <NativeSelect className="w-full"
            id="task-branch-mode"
            value={branchMode}
            onChange={(e) => {
              setBranchMode(e.target.value as BranchMode);
              setError(undefined);
            }}
          >
            <option value="new">Create a new branch</option>
            <option value="existing">Work directly on an existing branch</option>
          </NativeSelect>
        </div>

        {branchMode === "new" ? (
          <>
            <div className="mb-4 flex flex-col gap-2">
              <Label htmlFor="task-base-branch">Base branch</Label>
              <p className="text-sm text-muted-foreground">
                The branch the new isolated task branch is created from. Defaults to {selectedRepo ? `${selectedRepo.name}'s` : "this project's"} default branch.
              </p>
              <Input id="task-base-branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} maxLength={200} />
            </div>
            <div className="mb-4 flex flex-col gap-2">
              <Label htmlFor="task-branch-name">New branch name</Label>
              <p className="text-sm text-muted-foreground">Auto-suggested from the title — edit it if you'd like a different name.</p>
              <Input
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
                <p className="flex items-start gap-2 rounded-xl bg-tone-attention/12 px-3 py-2 text-sm text-tone-attention" role="alert">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>Branch names may only contain letters, numbers, '.', '_', '-', '/', and can't start with '-'.</span>
                </p>
              )}
              {branchName.trim() && branchName.trim() === baseBranch.trim() && (
                <p className="flex items-start gap-2 rounded-xl bg-tone-attention/12 px-3 py-2 text-sm text-tone-attention" role="alert">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>The new branch name can't be the same as the base branch — choose a different name.</span>
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="mb-4 flex flex-col gap-2">
            <Label htmlFor="task-existing-branch">Existing branch</Label>
            <p className="text-sm text-muted-foreground">
              The agent commits and pushes directly onto this branch — no new branch is created. Only one active task
              may work on a given branch at a time.
            </p>
            {needsRepositoryChoice && repoOptions.length > 0 && (
              <p className="text-sm text-muted-foreground">Choose a repository above to see its branches.</p>
            )}
            {branchesLoading && <LoadingState label="Loading branches from the repository…" />}
            {branchesError && <ErrorState message={branchesError} onRetry={loadBranches} />}
            {!branchesLoading && !branchesError && branches && branches.length === 0 && (
              <p className="text-sm text-muted-foreground">No branches were found for this repository.</p>
            )}
            {!branchesLoading && !branchesError && branches && branches.length > 0 && (
              <NativeSelect className="w-full" id="task-existing-branch" value={existingBranch} onChange={(e) => setExistingBranch(e.target.value)} required>
                <option value="" disabled>
                  Select a branch…
                </option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
        )}

        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="task-dependencies">Depends on</Label>
          <p className="text-sm text-muted-foreground">
            {dependenciesLocked
              ? "Dependencies can no longer be changed — this task has already left Backlog."
              : "This task can only be started once every task selected here is Done."}
          </p>
          {dependencyCandidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other tasks in this project yet.</p>
          ) : (
            <div
              id="task-dependencies"
              className="max-h-44 divide-y overflow-y-auto rounded-2xl border"
              role="group"
              aria-label="Depends on"
            >
              {dependencyCandidates.map((candidate) => (
                <label
                  key={candidate.id}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50 has-disabled:cursor-not-allowed has-disabled:opacity-60"
                >
                  <input
                    className="size-4 accent-primary"
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
        <DialogActions>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !canSubmit}>
            {isEdit ? (submitting ? "Saving…" : "Save changes") : submitting ? "Creating…" : "Create task"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
