import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { useProjectContext } from "../../hooks/useProjectContext.js";
import { projectsApi, ApiError, type ProjectContextDTO } from "../../api/index.js";
import { ListEditor } from "../common/ListEditor.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";
import { buildAiContextPreview } from "../../lib/projectContextPreview.js";
import { formatAbsolute } from "../../lib/time.js";
import { CONTEXT_UPLOAD_ACCEPT, extractTextFromFile } from "../../lib/fileTextExtractor.js";
import { textToListItems } from "../../lib/textToListItems.js";
import { Button, buttonVariants } from "@/components/ui/button";
import { TriangleAlertIcon, UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
      // Deliberately typed without `updatedAt` — it's server-computed only (see api/types.ts), the
      // same "client never sends it" contract `revision` used to be the only example of.
      const input: Omit<ProjectContextDTO, "updatedAt"> = {
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
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Project Context</h3>
        <p className="text-sm text-muted-foreground">Persistent project-level guidance used by CodeForge AI tasks.</p>
      </div>

      {conflict && (
        <div className="flex flex-col gap-3 rounded-2xl border border-tone-attention/30 bg-tone-attention/10 p-4 text-sm sm:flex-row sm:items-center" role="alert">
          <div className="flex-1 text-muted-foreground">
            <strong className="text-tone-attention">Project Context Changed</strong>
            <p>
              This project context was updated elsewhere after you loaded it
              {conflict.currentRevision !== null ? ` (now at revision ${conflict.currentRevision})` : ""}. Your changes
              have not been overwritten.
            </p>
          </div>
          <Button variant="outline" type="button" onClick={handleReloadLatest}>
            Reload Latest
          </Button>
        </div>
      )}

      {locked && (
        <div className="flex flex-col gap-3 rounded-2xl border border-tone-attention/30 bg-tone-attention/10 p-4 text-sm sm:flex-row sm:items-center" role="alert">
          <div className="flex-1 text-muted-foreground">
            <strong className="text-tone-attention">Project Context is currently being updated</strong>
            <p>Please try again.</p>
          </div>
          <Button variant="outline" type="button" onClick={handleSave}>
            Retry
          </Button>
        </div>
      )}

      {saveError && <ErrorState message={saveError} onRetry={handleSave} />}

      <div className="context-section space-y-4 rounded-3xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
        <div className="flex flex-col gap-2">
          <Label htmlFor="context-project-name">Project name</Label>
          <Input id="context-project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="context-project-description">Description</Label>
          <Textarea id="context-project-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>
      </div>

      <ContextSection
        id="context-instructions"
        title="Instructions"
        description="High-level instructions for the AI developer."
        onUpload={(items) => setInstructions((prev) => [...prev, ...items])}
      >
        <ListEditor
          id="context-instructions"
          label="Instructions"
          hideLabel
          items={instructions}
          onChange={setInstructions}
          addLabel="+ Add instruction"
          emptyHint="No instructions yet."
        />
      </ContextSection>

      <ContextSection
        id="context-architecture"
        title="Architecture"
        description="Technical architecture and design decisions."
        onUpload={(items) => setArchitecture((prev) => [...prev, ...items])}
      >
        <ListEditor
          id="context-architecture"
          label="Architecture"
          hideLabel
          items={architecture}
          onChange={setArchitecture}
          addLabel="+ Add architecture note"
          emptyHint="No architecture notes yet."
        />
      </ContextSection>

      <ContextSection
        id="context-conventions"
        title="Conventions"
        description="Coding conventions, naming patterns, and standards."
        onUpload={(items) => setConventions((prev) => [...prev, ...items])}
      >
        <ListEditor
          id="context-conventions"
          label="Conventions"
          hideLabel
          items={conventions}
          onChange={setConventions}
          addLabel="+ Add convention"
          emptyHint="No conventions yet."
        />
      </ContextSection>

      <ContextSection
        id="context-validation-commands"
        title="Validation Guidance"
        description="Guidance for validation and testing (for AI guidance only, not authoritative)."
        onUpload={(items) => setValidationCommands((prev) => [...prev, ...items])}
      >
        <ListEditor
          id="context-validation-commands"
          label="Validation Guidance"
          hideLabel
          items={validationCommands}
          onChange={setValidationCommands}
          addLabel="+ Add validation guidance"
          emptyHint="No validation guidance yet."
        />
        <p className="text-sm text-muted-foreground">
          These commands provide project guidance to the AI. CodeForge's configured project validation commands remain
          authoritative.
        </p>
      </ContextSection>

      <ContextSection
        id="context-constraints"
        title="Constraints"
        description="Important constraints and limitations."
        onUpload={(items) => setConstraints((prev) => [...prev, ...items])}
      >
        <ListEditor
          id="context-constraints"
          label="Constraints"
          hideLabel
          items={constraints}
          onChange={setConstraints}
          addLabel="+ Add constraint"
          emptyHint="No constraints yet."
        />
      </ContextSection>

      <div className="context-section sticky bottom-4 z-10 flex flex-col gap-3 rounded-3xl bg-card/95 p-4 shadow-lg ring-1 ring-foreground/10 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted-foreground">
          <p>
            <span className={dirty ? "font-medium text-tone-attention" : undefined}>{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
          </p>
          <p className="text-xs">
            <span>Revision: {baseline.revision}</span>
            {baseline.updatedAt && <span> · Last updated {formatAbsolute(baseline.updatedAt)}</span>}
          </p>
        </div>
        <Button type="button" disabled={!dirty || saving || !name.trim()} onClick={handleSave}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <div className="context-section space-y-3 rounded-3xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h4 className="font-semibold">AI Context Preview</h4>
            <p className="text-sm text-muted-foreground">
              See how this context will be provided to the AI developer. This is bounded project-level guidance — it does not
              override system, security, validation, or orchestration rules.
            </p>
          </div>
          <Button variant="outline" type="button" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? "Hide Preview" : "View Preview"}
          </Button>
        </div>
        {showPreview && (
          <pre className="max-h-96 overflow-auto rounded-2xl bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {buildAiContextPreview(baseline)}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * One visual card per manifest field: a heading + one-line description + an "Upload MD/PDF" action,
 * with the field's own list editor below. The upload itself is entirely client-side (see
 * lib/fileTextExtractor.ts) — a .md/.markdown file is just read as text, a .pdf is parsed in-browser
 * with pdf.js; nothing is sent to any backend endpoint. Extracted lines are only ever *appended* to
 * this field's in-memory list, exactly as if the user had clicked "+ Add ..." and typed each line
 * themselves — the user can still edit/remove any of them, and nothing is persisted until they
 * explicitly click "Save Changes" (the existing revision-aware PUT, completely unchanged).
 */
function ContextSection({
  id,
  title,
  description,
  onUpload,
  children,
}: {
  id: string;
  title: string;
  description: string;
  onUpload: (items: string[]) => void;
  children: ReactNode;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const inputId = `${id}-upload`;

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be re-selected later (e.g. after fixing its content)
    if (!file) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const text = await extractTextFromFile(file);
      const items = textToListItems(text);
      if (items.length === 0) {
        setUploadError(`Couldn't find any usable text lines in "${file.name}".`);
        return;
      }
      onUpload(items);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : `Could not read "${file.name}".`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="context-section space-y-4 rounded-3xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h4 className="font-semibold">{title}</h4>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Label
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-pointer has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/50")}
          htmlFor={inputId}
        >
          <UploadIcon data-icon="inline-start" />
          {uploading ? "Reading…" : "Upload MD/PDF"}
          <input
            id={inputId}
            className="sr-only"
            type="file"
            accept={CONTEXT_UPLOAD_ACCEPT}
            disabled={uploading}
            onChange={handleFileChange}
          />
        </Label>
      </div>
      {uploadError && (
        <p className="flex items-start gap-2 rounded-xl bg-tone-attention/12 px-3 py-2 text-sm text-tone-attention" role="alert">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{uploadError}</span>
        </p>
      )}
      {children}
    </div>
  );
}
