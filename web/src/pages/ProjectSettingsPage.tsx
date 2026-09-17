import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { projectsApi, type ProjectCommands, type ProjectDTO } from "../api/index.js";
import { Dialog } from "../components/common/Dialog.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { formatAbsolute } from "../lib/time.js";

const COMMAND_FIELDS: Array<{ key: keyof ProjectCommands; label: string; placeholder: string }> = [
  { key: "build", label: "Build", placeholder: "npm run build" },
  { key: "typecheck", label: "Typecheck", placeholder: "npm run typecheck" },
  { key: "lint", label: "Lint", placeholder: "npm run lint" },
  { key: "test", label: "Test", placeholder: "npm test" },
];

function commandsEqual(a: ProjectCommands, b: ProjectCommands): boolean {
  return COMMAND_FIELDS.every(({ key }) => (a[key] ?? "") === (b[key] ?? ""));
}

/**
 * Project name/repo/coding-engine/default-branch stay read-only here — there is no backend "update
 * project" endpoint for them, so this deliberately doesn't present itself as an editor for those (no
 * invented capability). Build/test/lint/typecheck commands are the one exception: `PATCH
 * /projects/:projectId/commands` exists specifically because project creation's own `commands` input
 * has no frontend form at all, leaving a connected project with literally no automated validation on
 * any task (an undeclared check is skipped, not failed — see runValidation) unless set here.
 */
export function ProjectSettingsPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const baseline: ProjectCommands = {
    build: project.commands?.build ?? "",
    test: project.commands?.test ?? "",
    lint: project.commands?.lint ?? "",
    typecheck: project.commands?.typecheck ?? "",
  };

  const [savedBaseline, setSavedBaseline] = useState(baseline);
  const [form, setForm] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [savedAtIso, setSavedAtIso] = useState<string>();

  const dirty = !commandsEqual(form, savedBaseline);

  async function handleSave() {
    setSaving(true);
    setError(undefined);
    try {
      const commands: ProjectCommands = {};
      for (const { key } of COMMAND_FIELDS) {
        const value = form[key]?.trim();
        if (value) commands[key] = value;
      }
      await projectsApi.updateCommands(project.id, commands);
      const next: ProjectCommands = {
        build: commands.build ?? "",
        test: commands.test ?? "",
        lint: commands.lint ?? "",
        typecheck: commands.typecheck ?? "",
      };
      setSavedBaseline(next);
      setForm(next);
      setSavedAtIso(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save these commands. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card card-padded stack" style={{ gap: 12 }}>
        <p className="field-hint">Project settings are currently read-only from this screen.</p>
        <dl className="info-callout" style={{ margin: 0 }}>
          <dt>Project name</dt>
          <dd>{project.name}</dd>
          <dt>Repository</dt>
          <dd>{project.repoUrl}</dd>
          <dt>Source control</dt>
          <dd>{project.sourceControlProvider}</dd>
          <dt>Coding engine</dt>
          <dd>{project.codingEngine}</dd>
          <dt>Default branch</dt>
          <dd>{project.defaultBranch}</dd>
          <dt>Created</dt>
          <dd>{formatAbsolute(project.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{formatAbsolute(project.updatedAt)}</dd>
        </dl>
      </div>

      <div className="card card-padded stack" style={{ gap: 12 }}>
        <div>
          <h3>Validation Commands</h3>
          <p className="field-hint">
            These commands actually run, for real, inside this project's workspace during every AI task — this is not guidance
            like Project Context's own validation notes. A build/typecheck failure here drives the AI's self-fix loop. A field
            left blank means that check is skipped entirely for this project, not failed.
          </p>
        </div>

        {COMMAND_FIELDS.map(({ key, label, placeholder }) => (
          <div className="field" key={key} style={{ marginBottom: 0 }}>
            <label htmlFor={`project-command-${key}`}>{label}</label>
            <input
              id={`project-command-${key}`}
              value={form[key] ?? ""}
              placeholder={placeholder}
              onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
            />
          </div>
        ))}

        {error && <ErrorState message={error} onRetry={handleSave} />}

        <div className="dialog-actions" style={{ justifyContent: "space-between" }}>
          <span className="field-hint">
            {dirty ? "Unsaved changes" : savedAtIso ? `Saved ${formatAbsolute(savedAtIso)}` : "No unsaved changes"}
          </span>
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

      <DangerZone project={project} />
    </div>
  );
}

/**
 * Deleting a project is permanent (see ProjectService.delete/ProjectRepository.deleteCascade) —
 * same confirm-before-destructive-action shape as CancelTaskControl, one level more serious. The
 * backend itself blocks the delete (409 `PROJECT_HAS_ACTIVE_TASKS`) while any task is still
 * queued/executing/awaiting review, and its error message already names which ones — surfaced
 * as-is rather than re-derived here, since the frontend has no independent way to know that faster
 * than asking the server.
 */
function DangerZone({ project }: { project: ProjectDTO }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleConfirm() {
    setDeleting(true);
    setError(undefined);
    try {
      await projectsApi.delete(project.id);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this project. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="card card-padded stack" style={{ gap: 12, borderColor: "var(--tone-danger-text)" }}>
      <div>
        <h3>Danger Zone</h3>
        <p className="field-hint">
          Permanently deletes this project and all of its tasks. This cannot be undone. Blocked while any task is still queued,
          executing, or awaiting review — cancel or finish those first.
        </p>
      </div>
      <div>
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
          Delete project
        </button>
      </div>

      {confirming && (
        <Dialog title={`Delete "${project.name}"?`} onClose={() => (deleting ? undefined : setConfirming(false))}>
          <p style={{ marginBottom: 16 }}>
            This permanently deletes <strong>{project.name}</strong> and every one of its tasks — activity history, reports, and
            all. This cannot be undone. The repository on GitHub itself is not affected.
          </p>
          {error && <ErrorState message={error} />}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={deleting}>
              Keep Project
            </button>
            <button type="button" className="btn btn-danger" onClick={handleConfirm} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Permanently"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
