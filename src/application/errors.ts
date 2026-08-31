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
