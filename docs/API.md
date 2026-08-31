# API Contract (MVP)

This documents the HTTP boundary implemented in Step 3 — the interface the future web dashboard consumes. It sits below the UI and above the domain, per [ARCHITECTURE.md](./ARCHITECTURE.md): `Web UI → Application/API → Domain → Orchestrator → Execution infrastructure`. The API never lets a client manipulate task state directly — every write either creates a new task (`TODO`) or answers an open `NEEDS_INPUT` question; the Orchestrator remains the sole authority over state transitions (see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md)).

Implementation: `src/api/`. Application services it calls into: `src/application/`. See [TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-17 for why Express was chosen.

## Running it

```
npm run api      # HTTP server only — never executes tasks itself
npm run worker    # background poller — claims and drives tasks; run alongside the API
npm run dev       # both, for local development
```

Both processes read the same environment variables and must point at the same SQLite file to see the same tasks:

| Variable | Default | Meaning |
|---|---|---|
| `DB_PATH` | `./.data/platform.sqlite` | Shared SQLite database file. |
| `WORKSPACES_ROOT` | `./.data/workspaces` | Root directory for per-task workspaces. |
| `PORT` | `3000` | API listen port. |
| `POLL_INTERVAL_MS` | `2000` | Worker poll interval. |
| `CODING_ENGINE` | `claude-code` | `claude-code` (real adapter, requires the `claude` CLI + credentials) or `fixture` (deterministic, no external dependency — for local dev only). |

## Authentication *(implemented in Step 6 — see [AUTHENTICATION.md](./AUTHENTICATION.md) for the full design)*

Every request to `/projects/*` and `/tasks/*` requires a valid session, presented as an HttpOnly `session` cookie set by `/auth/register` or `/auth/login`. There is no header-based identity anymore — a client cannot claim to be a given user; the server resolves `req.user` only from a cookie it issued and can revoke. `/auth/register`, `/auth/login`, and `GET /health` are the only endpoints reachable without a session; `/auth/logout` and `/auth/me` need one.

## Authorization semantics

Every project and task is scoped to the authenticated user who owns it (`User -> owns -> Project -> tasks` — see [AUTHENTICATION.md](./AUTHENTICATION.md) "Authorization model"). Attempting to read or act on another user's project or task returns **`404`, not `403`** — the API never confirms that a resource exists to a caller who isn't allowed to see it. `GET /projects` and `GET /projects/:id/tasks` return only the caller's own resources; there is no "list everything" endpoint.

## Response envelope

Success responses wrap the payload in a named key (`{ "project": {...} }`, `{ "tasks": [...] }`) rather than returning a bare object/array — keeps the contract extensible (pagination metadata, etc. can be added alongside the data key without a breaking change).

## Error format

```json
{ "error": { "code": "NOT_FOUND", "message": "Task not found: <id>", "details": { } } }
```

`details` is present only for validation errors (`INVALID_REQUEST`) and omitted otherwise. No response ever includes a raw stack trace, filesystem path, or internal exception message — see `src/api/error-middleware.ts`.

| HTTP status | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Request body fails schema validation. |
| 401 | `UNAUTHENTICATED` | No valid session cookie on a protected route. |
| 401 | `INVALID_CREDENTIALS` | `/auth/login` with a wrong password or an email that isn't registered — same code either way, see AUTHENTICATION.md. |
| 404 | `NOT_FOUND` | Project/task doesn't exist, **or exists but isn't the caller's** — see "Authorization semantics" above. |
| 409 | `EMAIL_ALREADY_REGISTERED` | `/auth/register` with an email already in use. |
| 409 | `INVALID_OPERATION` | E.g. answering input when none is open. |
| 409 | `INVALID_STATE_TRANSITION` | An operation would violate the task state machine. |
| 429 | `TOO_MANY_ATTEMPTS` | Login/register rate limit exceeded (see AUTHENTICATION.md "Rate limiting"). |
| 500 | `INTERNAL_ERROR` | Unexpected server error (logged server-side, not detailed to the client). |

## Pagination

Not implemented. Every list endpoint (`GET /projects`, `GET /projects/:id/tasks`, `GET /tasks/:id/events`) returns the full result set. Acceptable for the MVP's expected volume (single tenant, one developer); revisit if/when task or event counts grow — the response envelope's named-array shape leaves room to add a `nextCursor` field without breaking existing clients.

## Task lifecycle semantics (read before wiring a UI against this)

A task's `status` (`TODO | WORKING | NEEDS_INPUT | REVIEW | DONE | FAILED | CANCELLED`) is set exclusively by the Orchestrator's deterministic state machine — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md). The API has no endpoint that sets status directly — there is no `PATCH /tasks/:id` accepting an arbitrary `status` field, and there never will be. Three things move a task forward:
1. **The worker process**, polling for `TODO` and `WORKING` tasks and calling the Orchestrator — invisible to the API, observable only through `GET /tasks/:id` and `GET /tasks/:id/events`.
2. **`POST /tasks/:id/input`**, which resumes a `NEEDS_INPUT` task to `WORKING` — execution then continues on the worker's next poll, not inline in the request.
3. **`POST /tasks/:id/cancel`** (added in Step 5), an explicit domain command that stops a task — see below and [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Cancellation" for the full mechanics, including why cancelling a `WORKING` task doesn't take effect synchronously within the request.

### Endpoints deliberately not included

- `POST /tasks/:id/start` — task creation already leaves the task `TODO`; the worker picks it up on its own. A separate start call would only race the poller.
- `POST /tasks/:id/resume` — resuming is a side effect of answering input (`POST /tasks/:id/input`), not a distinct action.

## Endpoints

### `GET /health`
Liveness check, public, no session required. `{ "status": "ok" }` — nothing else; never includes database paths, credentials, or other internal details.

### `POST /auth/register`
Public. `{ "email": "dev@example.com", "password": "at least 10 characters", "name": "Dev" }`. Creates an account, sets the session cookie, returns `201` with `{ "user": UserDTO }`. `409 EMAIL_ALREADY_REGISTERED` if the email is taken. Rate-limited (see AUTHENTICATION.md).

### `POST /auth/login`
Public. `{ "email": "...", "password": "..." }`. Sets the session cookie, returns `200` with `{ "user": UserDTO }`. `401 INVALID_CREDENTIALS` for either a wrong password or an unregistered email — deliberately the same response either way. Rate-limited.

### `POST /auth/logout`
Requires a session. Deletes it server-side and clears the cookie. Returns `204`. Safe to call without a valid session too (no-op, still `204`).

### `GET /auth/me`
Requires a session. `{ "user": { "id", "email", "name" } }`. `401 UNAUTHENTICATED` if not signed in — this is what the frontend calls once on startup to decide whether to show the dashboard or the login screen (see [UI_ARCHITECTURE.md](./UI_ARCHITECTURE.md) "Session bootstrap").

```ts
interface UserDTO { id: string; email: string; name: string; createdAt: string; } // never a password/hash field
```

### `GET /projects`
The caller's own projects only. `{ "projects": ProjectDTO[] }`.

### `POST /projects`
Create a project (connects a repository/config — see [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) FR-1). The request body is a discriminated union on `sourceControlProvider` *(GitHub support added in Step 7 — see [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md))*:

```json
{
  "sourceControlProvider": "github",
  "name": "OTT",
  "owner": "example",
  "repo": "ott",
  "defaultBranch": "main",
  "codingEngine": "claude-code",
  "commands": { "build": "npm run build", "test": "npm test", "lint": "npm run lint" }
}
```
```json
{
  "sourceControlProvider": "local-git",
  "name": "Fixture",
  "repoUrl": "/path/to/local/repo.git",
  "defaultBranch": "main"
}
```
For `"github"`: `owner`/`repo` are validated against GitHub's own naming rules before ever reaching a shell command or URL; `defaultBranch` is optional (the repository's real default branch is used if omitted). The caller must already have a connected GitHub account (`POST /integrations/github`) — `409 GITHUB_NOT_CONNECTED` otherwise. The repository and branch are verified against the real GitHub API before the project is persisted — `400 INVALID_REPOSITORY` if either doesn't exist or isn't accessible with the connected account. For `"local-git"`: `repoUrl` is required, exactly as before Step 7. In both branches, `name` is required and the rest default per [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md)'s pragmatic-discovery stance (undeclared commands are skipped by validation, not failed — see [ARCHITECTURE.md](./ARCHITECTURE.md) layer 11). Returns `201` with `{ "project": ProjectDTO }`.

### `GET /projects/:projectId`
`{ "project": ProjectDTO }`. `404` if not found.

### `GET /projects/:projectId/tasks`
`{ "tasks": TaskDTO[] }` for the project, newest first. `404` if the project doesn't exist.

### `POST /projects/:projectId/tasks`
The most important write in the API (see [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) FR-3/FR-4). Plain-language input only:
```json
{ "title": "Fix OTP timeout issue", "description": "Client reports that OTP login fails after session timeout." }
```
Creates a task in `TODO` and returns immediately — **does not execute it**. Returns `201` with `{ "task": TaskDTO }`.

### `GET /tasks/:taskId`
`{ "task": TaskDTO }`. `404` if not found.

```ts
interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  description: string;       // the original plain-language goal
  status: "TODO" | "WORKING" | "NEEDS_INPUT" | "REVIEW" | "DONE" | "FAILED" | "CANCELLED";
  currentActivity: string;   // human-readable, derived from the latest TaskEvent — e.g. "Running tests"
  selfFixAttempts: number;
  branchName: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null;
  cancelRequested: boolean;  // true only while WORKING with a cancellation pending but not yet confirmed
  cancelledBy: string | null; // set once a cancellation was requested — who asked for it
  pullRequestUrl: string | null;    // set once independent review approves and the platform opens/finds the PR
  pullRequestNumber: number | null;
  commitSha: string | null;         // the platform's own latest commit for this task, if any
}
```

### `GET /tasks/:taskId/events`
`{ "events": TaskEventDTO[] }`, oldest first — the full timeline (`TASK_CREATED`, `AGENT_STARTED`, `VALIDATION_COMPLETED`, `NEEDS_INPUT_RAISED`, ... — the full type list is `TaskEventType` in `src/domain/types.ts`). Each event's `payload` is the same structured, non-secret data recorded internally (see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md)) — never a raw log dump; log excerpts are bounded (a few KB) where they appear inside a payload at all. Not paginated in the MVP (see above).

### `GET /tasks/:taskId/report`
`{ "report": TaskReport }` — the concise, evidence-based report defined in [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md), built from persisted `AgentRun`/`TaskEvent` data, never fabricated:
```ts
interface TaskReport {
  title: string;
  whatWasWrong: string;                                    // the task's original goal
  whatChanged: string;                                      // latest Implementer summary
  filesChanged: number;
  checks: Array<{ name: string; passed: boolean }>;         // from the latest validation run
  reviewFindings: Array<{ severity: string; category: string; summary: string }>;
  confidence: "high" | "medium" | "low" | null;             // from the independent Reviewer, not the Implementer
  status: string;                                            // "Ready for review" | "Done" | "Needs input" | "Failed" | "In progress" | "Cancelled"
  pullRequest: { url: string | null; number: number | null; branch: string | null; baseBranch: string } | null;
  commitSha: string | null;
}
```
Available at any task status; before `REVIEW` it reflects whatever evidence exists so far. `pullRequest` is non-null only once the platform has actually opened/found a real PR — see [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md); the platform never auto-merges, so its presence always means "opened, awaiting your review on GitHub," never "done."

### `GET /tasks/:taskId/input`
`{ "input": HumanInputRequestDTO | null }` — `null` if the task has no open `NEEDS_INPUT` question right now.
```ts
interface HumanInputRequestDTO {
  id: string;
  status: "open" | "answered";
  discovered: string; attempted: string[]; blocker: string; question: string;
  options: Array<{ label: string; description: string }>;
  answer: { selectedOption: string | null; freeText: string } | null;
  askedAt: string; answeredAt: string | null;
}
```

### `POST /tasks/:taskId/input`
Answers the currently open request.
```json
{ "selectedOption": "Fix add() to return a + b", "freeText": "Fix add() to return a + b" }
```
`freeText` is required; `selectedOption` is optional. Returns `200` with `{ "task": TaskDTO }` (status will be `WORKING`). `409 INVALID_OPERATION` if there is no open request (including if it was already answered).

### `POST /tasks/:taskId/cancel` *(added in Step 5)*
Requests cancellation. No request body required. Returns `200` with `{ "task": TaskDTO }`.

- **`TODO`/`NEEDS_INPUT` task**: finalizes synchronously — the response already shows `status: "CANCELLED"`.
- **`WORKING` task**: only records intent — the response shows `status: "WORKING"`, `cancelRequested: true`. The actual interruption happens asynchronously (see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Cancellation"); poll `GET /tasks/:id` until `status` becomes `CANCELLED`.
- **Idempotent**: calling it again on an already-`CANCELLED` task, or on a `WORKING` task with cancellation already pending, returns `200` with the current (unchanged) task — never an error.
- **`409 INVALID_STATE_TRANSITION`**: the task is `REVIEW`, `DONE`, or `FAILED` — none of those are cancellable (see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) for why).
- **`404 NOT_FOUND`**: unknown task id.

The frontend never kills a process or touches a workspace directly — this endpoint (via `TaskService.cancelTask` → `Orchestrator.requestCancellation`) is the only sanctioned way to stop a task, and it's a domain command, not a status write.

### `GET /integrations/github` *(added in Step 7)*
The caller's own GitHub connection status: `{ "connected": boolean, "githubLogin": string | null, "connectedAt": string | null }`. Never includes the token.

### `POST /integrations/github` *(added in Step 7)*
Connects (or reconnects) a GitHub account for the caller.
```json
{ "token": "ghp_..." }
```
The token is verified against the real GitHub API before being stored (encrypted) — `400 INVALID_GITHUB_TOKEN` if GitHub rejects it. Returns `200` with the same shape as `GET /integrations/github`. See [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md).

### `DELETE /integrations/github` *(added in Step 7)*
Disconnects the caller's GitHub account — deletes the stored credential entirely (not a soft flag). `204` with no body. Existing GitHub-backed projects are unaffected as records, but any task execution against them will fail (`SOURCE_CONTROL_FAILED` → `FAILED`) until reconnected.

## Validation

All request bodies are validated with `zod` schemas (`src/api/schemas.ts`) before reaching any application service. Clients never control: the task's id, status, project ownership resolution (derived from the authenticated route/actor, not from the body), execution state, file paths, or commands — those either come from the URL, from `req.actorId`, or aren't settable via the API at all.
