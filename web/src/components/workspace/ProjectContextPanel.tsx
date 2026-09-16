import { useEffect, useState } from "react";
import { useProjectContext } from "../../hooks/useProjectContext.js";
import { projectsApi, ApiError, type ProjectContextDTO } from "../../api/index.js";
import { ListEditor } from "../common/ListEditor.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";
import { buildAiContextPreview } from "../../lib/projectContextPreview.js";
import { formatAbsolute } from "../../lib/time.js";

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Phase 3 "Project Context" (Slice 8) — a genuinely useful view/edit surface for the persistent,
 * project-level guidance manifest (see /docs/CONTEXT_ARCHITECTURE.md and
 * src/project-workspace/project-context-manifest.ts), rendered inside the Project Board's
 * Workspace section. This is a product UX slice over infrastructure that already exists — it adds
 * no new AI behavior; the manifest edited here is the exact same one Slice 6 already injects into
 * Implementer/Reviewer prompts as bounded, non-authoritative guidance.
 *
 * Deliberately isolated from task-board state: its own fetch (useProjectContext), its own local
 * edit buffer (`baseline` vs. the individual field states below) — a task-board poll/refresh can
 * never reset an in-progress edit here, the same isolation useProjectWorkspace already has.
 *
 * Revision-aware save (Slice 7's optimistic concurrency): `baseline.revision` is always the
 * revision this editor most recently loaded/saved, and every PUT echoes it back. A stale save
 * (409 PROJECT_CONTEXT_CONFLICT) never silently overwrites what's now on the server — the user's
 * edits stay in the form until they explicitly click "Reload Latest" (which discards them) or give
 * up and navigate away. A save failure for any other reason (network, 409 PROJECT_CONTEXT_LOCKED,
 * validation) likewise never resets the form — only a successful save ever replaces `baseline`.
 */
export function ProjectContextPanel({ projectId }: { projectId: string }) {
  const { context, error, loading, reload } = useProjectContext(projectId);

  const [baseline, setBaseline] = useState<ProjectContextDTO>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState<string[]>([]);
  const [architecture, setArchitecture] = useState<string[]>([]);
  const [conventions, setConventions] = useState<string[]>([]);
  const [validationCommands, setValidationCommands] = useState<string[]>([]);
  const [constraints, setConstraints] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState<{ currentRevision: number | null }>();
  const [locked, setLocked] = useState(false);
  const [savedAtIso, setSavedAtIso] = useState<string>();
  const [showPreview, setShowPreview] = useState(false);

  function applyToForm(ctx: ProjectContextDTO) {
    setBaseline(ctx);
    setName(ctx.project.name);
    setDescription(ctx.project.description ?? "");
    setInstructions(ctx.instructions);
    setArchitecture(ctx.architecture);
    setConventions(ctx.conventions);
    setValidationCommands(ctx.validation.commands);
    setConstraints(ctx.constraints);
  }

  // Fires only for the first successful load — the moment the editor gets something to show. Every
  // later replacement of `baseline` (a successful save, an explicit "Reload Latest") goes through
  // applyToForm directly, never through this effect, so nothing here can clobber an in-progress edit.
  useEffect(() => {
    if (context && !baseline) applyToForm(context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  const dirty =
    !!baseline &&
    (name !== baseline.project.name ||
      description !== (baseline.project.description ?? "") ||
      !arraysEqual(instructions, baseline.instructions) ||
      !arraysEqual(architecture, baseline.architecture) ||
      !arraysEqual(conventions, baseline.conventions) ||
      !arraysEqual(validationCommands, baseline.validation.commands) ||
      !arraysEqual(constraints, baseline.constraints));

  async function handleSave() {
    if (!baseline) return;
    setSaving(true);
    setSaveError(undefined);
    setConflict(undefined);
    setLocked(false);
    try {
      const input: ProjectContextDTO = {
        version: baseline.version,
        revision: baseline.revision,
        project: description.trim() ? { name: name.trim(), description: description.trim() } : { name: name.trim() },
        instructions,
        architecture,
        conventions,
        validation: { commands: validationCommands },
        constraints,
      };
      const updated = await projectsApi.updateContext(projectId, input);
      applyToForm(updated);
      setSavedAtIso(new Date().toISOString());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "PROJECT_CONTEXT_CONFLICT") {
        const details = err.details as { currentRevision?: number } | undefined;
        setConflict({ currentRevision: details?.currentRevision ?? null });
      } else if (err instanceof ApiError && err.status === 409 && err.code === "PROJECT_CONTEXT_LOCKED") {
        setLocked(true);
      } else {
        setSaveError(err instanceof Error ? err.message : "Could not save project context. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  function handleReloadLatest() {
    reload()
      .then((latest) => {
        applyToForm(latest);
        setConflict(undefined);
        setLocked(false);
        setSaveError(undefined);
      })
      .catch(() => {
        // useProjectContext's own `error` state already surfaces a reload failure below.
      });
  }

  if (loading && !baseline) return <LoadingState label="Loading project context…" />;
  if (error && !baseline) {
    return <ErrorState message="Unable to load project context." onRetry={() => void reload().catch(() => {})} />;
  }
  if (!baseline) return null;

  return (
    <div className="card card-padded stack project-context-panel" style={{ gap: 16 }}>
      <div>
        <h3>Project Context</h3>
        <p className="field-hint">Persistent project-level guidance used by CodeForge AI tasks.</p>
      </div>

      {conflict && (
        <div className="field-warning" role="alert">
          <div>
            <strong>Project Context Changed</strong>
            <p>
              This project context was updated elsewhere after you loaded it
              {conflict.currentRevision !== null ? ` (now at revision ${conflict.currentRevision})` : ""}. Your changes
              have not been overwritten.
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={handleReloadLatest}>
            Reload Latest
          </button>
        </div>
      )}

      {locked && (
        <div className="field-warning" role="alert">
          <div>
            <strong>Project Context is currently being updated</strong>
            <p>Please try again.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={handleSave}>
            Retry
          </button>
        </div>
      )}

      {saveError && <ErrorState message={saveError} onRetry={handleSave} />}

      <div className="field">
        <label htmlFor="context-project-name">Project name</label>
        <input id="context-project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
      </div>
      <div className="field">
        <label htmlFor="context-project-description">Description</label>
        <textarea id="context-project-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </div>

      <ListEditor
        id="context-instructions"
        label="Instructions"
        items={instructions}
        onChange={setInstructions}
        addLabel="+ Add instruction"
        emptyHint="No instructions yet."
      />
      <ListEditor
        id="context-architecture"
        label="Architecture"
        items={architecture}
        onChange={setArchitecture}
        addLabel="+ Add architecture note"
        emptyHint="No architecture notes yet."
      />
      <ListEditor
        id="context-conventions"
        label="Conventions"
        items={conventions}
        onChange={setConventions}
        addLabel="+ Add convention"
        emptyHint="No conventions yet."
      />
      <div>
        <ListEditor
          id="context-validation-commands"
          label="Validation Guidance"
          items={validationCommands}
          onChange={setValidationCommands}
          addLabel="+ Add validation guidance"
          emptyHint="No validation guidance yet."
        />
        <p className="field-hint">
          These commands provide project guidance to the AI. CodeForge's configured project validation commands remain
          authoritative.
        </p>
      </div>
      <ListEditor
        id="context-constraints"
        label="Constraints"
        items={constraints}
        onChange={setConstraints}
        addLabel="+ Add constraint"
        emptyHint="No constraints yet."
      />

      <div className="stack" style={{ gap: 2 }}>
        <p className="text-muted">Revision: {baseline.revision}</p>
        {savedAtIso && <p className="text-muted">Saved {formatAbsolute(savedAtIso)}</p>}
      </div>

      <div className="dialog-actions" style={{ justifyContent: "space-between" }}>
        <span className="field-hint">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving || !name.trim()} onClick={handleSave}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>

      <div className="ai-context-preview">
        <h4>AI Context Preview</h4>
        <p className="field-hint">
          This project context is provided to CodeForge's AI developer as bounded project-level guidance. It does not
          override system, security, validation, or orchestration rules.
        </p>
        <button type="button" className="btn btn-secondary" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? "Hide Preview" : "View Preview"}
        </button>
        {showPreview && <pre className="ai-context-preview-text">{buildAiContextPreview(baseline)}</pre>}
      </div>
    </div>
  );
}
