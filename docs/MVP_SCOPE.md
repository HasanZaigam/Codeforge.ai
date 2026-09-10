# MVP Scope

Goal of the MVP, stated precisely: prove that **one developer can create a plain-language task against a real project and stop babysitting the AI** — the system investigates, implements, self-fixes, independently validates, and either produces a reviewable PR + report or pauses with a specific, answerable question. Everything in scope below exists to prove that loop end-to-end, on a real repository. Everything out of scope is deferred because it does not change whether that loop works.

## In scope

**Tenancy & auth**
- Single tenant, single developer role. Schema includes `tenant_id`/`project_id`/`user_id` throughout (cheap now, expensive later), but no org/multi-tenant UI or billing.
- Basic session/token auth. No SSO.

**Projects**
- One or more projects can be connected, each to exactly one GitHub repository.
- Project config (build/test/lint commands, coding-engine choice) is declarable; if undeclared, discovered once by the Implementer and cached (see [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md)).

**UI**
- Responsive web app: project list, Kanban board (`BACKLOG/TODO/WORKING/REVIEW/NEEDS INPUT/DONE`, plus `FAILED` as a conditional extra column shown only once a task actually has that status — see TECHNICAL_DECISIONS.md TD-25; `CANCELLED` is deliberately not a board column, see below), task detail with "View Details," NEEDS INPUT answer form, task report view. No native mobile app.

**Task execution**
- Task creation from plain-language description. Every task is created into `BACKLOG` and only becomes eligible for a worker (`TODO`) via an explicit developer "Start Task" action — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Task creation" and "BACKLOG editing." A task's title/goal/branch selection can be edited, and explicit dependencies on other tasks in the same project added/removed, only while it is still `BACKLOG` (server-enforced).
- Explicit, user-defined task dependencies (AND semantics, satisfied only when a dependency is `DONE`, same-project only, cycles rejected at any depth) gate the `BACKLOG -> TODO` release — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Task dependencies." No `BLOCKED` status: an incomplete-dependency task simply stays `BACKLOG`, with blockedness derived/displayed ("Blocked by: ...") rather than persisted as its own state.
- Cancellation, distinct from `FAILED`: a developer can stop a task from `BACKLOG`, `TODO`, `WORKING`, or `NEEDS INPUT`. `CANCELLED` is terminal, persisted for history/audit (never deleted, visible on the task's own detail page), and deliberately excluded from the main board's columns (see TECHNICAL_DECISIONS.md TD-25) rather than shown as if it needs attention.
- Bounded worker concurrency: `WORKER_MAX_CONCURRENT_TASKS` (default 2) caps how many `TODO`/`WORKING` executions one worker process runs at once — real executions, not the separate, uncapped `REVIEW`/human-review-feedback poll. See [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Worker concurrency and lease loss."
- Full lifecycle per [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md): investigate → implement → self-fix loop → deterministic gates (build/test/lint) → independent Reviewer invocation → REVIEW.
- `NEEDS INPUT` pause/resume, fully functional, with structured discovered/attempted/blocker/question/options.
- One coding engine adapter: Claude Code, run headlessly per task in an isolated container workspace (see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md)).
- Source control: GitHub only — branch, commit, push, open PR (real implementation shipped in Step 7 — see [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md)). No auto-merge. A `local-git` provider also exists behind the same abstraction, but only as a dev/testing convenience (no remote, no auth, no real PR, never reaches `DONE`) — it is not a second supported production source-control provider, and is disabled by default under `NODE_ENV=production` unless `ALLOW_LOCAL_GIT_PROJECTS=true` is set explicitly (see [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) "Local git / plain-git testing").
- Concurrent tasks across projects and within a project, each in its own isolated workspace.
- Task resumability across worker/process restarts, backed by the persisted event log.

**Validation**
- Deterministic gates: build, project-declared tests, lint (where the project declares a command).
- One independent Reviewer invocation (fresh context) as the non-negotiable "don't trust self-report" check.
- Security static-analysis gate: included only if trivially pluggable per project (e.g. a declared scan command); not built as a bespoke platform feature in v1.

**Reporting & notifications**
- Concise task report per [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md).
- In-app notification when a task reaches `NEEDS INPUT` or `REVIEW`. No email/Slack in v1.

**Audit**
- Append-only task event log, readable via "View Details." No separate observability stack.

## Explicitly out of scope for MVP

- **Deployment execution.** The `DeploymentAdapter` interface exists and a project may reference a Jenkins target in config, but wiring a real, working Jenkins trigger is not required to ship the MVP — it's decoupled so it never blocks the core loop. If time allows, a minimal manual-trigger Jenkins call may be added, but the core success criteria do not depend on it.
- **Multi-tenant org management** (inviting teams, org-level billing/roles).
- **Source-control providers beyond GitHub** (GitLab, Bitbucket).
- **Coding engines beyond Claude Code** (OpenCode, Cursor) — the abstraction exists; only one implementation ships.
- **RBAC beyond project membership.**
- **Auto-merge / auto-deploy without human approval** — never in scope, at any stage, not just MVP (see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md)).
- **Dedicated observability/tracing stack** — the audit event log suffices for v1 debugging.
- **Native mobile app.**
- **Cross-project/cross-repository planning** (a task always targets one project).

## Explicit assumptions made to keep this list decisive

1. Task creation always targets exactly one project; the platform does not infer which project a task belongs to.
2. "Ready for review" and "ready for deployment approval" are the same `REVIEW` state — deployment approval, when a project has deployment configured, is an action taken from that state, not a separate lifecycle stage.
3. A missing project-declared test/build command is not a blocker: it's a one-time discovery the Implementer performs and the platform caches, not a `NEEDS INPUT` pause.
4. "Independent validation" for MVP means one Reviewer invocation plus deterministic gates — not multiple specialized reviewer passes (see [AGENT_ARCHITECTURE.md](./AGENT_ARCHITECTURE.md) for why more agents were rejected).
