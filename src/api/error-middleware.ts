import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import {
  BranchInUseError,
  CircularDependencyError,
  CrossProjectDependencyError,
  DuplicateDependencyError,
  EmailAlreadyRegisteredError,
  InvalidBranchSelectionError,
  InvalidCredentialsError,
  InvalidGitHubTokenError,
  InvalidOperationError,
  InvalidRepositoryError,
  InvalidRequestError,
  LocalGitProjectsDisabledError,
  NotFoundError,
  ProjectHasActiveTasksError,
  SelfDependencyError,
  TaskNotEditableError,
} from "../application/errors.js";
import { InvalidTransitionError } from "../domain/task-state-machine.js";
import { IncompleteDependenciesError } from "../domain/errors.js";
import { NotFoundError as OrchestratorNotFoundError } from "../orchestrator/orchestrator.js";
import { GitHubNotConnectedError } from "../integrations/github/credential-resolver.js";
import { GitHubApiError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from "../integrations/github/github-client.js";
import { ProjectContextManifestInvalidError, ProjectContextManifestTooLargeError, ProjectContextConflictError } from "../project-workspace/project-context-manifest.js";
import { ProjectWorkspaceLockTimeoutError } from "../project-workspace/project-workspace-fs-manager.js";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Single place error -> HTTP status mapping happens (see /docs/API.md
 * "Error format"). Never forwards a raw stack trace, filesystem path, or
 * internal exception message for unrecognized errors — those are logged
 * server-side and returned as a generic 500.
 */
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    respond(res, 400, "INVALID_REQUEST", "Request body failed validation", err.flatten());
    return;
  }
  if (err instanceof InvalidRequestError) {
    respond(res, 400, "INVALID_REQUEST", err.message, err.details);
    return;
  }
  if (err instanceof NotFoundError || err instanceof OrchestratorNotFoundError) {
    respond(res, 404, "NOT_FOUND", err.message);
    return;
  }
  if (err instanceof InvalidOperationError) {
    respond(res, 409, "INVALID_OPERATION", err.message);
    return;
  }
  if (err instanceof InvalidTransitionError) {
    respond(res, 409, "INVALID_STATE_TRANSITION", err.message);
    return;
  }
  if (err instanceof InvalidCredentialsError) {
    respond(res, 401, "INVALID_CREDENTIALS", err.message);
    return;
  }
  if (err instanceof EmailAlreadyRegisteredError) {
    respond(res, 409, "EMAIL_ALREADY_REGISTERED", err.message);
    return;
  }
  if (err instanceof InvalidGitHubTokenError) {
    respond(res, 400, "INVALID_GITHUB_TOKEN", err.message);
    return;
  }
  if (err instanceof InvalidRepositoryError) {
    respond(res, 400, "INVALID_REPOSITORY", err.message);
    return;
  }
  if (err instanceof LocalGitProjectsDisabledError) {
    respond(res, 403, "LOCAL_GIT_PROJECTS_DISABLED", err.message);
    return;
  }
  if (err instanceof ProjectHasActiveTasksError) {
    respond(res, 409, "PROJECT_HAS_ACTIVE_TASKS", err.message);
    return;
  }
  // Client-caused (an invalid PUT body) — never the stored-manifest-is-corrupt case
  // (ProjectContextManifestCorruptError, deliberately unmapped here — like
  // ProjectWorkspaceMissingError, a server-side data-integrity condition, not a client mistake, so
  // it falls through to the generic 500 below). See project-context-manifest.ts.
  if (err instanceof ProjectContextManifestInvalidError || err instanceof ProjectContextManifestTooLargeError) {
    respond(res, 400, "INVALID_PROJECT_CONTEXT", err.message);
    return;
  }
  // Phase 3, Slice 7 — optimistic concurrency: the caller's submitted `revision` no longer matches
  // the manifest's actual current revision. A normal, expected outcome of concurrent editing, never
  // a server error — 409, not 500. `currentRevision` lets the client re-fetch and retry safely; see
  // project-context-manifest.ts ProjectContextConflictError's own doc comment.
  if (err instanceof ProjectContextConflictError) {
    respond(res, 409, "PROJECT_CONTEXT_CONFLICT", err.message, { currentRevision: err.currentRevision });
    return;
  }
  // A concurrent replaceManifest call is still holding the lock after the bounded retry budget —
  // also transient/retry-safe, same 409 posture as the conflict case above (see
  // ProjectWorkspaceFsManager.withExclusiveLock's own doc comment on this being rare and bounded).
  if (err instanceof ProjectWorkspaceLockTimeoutError) {
    respond(res, 409, "PROJECT_CONTEXT_LOCKED", err.message);
    return;
  }
  if (err instanceof InvalidBranchSelectionError) {
    respond(res, 400, "INVALID_BRANCH_SELECTION", err.message);
    return;
  }
  if (err instanceof BranchInUseError) {
    respond(res, 409, "BRANCH_IN_USE", err.message);
    return;
  }
  if (err instanceof TaskNotEditableError) {
    respond(res, 409, "TASK_NOT_EDITABLE", err.message);
    return;
  }
  if (err instanceof SelfDependencyError) {
    respond(res, 400, "SELF_DEPENDENCY", err.message);
    return;
  }
  if (err instanceof CrossProjectDependencyError) {
    respond(res, 400, "CROSS_PROJECT_DEPENDENCY", err.message);
    return;
  }
  if (err instanceof CircularDependencyError) {
    respond(res, 409, "CIRCULAR_DEPENDENCY", err.message);
    return;
  }
  if (err instanceof DuplicateDependencyError) {
    respond(res, 409, "DUPLICATE_DEPENDENCY", err.message);
    return;
  }
  if (err instanceof IncompleteDependenciesError) {
    respond(res, 409, "INCOMPLETE_DEPENDENCIES", err.message, { incomplete: err.incomplete });
    return;
  }
  if (err instanceof GitHubNotConnectedError) {
    respond(res, 409, "GITHUB_NOT_CONNECTED", err.message);
    return;
  }
  // Subclasses (GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError) checked before the
  // GitHubApiError base — each maps to its own status, but all share the same safety property:
  // only `err.message` (already scrubbed by github-client.ts's safeErrorMessage) ever reaches the
  // client, never a raw header, response body, or the credential used to make the request.
  if (err instanceof GitHubRateLimitError) {
    respond(res, 429, "GITHUB_RATE_LIMITED", err.message, err.resetAt ? { resetAt: err.resetAt.toISOString() } : undefined);
    return;
  }
  if (err instanceof GitHubAuthError) {
    respond(res, 502, "GITHUB_AUTH_FAILED", err.message);
    return;
  }
  if (err instanceof GitHubNotFoundError) {
    respond(res, 502, "GITHUB_NOT_FOUND", err.message);
    return;
  }
  if (err instanceof GitHubApiError) {
    respond(res, 502, "GITHUB_API_ERROR", "GitHub API request failed");
    return;
  }

  console.error("[api] unhandled error:", err);
  respond(res, 500, "INTERNAL_ERROR", "An unexpected error occurred");
}

function respond(res: Response, status: number, code: string, message: string, details?: unknown): void {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  res.status(status).json(body);
}
