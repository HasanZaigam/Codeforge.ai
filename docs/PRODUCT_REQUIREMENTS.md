# Product Requirements

Scope: what the product must do, from the developer's point of view. For the system's internal architecture see [ARCHITECTURE.md](./ARCHITECTURE.md). For what is actually built in v1 see [MVP_SCOPE.md](./MVP_SCOPE.md) — this document describes the full product intent, not only the MVP.

## Users

- **Developer** — creates tasks, answers "needs input" questions, reviews reports, approves deployments. Primary and, for MVP, only role.
- Future: PM/client-facing roles that can create tasks but not approve deployments; org admins managing project connections and members. Not in MVP (see [MVP_SCOPE.md](./MVP_SCOPE.md)).

## Functional requirements

### FR-1: Projects
- A developer sees a list of the projects they have access to.
- A project is connected to exactly one source-control repository and, optionally, a deployment target.
- A project carries its own tech stack, structure, tests, and rules — expressed as configuration and in-repo context files, never as platform code. See [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md).

### FR-2: Task board
- Opening a project shows a Kanban board: `TODO → WORKING → REVIEW → NEEDS INPUT → DONE`.
- A task card shows: title, short description, project, status, agent status/progress, time started, last activity, and the next relevant action (e.g. "Answer question", "Review changes").
- Advanced technical detail (logs, diffs, tool calls, validation output) lives behind "View Details" — never on the board itself.

### FR-3: Task creation
- A developer creates a task from a short, plain-language description (e.g. "Client says login fails when OTP is entered after session timeout"). No structured/technical prompt is required.
- The system is responsible for turning that description into an executable engineering task by gathering project context itself (see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md)).

### FR-4: Autonomous execution
- Once created, a task proceeds without further prompting through investigation, planning, implementation, testing, self-fix, and validation, per [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md).
- The developer is not required to be present while a task executes.

### FR-5: Needs Input
- When the system cannot safely proceed, the task moves to `NEEDS INPUT` and presents: what was discovered, what was tried, why it stopped, what decision is required, and recommended options.
- The system never re-asks something it can determine itself (e.g. by reading the repo, config, or prior task history).
- Answering resumes the task automatically, without the developer re-explaining prior context.

### FR-6: Evidence-based completion
- A task cannot reach `REVIEW`/`DONE` on the coding engine's own claim of completion. Completion requires passing the validation stages defined in [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) (tests, static analysis, independent review, etc., as applicable to the project).

### FR-7: Task report
- On reaching `REVIEW`, the developer receives a concise report: what was wrong, what changed, files changed, test results, validation results, confidence, and status — with technical detail available on demand. See the report shape in [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md).

### FR-8: Source control
- The system works against the project's real repository: reads code, creates branches, commits, and opens a pull/merge request. It does not push directly to a protected branch or merge without explicit human action.

### FR-9: Deployment (future-ready, not required to be functional in MVP)
- Deployment is modeled as a pluggable adapter triggered only after explicit human approval, with status/verification feedback back into the task. See [INTEGRATION_ARCHITECTURE.md](./INTEGRATION_ARCHITECTURE.md).

### FR-10: Multi-project, multi-task concurrency
- A developer can have tasks running across multiple projects simultaneously, and multiple tasks within the same project, without one task's workspace affecting another's.

## Non-functional requirements

- **Responsive UI**: one web application usable on desktop, tablet, and mobile browser — no separate mobile app.
- **Stack-agnostic**: no platform behavior assumes a specific language, framework, or cloud provider.
- **Resumability**: a task's progress survives platform restarts; it is not lost if a worker process dies mid-task.
- **Token/context efficiency**: the platform must not re-send full repository content on every step. See [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md).
- **Security**: no raw credentials in prompts, logs, or source files; least-privilege, scoped, short-lived credentials for any repository/deployment access. See [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md).
- **Auditability**: every state transition and agent action on a task is recorded and inspectable.
- **Extensibility**: new coding engines, source-control providers, and deployment providers can be added as adapters without changing core task/orchestration logic. See [INTEGRATION_ARCHITECTURE.md](./INTEGRATION_ARCHITECTURE.md).

## Explicit UI non-goals

- Not a monitoring/observability dashboard by default — the board stays simple; depth is opt-in via "View Details."
- Not a full IDE or diff-review tool reimplementation — deep code review can link out to the source-control provider's own PR view rather than reimplementing it.
