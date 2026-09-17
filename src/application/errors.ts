/**
 * Application-layer error taxonomy. The API's error-handling middleware
 * (src/api/error-middleware.ts) maps these to HTTP status codes; nothing
 * below this line knows about HTTP. Domain errors thrown by the Orchestrator
 * itself (InvalidTransitionError, orchestrator's NotFoundError) are caught
 * and re-thrown as these where the application layer calls into it, so the
 * API only ever has one error vocabulary to handle. See /docs/API.md.
 */

export class NotFoundError extends Error {
  constructor(
    public readonly kind: "Project" | "Task" | "HumanInputRequest",
    public readonly id: string,
  ) {
    super(`${kind} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** Client sent a request body that fails schema validation. */
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** The requested operation is not legal given the task's current state (e.g. answering when nothing is open). */
export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOperationError";
  }
}

/**
 * Login failed. Deliberately used for BOTH "no such user" and "wrong
 * password" — the message is intentionally generic so the API never
 * confirms whether an email is registered. See /docs/AUTHENTICATION.md.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

/** Registration was attempted with an email that's already registered. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists");
    this.name = "EmailAlreadyRegisteredError";
  }
}

/** A GitHub token was supplied to POST /integrations/github but GitHub itself rejected it. */
export class InvalidGitHubTokenError extends Error {
  constructor() {
    super("GitHub rejected this token — check that it's valid and hasn't expired or been revoked");
    this.name = "InvalidGitHubTokenError";
  }
}

/** A repository or branch supplied to POST /projects (provider="github") doesn't exist or isn't accessible with the connected account. */
export class InvalidRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepositoryError";
  }
}

/**
 * POST /projects (provider="local-git") was rejected because local-git
 * projects are disabled under NODE_ENV=production (see
 * /docs/GITHUB_INTEGRATION.md "Local git / plain-git testing" and
 * ALLOW_LOCAL_GIT_PROJECTS in /docs/DEPLOYMENT.md). Enforced in
 * ProjectService.create itself, not just the schema, so it cannot be
 * bypassed by any request shape.
 */
/**
 * A task-creation request's branch selection is invalid for a reason the
 * schema alone can't catch (e.g. a "new branch" name identical to its own
 * base branch, or an "existing branch" that doesn't exist on the remote).
 * See /docs/TASK_LIFECYCLE.md "Branch modes".
 */
export class InvalidBranchSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBranchSelectionError";
  }
}

/**
 * Rejected: a second concurrent (non-terminal) task in the same project
 * already targets this exact branch in "existing branch" mode. The platform
 * has no mechanism to serialize concurrent pushes to the same branch (see
 * /docs/TASK_LIFECYCLE.md "Branch modes" — Part E), so this is prevented
 * outright rather than silently risking two agents racing commits/pushes
 * onto one branch.
 */
export class BranchInUseError extends Error {
  constructor(branch: string, taskTitle: string) {
    super(
      `Branch "${branch}" is already in use by another active task ("${taskTitle}") working directly on it. ` +
        "Wait for that task to finish, or choose a different branch / create a new branch instead.",
    );
    this.name = "BranchInUseError";
  }
}

/**
 * POST /tasks/:taskId/edit was called against a task that is no longer
 * BACKLOG. A task's editable configuration (title/goal/branch settings) is
 * only mutable while it sits in BACKLOG — once released (or terminal),
 * those fields become immutable, mirroring `Task.goal`'s original doc
 * comment. See /docs/TASK_LIFECYCLE.md "Task lifecycle" and
 * TaskService.editBacklogTask.
 */
export class TaskNotEditableError extends Error {
  constructor(status: string) {
    super(`This task can no longer be edited — it is ${status}, not BACKLOG. Only a task still in Backlog can be edited.`);
    this.name = "TaskNotEditableError";
  }
}

/**
 * Explicit, user-defined task dependency validation errors (see
 * /docs/TASK_LIFECYCLE.md "Task dependencies" and TaskService.addDependency). Deliberately its own
 * small taxonomy, mirroring BranchInUseError/InvalidBranchSelectionError's own style: each rule
 * violation gets a distinct, named error rather than one generic "invalid dependency" catch-all, so
 * error-middleware.ts can map each to its own clear HTTP code and the frontend can react
 * specifically if it ever needs to.
 */

/** POST /tasks/:taskId/dependencies was called with `dependsOnTaskId` equal to `taskId` itself. */
export class SelfDependencyError extends Error {
  constructor() {
    super("A task cannot depend on itself.");
    this.name = "SelfDependencyError";
  }
}

/** The dependency and the dependent task belong to different projects — dependencies only ever connect tasks within the same project. */
export class CrossProjectDependencyError extends Error {
  constructor() {
    super("A task can only depend on another task in the same project.");
    this.name = "CrossProjectDependencyError";
  }
}

/** This exact (taskId, dependsOnTaskId) edge already exists — see TaskDependencyRepository.isDuplicateDependencyViolation. */
export class DuplicateDependencyError extends Error {
  constructor(dependencyTitle: string) {
    super(`This task already depends on "${dependencyTitle}".`);
    this.name = "DuplicateDependencyError";
  }
}

/**
 * Adding this dependency would create a cycle — including an indirect one (e.g. A depends on B, B
 * depends on C, and this request would make C depend on A) — detected via real graph reachability,
 * not just a direct-pair check. See TaskService's `wouldCreateCycle` helper.
 */
export class CircularDependencyError extends Error {
  constructor() {
    super("This dependency would create a circular dependency chain, which is not allowed.");
    this.name = "CircularDependencyError";
  }
}

/**
 * A `Project` exists (and the caller owns it, so `assertProjectAccess` already passed) but its
 * `ProjectWorkspace` row is missing — see ProjectService.create's eager-creation invariant
 * ("every project gets exactly one ProjectWorkspace, right after project insert") and
 * ProjectService.getWorkspace. This should never happen in a codebase with no cross-statement
 * transactions guarding that invariant (see db.ts's own doc comment) only if a prior insert
 * genuinely failed/was interrupted between the two statements, or a project row was inserted
 * directly (bypassing ProjectService), or the migrations/011_project_workspace.sql backfill was
 * somehow skipped for a pre-existing project. There's no established "this should never happen"
 * error class elsewhere in this codebase to reuse, and reusing `NotFoundError` here would be
 * actively misleading (its whole contract, per assertProjectAccess's own doc comment, is "we never
 * confirm a resource exists to someone who isn't allowed to see it" — but the project here
 * unambiguously *does* exist and *is* the caller's). So this gets its own narrow, diagnosable
 * error instead, mapped to a 500 by the generic error-middleware fallback (logged server-side via
 * console.error, same as every other unmapped error) rather than any 4xx — this is a server-side
 * data-integrity gap, never a client mistake.
 */
export class ProjectWorkspaceMissingError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} has no ProjectWorkspace row — expected one to have been created eagerly alongside the project.`);
    this.name = "ProjectWorkspaceMissingError";
  }
}

export class LocalGitProjectsDisabledError extends Error {
  constructor() {
    super(
      'Local git / plain-git testing projects are disabled in production. It skips GitHub credentials and never ' +
        "opens a Pull Request, so it's for evaluation/testing only, not the normal production workflow. Set " +
        "ALLOW_LOCAL_GIT_PROJECTS=true to explicitly enable it.",
    );
    this.name = "LocalGitProjectsDisabledError";
  }
}

/**
 * DELETE /projects/:projectId was called while at least one of the project's tasks is still
 * "active" (TODO/WORKING/NEEDS_INPUT — genuinely queued or executing — or REVIEW, which has an
 * open Pull Request still awaiting a human decision). Deleting the project out from under a task
 * mid-execution would orphan its lease/workspace mid-run; deleting one with an open PR would erase
 * the platform's own record of it while GitHub's side still exists. Blocked outright rather than
 * force-cancelling those tasks on the caller's behalf — cancellation is its own explicit, separate
 * action (see TaskService.requestCancellation) the caller can take first if that's really what they
 * want. See ProjectService.delete.
 */
export class ProjectHasActiveTasksError extends Error {
  constructor(blockingTaskTitles: string[]) {
    super(
      `This project has ${blockingTaskTitles.length} task(s) that are still active (queued, in progress, or awaiting review): ` +
        `${blockingTaskTitles.join(", ")}. Cancel or finish them before deleting the project.`,
    );
    this.name = "ProjectHasActiveTasksError";
  }
}
