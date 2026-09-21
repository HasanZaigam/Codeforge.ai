import { z } from "zod";

/**
 * Phase 3, Slice 5 — the Project Context Manifest: a small, explicit, persistent, human/AI-readable
 * configuration and context contract for a ProjectWorkspace. Stored as a single JSON file
 * (`PROJECT_CONTEXT_MANIFEST_FILENAME`) inside the ProjectWorkspace's own persistent directory (see
 * ProjectContextService, which is the only thing that reads/writes it, always through
 * ProjectWorkspaceFsManager — never a direct filesystem call).
 *
 * SOURCE OF TRUTH BOUNDARY: this manifest is NOT a second copy of anything the database already
 * owns authoritatively. Project id, ProjectWorkspace id, GitHub owner/repo, source-control provider,
 * and the executable build/test/lint commands used by task execution (`Project.commands` /
 * `ProjectCommands` in domain/types.ts) all remain exclusively DB-authoritative — this manifest
 * never stores or re-derives any of them. `validation.commands` below is deliberately
 * free-text *guidance* ("run the fast test suite before the slow one"), not a parallel, executable
 * command list — it is never read by the Orchestrator/CodingEngine and never runs anything.
 *
 * SECURITY BOUNDARY: this manifest is project-owned, human-authored *data*, never a security
 * policy. Nothing in it can alter authorization, ownership, credentials, filesystem roots, task
 * lifecycle, or orchestrator state transitions — see docs/SECURITY_ARCHITECTURE.md "Project Context
 * Manifest ≠ security policy". Its `revision` field (Phase 3, Slice 7 — see below) is likewise
 * platform-owned concurrency-control metadata, not project-provided content: it is never rendered
 * into an AI prompt (see orchestrator/project-context-section.ts) and never interpreted as an
 * instruction.
 *
 * Kept deliberately small (no dozens of optional fields) — every top-level key is a plain string
 * array except `project` (name + optional description) and `validation` (one string array).
 *
 * VERSION vs. REVISION (Phase 3, Slice 7): two unrelated numbers, deliberately not conflated.
 * `version` is the SCHEMA version — bumped only if the manifest's shape itself changes; it stays
 * `PROJECT_CONTEXT_MANIFEST_VERSION` (1) for this slice. `revision` is the CONTENT revision — an
 * optimistic-concurrency counter that increments by exactly one on every successful
 * `ProjectContextService.replaceManifest` call, so a client can detect (and refuse to silently
 * overwrite) a change that happened since it last read the manifest. See
 * ProjectContextService.replaceManifest's own doc comment for the compare-and-swap mechanism, and
 * ProjectContextConflictError below for the client-facing failure mode.
 */

export const PROJECT_CONTEXT_MANIFEST_FILENAME = ".project-context.json";

/** Bumped only if the manifest shape changes in a future slice — `version` is validated exactly against this, so an unrecognized version is rejected rather than silently misinterpreted. Never confused with `revision` — see this module's top-of-file doc comment. */
export const PROJECT_CONTEXT_MANIFEST_VERSION = 1;

/** The `revision` a brand-new manifest starts at, and the value backward-compatibility treats a pre-Slice-7 manifest (one with no `revision` field on disk at all) as having — see `ProjectContextManifestSchema`'s `revision` field below and this module's VERSION vs. REVISION doc comment. */
export const PROJECT_CONTEXT_MANIFEST_INITIAL_REVISION = 1;

/**
 * Well below the general 5 MiB ProjectWorkspace file limit (`MAX_PROJECT_WORKSPACE_WRITE_BYTES` in
 * project-workspace-fs-manager.ts) — this is small structured project context, not an arbitrary
 * project file. A plain source constant, not an env var: this is a safety guard, not a tunable
 * production knob (same posture as the file-operation size limits it's modeled on).
 */
export const MAX_PROJECT_CONTEXT_MANIFEST_BYTES = 256 * 1024; // 256 KiB

const StringListSchema = z.array(z.string());

/** A positive integer — the same shape for both the `revision` schemas below, just with different `default()`/required-ness. */
const RevisionSchema = z.number().int().positive();

/** Every field except `revision` — shared between the two schemas below so the two can never drift out of sync with each other. */
const manifestContentShape = {
  version: z.literal(PROJECT_CONTEXT_MANIFEST_VERSION),
  project: z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
    })
    .strict(),
  instructions: StringListSchema.default([]),
  architecture: StringListSchema.default([]),
  conventions: StringListSchema.default([]),
  validation: z
    .object({
      /**
       * Free-text guidance strings (e.g. "run `npm test` before opening a PR"), never an
       * executable command list — see this module's top-of-file doc comment on why this is
       * deliberately NOT a duplicate of `Project.commands`.
       */
      commands: StringListSchema.default([]),
    })
    .strict()
    .default({ commands: [] }),
  constraints: StringListSchema.default([]),
};

/**
 * Used to parse a manifest already on disk (`ProjectContextService.readManifest`). `revision`
 * defaults to `PROJECT_CONTEXT_MANIFEST_INITIAL_REVISION` (1) when absent — the deterministic,
 * documented backward-compatibility behavior for a manifest written before Slice 7 shipped (see
 * this module's top-of-file VERSION vs. REVISION doc comment). This never rewrites the file just
 * because it was read; only a subsequent successful `replaceManifest` call ever persists an
 * explicit `revision`. An explicit but invalid `revision` (non-integer, zero, negative) is still
 * rejected — this default only fills in a *missing* field, it never repairs a malformed one.
 *
 * `updatedAt` (Phase 3, Slice 8 follow-up) is the ISO timestamp of the last successful
 * `replaceManifest` call — server-computed only, exactly like `revision` (see that field's own
 * "never itself the literal value persisted" note on `ProjectContextManifestInputSchema` below):
 * a client can never set or influence it, it is not part of the compare-and-swap contract, and it
 * is never rendered into an AI prompt (see orchestrator/project-context-section.ts's own doc
 * comment on why `revision` is excluded there — the same reasoning applies here: platform
 * bookkeeping, not project knowledge). Defaults to `null` when absent (a manifest written before
 * this field existed) rather than fabricating a plausible-looking timestamp for data the platform
 * never actually recorded.
 */
export const ProjectContextManifestSchema = z
  .object({
    ...manifestContentShape,
    revision: RevisionSchema.default(PROJECT_CONTEXT_MANIFEST_INITIAL_REVISION),
    updatedAt: z.string().nullable().default(null),
  })
  .strict();

/**
 * Used to validate an incoming `PUT` request body (`ProjectContextService.replaceManifest`, via
 * `validateProjectContextManifest`). Unlike the schema above, `revision` is REQUIRED here, not
 * defaulted — Slice 7's optimistic-concurrency contract is that the client must explicitly state
 * the revision it believes it is replacing (normally the `revision` it most recently got back from
 * `GET`/a prior `PUT`); a submission that omits it is rejected as invalid input, exactly like a
 * missing `project.name`. See ProjectContextService.replaceManifest for how this value is used as
 * the compare-and-swap's "expected" revision, and is never itself the literal value persisted (the
 * server always computes the actual next revision as `currentOnDisk.revision + 1`).
 *
 * Deliberately has no `updatedAt` field at all — unlike `revision`, the client has no legitimate
 * reason to ever send one (there is no "expected updatedAt" half of any concurrency check), and
 * `.strict()` means a client that tries anyway gets a clear 400, not a silently-ignored field.
 */
export const ProjectContextManifestInputSchema = z.object({ ...manifestContentShape, revision: RevisionSchema }).strict();

export type ProjectContextManifest = z.infer<typeof ProjectContextManifestSchema>;

/**
 * The manifest CONTENT a brand-new (or newly-backfilled) ProjectWorkspace gets — see
 * ProjectContextService.ensureManifest, the only caller that turns this into a persisted
 * `ProjectContextManifest` (by adding `updatedAt` itself at the moment of persistence — see that
 * method). `projectName` is copied in once, at creation time, purely as informational context
 * (never re-synchronized later — see this module's top-of-file doc comment: the database, not this
 * manifest, remains the authoritative project name). Contains no secrets by construction: there is
 * no field anywhere in this schema capable of holding a credential, token, or key.
 *
 * Deliberately excludes `updatedAt` (unlike the full `ProjectContextManifest` type) — this exact
 * shape is also what test helpers spread into a `PUT` request body (`ProjectContextManifestInputSchema`
 * has no `updatedAt` field and rejects one via `.strict()`), so keeping this function's output
 * "client-shaped" content only, with no server-only bookkeeping mixed in, avoids that entirely.
 */
export function defaultProjectContextManifest(projectName: string): Omit<ProjectContextManifest, "updatedAt"> {
  return {
    version: PROJECT_CONTEXT_MANIFEST_VERSION,
    revision: PROJECT_CONTEXT_MANIFEST_INITIAL_REVISION,
    project: { name: projectName },
    instructions: [],
    architecture: [],
    conventions: [],
    validation: { commands: [] },
    constraints: [],
  };
}

/**
 * Validates an already-parsed JSON value (an HTTP `PUT` body) against `ProjectContextManifestInputSchema`
 * — `revision` is REQUIRED here (see that schema's own doc comment), unlike parsing an on-disk
 * manifest. Throws `ProjectContextManifestInvalidError` — safe to expose to a client (never includes
 * a filesystem path or any host detail) — on anything that doesn't match: wrong/missing `version`,
 * missing `revision`, missing required fields, wrong primitive/array/object types, `.strict()` also
 * rejects unknown extra top-level keys, catching typos rather than silently ignoring them.
 */
export type ProjectContextManifestInput = z.infer<typeof ProjectContextManifestInputSchema>;

export function validateProjectContextManifest(value: unknown): ProjectContextManifestInput {
  const result = ProjectContextManifestInputSchema.safeParse(value);
  if (!result.success) {
    throw new ProjectContextManifestInvalidError(summarizeZodIssues(result.error));
  }
  return result.data;
}

/**
 * Parses raw on-disk manifest text — used only for a manifest already on disk
 * (`ProjectContextService.readManifest`), NOT for an incoming `PUT` body (see
 * `validateProjectContextManifest` for that). Validates against `ProjectContextManifestSchema`
 * (`revision` defaulted when absent — see that schema's own doc comment for the Slice 7
 * backward-compatibility behavior this enables), not `ProjectContextManifestInputSchema`. Invalid
 * JSON is reported the same way schema-invalid JSON is (`ProjectContextManifestInvalidError`) — a
 * caller never has to special-case "isn't JSON at all" vs. "is JSON but doesn't match the schema".
 */
export function parseProjectContextManifestText(raw: string): ProjectContextManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectContextManifestInvalidError("manifest content is not valid JSON");
  }
  const result = ProjectContextManifestSchema.safeParse(value);
  if (!result.success) {
    throw new ProjectContextManifestInvalidError(summarizeZodIssues(result.error));
  }
  return result.data;
}

function summarizeZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** Client-caused: invalid content submitted to `replaceManifest`, or invalid JSON/shape found while parsing. Message never includes a filesystem path — always safe to return to an API caller. */
export class ProjectContextManifestInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid project context manifest: ${reason}`);
    this.name = "ProjectContextManifestInvalidError";
  }
}

/** The manifest currently stored on disk fails validation — distinct from `ProjectContextManifestInvalidError` (a client's `PUT` body) because this is a server-side data-integrity condition, never the requesting client's fault; see ProjectContextService.readManifest. */
export class ProjectContextManifestCorruptError extends Error {
  constructor(reason: string) {
    super(`Stored project context manifest is corrupt: ${reason}`);
    this.name = "ProjectContextManifestCorruptError";
  }
}

export class ProjectContextManifestTooLargeError extends Error {
  constructor(actualBytes: number | null, maxBytes: number) {
    super(
      actualBytes === null
        ? `Project context manifest exceeds the ${maxBytes}-byte limit.`
        : `Project context manifest is ${actualBytes} bytes, exceeding the ${maxBytes}-byte limit.`,
    );
    this.name = "ProjectContextManifestTooLargeError";
  }
}

/**
 * Phase 3, Slice 7 — thrown by `ProjectContextService.replaceManifest` when the caller's submitted
 * `revision` no longer matches the manifest's actual current revision on disk: the content changed
 * (via some other successful `replaceManifest` call) since the caller last read it. The update is
 * refused outright — never partially applied, never silently merged — so the caller can never
 * clobber a newer version without realizing it. `currentRevision` lets a client re-fetch
 * (`GET /projects/:projectId/context`) and retry with the now-current value. Mapped to `409
 * Conflict` — see error-middleware.ts.
 */
export class ProjectContextConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Project context has changed since it was last read (current revision ${currentRevision}). Re-fetch the latest context and try again.`);
    this.name = "ProjectContextConflictError";
    this.currentRevision = currentRevision;
  }
}
