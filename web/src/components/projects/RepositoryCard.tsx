import { useState, type FormEvent } from "react";
import { ExternalLinkIcon, GitBranchIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { projectsApi, type ProjectCommands, type ProjectRepoDTO } from "../../api/index.js";
import { Dialog, DialogActions } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { ToneBadge } from "../common/ToneBadge.js";
import { formatAbsolute } from "../../lib/time.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const COMMAND_FIELDS: Array<{ key: keyof ProjectCommands; label: string; placeholder: string }> = [
  { key: "build", label: "Build", placeholder: "npm run build" },
  { key: "typecheck", label: "Typecheck", placeholder: "npm run typecheck" },
  { key: "lint", label: "Lint", placeholder: "npm run lint" },
  { key: "test", label: "Test", placeholder: "npm test" },
];

function toForm(commands: ProjectCommands | null): ProjectCommands {
  return {
    build: commands?.build ?? "",
    test: commands?.test ?? "",
    lint: commands?.lint ?? "",
    typecheck: commands?.typecheck ?? "",
  };
}

function commandsEqual(a: ProjectCommands, b: ProjectCommands): boolean {
  return COMMAND_FIELDS.every(({ key }) => (a[key] ?? "") === (b[key] ?? ""));
}

/**
 * One repository of a project: its identity, its own default branch, and its own validation commands
 * — those run inside THIS repository during every task that targets it (a failure drives the AI's
 * self-fix loop; a blank field skips that check, never fails it).
 */
export function RepositoryCard({
  projectId,
  repository,
  onChanged,
  onRemoved,
}: {
  projectId: string;
  repository: ProjectRepoDTO;
  onChanged: (repository: ProjectRepoDTO) => void;
  onRemoved: () => void;
}) {
  const [savedBaseline, setSavedBaseline] = useState(toForm(repository.commands));
  const [form, setForm] = useState(toForm(repository.commands));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [savedAtIso, setSavedAtIso] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const dirty = !commandsEqual(form, savedBaseline);
  const idPrefix = `repo-${repository.id}`;

  async function handleSave() {
    setSaving(true);
    setError(undefined);
    try {
      const commands: ProjectCommands = {};
      for (const { key } of COMMAND_FIELDS) {
        const value = form[key]?.trim();
        if (value) commands[key] = value;
      }
      const updated = await projectsApi.updateRepositoryCommands(projectId, repository.id, commands);
      const next = toForm(commands);
      setSavedBaseline(next);
      setForm(next);
      setSavedAtIso(new Date().toISOString());
      onChanged(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save these commands. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-3xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10" aria-label={`Repository ${repository.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{repository.name}</h3>
            <ToneBadge tone="neutral">{repository.sourceControlProvider}</ToneBadge>
          </div>
          <a
            className="inline-flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            href={repository.repoUrl}
            target="_blank"
            rel="noreferrer"
          >
            <span className="truncate font-mono text-xs">{repository.repoUrl}</span>
            <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
          </a>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <GitBranchIcon className="size-3.5" aria-hidden="true" />
            Default branch <code>{repository.defaultBranch}</code>
          </p>
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoving(true)}>
            <Trash2Icon data-icon="inline-start" />
            Remove
          </Button>
        </div>
      </div>

      <div className="mt-5 border-t pt-4">
        <h4 className="text-sm font-medium">Validation commands</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Run for real inside this repository during every task that targets it. A blank field skips that check.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {COMMAND_FIELDS.map(({ key, label, placeholder }) => (
            <div className="flex flex-col gap-2" key={key}>
              <Label htmlFor={`${idPrefix}-command-${key}`}>{label}</Label>
              <Input
                id={`${idPrefix}-command-${key}`}
                className="font-mono"
                value={form[key] ?? ""}
                placeholder={placeholder}
                onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        {error && (
          <div className="mt-4">
            <ErrorState message={error} onRetry={handleSave} />
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {dirty ? "Unsaved changes" : savedAtIso ? `Saved ${formatAbsolute(savedAtIso)}` : "No unsaved changes"}
          </span>
          <Button type="button" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>

      {editing && (
        <EditRepositoryDialog
          projectId={projectId}
          repository={repository}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            onChanged(updated);
          }}
        />
      )}
      {removing && (
        <RemoveRepositoryDialog
          projectId={projectId}
          repository={repository}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            onRemoved();
          }}
        />
      )}
    </article>
  );
}

function EditRepositoryDialog({
  projectId,
  repository,
  onClose,
  onSaved,
}: {
  projectId: string;
  repository: ProjectRepoDTO;
  onClose: () => void;
  onSaved: (repository: ProjectRepoDTO) => void;
}) {
  const [name, setName] = useState(repository.name);
  const [defaultBranch, setDefaultBranch] = useState(repository.defaultBranch);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await projectsApi.updateRepository(projectId, repository.id, { name: name.trim(), defaultBranch: defaultBranch.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this repository.");
      setSaving(false);
    }
  }

  const unchanged = name.trim() === repository.name && defaultBranch.trim() === repository.defaultBranch;

  return (
    <Dialog title={`Edit ${repository.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-repo-name">Repository name</Label>
          <Input id="edit-repo-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          <p className="text-sm text-muted-foreground">The short label tasks and Chat use for this repository.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-repo-branch">Default branch</Label>
          <Input id="edit-repo-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} required maxLength={200} />
          <p className="text-sm text-muted-foreground">
            New task branches start here. {repository.sourceControlProvider === "github" ? "Checked against GitHub before saving." : ""}
          </p>
        </div>
        {error && <ErrorState message={error} />}
        <DialogActions>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || unchanged || !name.trim() || !defaultBranch.trim()}>
            {saving ? "Saving…" : "Save repository"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function RemoveRepositoryDialog({
  projectId,
  repository,
  onClose,
  onRemoved,
}: {
  projectId: string;
  repository: ProjectRepoDTO;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();

  async function handleConfirm() {
    setRemoving(true);
    setError(undefined);
    try {
      await projectsApi.removeRepository(projectId, repository.id);
      onRemoved();
    } catch (err) {
      // The server refuses while any task or backlog item targets this repository and says how many.
      setError(err instanceof Error ? err.message : "Could not remove this repository.");
      setRemoving(false);
    }
  }

  return (
    <Dialog title={`Remove "${repository.name}"?`} onClose={() => (removing ? undefined : onClose())}>
      <p className="text-sm text-muted-foreground">
        This disconnects the repository from the project. Nothing on GitHub or in the repository itself is changed. It can't be
        removed while any task or backlog item still targets it.
      </p>
      {error && <ErrorState message={error} />}
      <DialogActions>
        <Button type="button" variant="outline" onClick={onClose} disabled={removing}>
          Keep repository
        </Button>
        <Button type="button" variant="destructive" onClick={handleConfirm} disabled={removing}>
          {removing ? "Removing…" : "Remove repository"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
