# Technical Decisions

Short-form decision log. Each entry: decision, alternatives considered, why this one. Deeper rationale lives in the linked document — this is an index, not a duplicate.

## TD-1: Deterministic Orchestrator, not an LLM-driven controller
**Decision**: task state transitions are computed by a rule-based state machine, never by asking a model "what should happen next."
**Alternatives**: an LLM "meta-agent" deciding transitions.
**Why**: resumability, auditability, and zero token cost for control flow; an LLM controller would make crash recovery and "why did the task move here" debugging nondeterministic. See [ARCHITECTURE.md](./ARCHITECTURE.md), [AGENT_ARCHITECTURE.md](./AGENT_ARCHITECTURE.md).

## TD-2: Two agent roles (Implementer, Reviewer), not eight
**Decision**: reject separate Planner, Repository/Context Analyst, Test Agent, Security Agent, and Deployment Agent as standalone LLM agents; fold their responsibilities into the Implementer's native workflow or into deterministic tool gates.
**Alternatives**: one agent per responsibility listed in the brief.
**Why**: modern coding engines already plan/explore internally; splitting that into a separate agent duplicates repo reads and tokens without improving reliability. The one place a second model call earns its cost is independent review of a diff it didn't write. See [AGENT_ARCHITECTURE.md](./AGENT_ARCHITECTURE.md).

## TD-3: Context lives in the project's own repo, not the platform's database
**Decision**: `CLAUDE.md`/`AGENTS.md`-style instruction files are stored and version-controlled inside each connected project's repository; the platform stores only pointers.
**Alternatives**: platform-side context store/RAG index per project.
**Why**: avoids a second source of truth, leverages the coding engine's native hierarchical file discovery instead of reimplementing retrieval, and keeps token usage bounded by scoping to what the engine actually reads. See [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md).

## TD-4: Task record (structured), not chat transcript, is the unit of retained context
**Decision**: each coding-engine invocation gets a freshly built context bundle from a persisted task record (goal, plan, decisions, answers) — never a replayed conversation history.
**Alternatives**: keep a long-lived chat session per task and replay/append to it.
**Why**: bounds token growth on long-running/paused tasks (a task resumed a week later doesn't re-pay for a week-old transcript) and makes recovery after a crash well-defined — the DB, not an in-memory session, is authoritative. See [ARCHITECTURE.md](./ARCHITECTURE.md), [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md).

## TD-5: Ephemeral, isolated workspace per task
**Decision**: every task gets its own container + fresh git checkout/worktree, torn down after use; no shared per-project checkout across tasks.
**Alternatives**: one persistent checkout per project, reused/locked across tasks.
**Why**: enables true concurrency (multiple tasks on the same project, same time, no race), and makes crash recovery trivial (workspace is disposable and reproducible from git). See [ARCHITECTURE.md](./ARCHITECTURE.md), [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md).

## TD-6: Every external dependency is an interface, MVP ships one implementation each
**Decision**: `CodingEngineAdapter`, `SourceControlProvider`, `DeploymentAdapter` are the only points where the platform talks to Claude Code, GitHub, and Jenkins respectively; core logic never imports a vendor SDK.
**Alternatives**: integrate directly, generalize later "if needed."
**Why**: the brief is explicit that none of these may become a hard dependency, and retrofitting an abstraction after core logic already assumes one vendor is materially more expensive than defining the seam now, while it costs almost nothing extra. See [INTEGRATION_ARCHITECTURE.md](./INTEGRATION_ARCHITECTURE.md).

## TD-7: `tenant_id` in the schema from day one; no multi-tenant product behavior in MVP
**Decision**: data model carries tenant/project/user scoping now; MVP runs single-tenant with no org management UI.
**Alternatives**: add tenancy later when multi-user is actually needed.
**Why**: schema changes to add a tenant boundary after data and access patterns already assume single-tenant are a migration risk; adding it now costs a foreign key, not a redesign. See [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md), [MVP_SCOPE.md](./MVP_SCOPE.md).

## TD-8: Deployment is pluggable but not required to work end-to-end in MVP
**Decision**: `DeploymentAdapter` interface and human-approval gate are designed now; a working Jenkins trigger is optional/best-effort for v1, not a blocking requirement.
**Alternatives**: build a working Jenkins integration as part of MVP, since it's named explicitly in the brief.
**Why**: the brief also says "for MVP, architecture must be designed so deployment can be plugged in" (not "must deploy") and separately says not to over-engineer the MVP; decoupling this keeps the MVP's critical path focused on proving the core babysitting-removal loop. See [MVP_SCOPE.md](./MVP_SCOPE.md).

## TD-9: One platform-root instruction file (`/CLAUDE.md`); no `/AGENTS.md` at platform root
**Decision**: do not create a duplicate agent-instruction file at the platform repo's root.
**Alternatives**: create both `CLAUDE.md` and `AGENTS.md` at root "for completeness."
**Why**: this repository is operated by Claude Code alone today; a second file would need to be kept in sync with no current reader. `AGENTS.md` remains a legitimate *optional per-connected-project* file (a project's own choice), which is a different concern entirely. See [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md).

## TD-10: `NEEDS INPUT` requires evidence, not just a stuck point
**Decision**: the platform rejects a pause request that doesn't include non-trivial `discovered`/`attempted` fields — a task can't pause just because it's hard, only because it hit a genuine decision boundary after investigating.
**Alternatives**: let the Implementer pause whenever it's unsure.
**Why**: directly enforces "the system should never repeatedly ask the developer for information it can determine itself," which is a named product requirement, not just a nice-to-have. See [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md). Implemented as `assertNonTrivial()` in `src/orchestrator/needs-input.ts`, called before any `NEEDS_INPUT` transition is persisted.

---

## Step 2 decisions (execution model)

## TD-11: SQLite (`node:sqlite`) for MVP persistence, not Postgres
**Decision**: the platform persists to a single SQLite database file via Node's built-in `node:sqlite` module (Node 22.5+), not Postgres or better-sqlite3.
**Alternatives considered**:
- *Postgres now*: correct long-term choice for real multi-user concurrency, but adds a service dependency (install/run/configure a database server) before there is any multi-process concurrency need to justify it — pure MVP friction.
- *better-sqlite3*: same embedded-file model as `node:sqlite`, but a native addon requiring node-gyp/a C++ toolchain at install time — a real risk in constrained or CI sandboxes with no build toolchain. `node:sqlite` ships in Node itself: zero native build, zero extra dependency.
- *An ORM (Prisma/Drizzle/TypeORM)*: adds a code-generation or reflection layer for a schema of seven tables that plain parameterized SQL expresses more directly and more auditably; rejected as unnecessary abstraction (see /CLAUDE.md engineering rules).
**Why SQLite wins for MVP**: single developer, local/single-process execution (per [MVP_SCOPE.md](./MVP_SCOPE.md)), zero operational setup, and — critically — SQLite's own single-writer semantics are a *feature* here: combined with WAL mode and the single-UPDATE-with-WHERE-guard claim pattern (see TD-12), they make the "two workers must never both believe they own a task" requirement trivial to guarantee correctly, which a naively-used Postgres connection pool would not give you for free.
**Migration path (explicit, not hypothetical)**: every table access goes through a narrow repository class (`src/persistence/repositories/*`) with hand-written parameterized SQL, not raw queries scattered through business logic. Moving to Postgres later means rewriting the seven repository classes' SQL dialect and swapping `openDatabase()`'s driver — the Orchestrator, state machine, and every domain type are unaffected, because none of them import `node:sqlite` directly. This is the same "interface before implementation" pattern used for coding engines, source control, and deployment (see TD-6).
**Revisit when**: true multi-process concurrent writers are needed (multiple worker processes/machines executing tasks against the same database) — SQLite's single-writer model becomes a real bottleneck there, not before.

## TD-12: Idempotency and recovery are built on optimistic, lease-based claiming — not distributed locks or a queue broker
**Decision**: a task is "claimed" for execution via a single atomic `UPDATE ... WHERE status = ? AND (lock_expires_at IS NULL OR lock_expires_at < ?)` statement (`TaskRepository.claimTodo` / `claimWorking`), not a separate lock table, a message queue, or an application-level mutex.
**Alternatives considered**: a job queue (e.g. a Redis-backed queue) with its own delivery/ack semantics; a distributed lock service. Both are real infrastructure for a problem this MVP doesn't have yet (single process, single database).
**Why**: the UPDATE-with-WHERE-guard pattern gives exactly the guarantee needed — at most one caller's claim succeeds — using only what SQLite already provides atomically, no new moving part. Recovery composes from the same primitive: `findOrphanedWorking()` finds tasks whose lease expired (crash, not completion), and any subsequent `executeTask()` call — from the same worker restarting or a different one — can simply reclaim and continue. Workspace provisioning (`LocalGitWorkspaceProvider.provision`) and commit (`LocalGitSourceControlProvider.commitAll`) are themselves idempotent (deterministic per-task path; re-running `git add -A && git commit` on a clean tree is a safe no-op), so a reclaimed task re-running its last step is safe, not just "retried and hoped."
**What this deliberately does not solve**: true horizontal scaling across many worker machines under high task volume — the lease pattern still works there, but a real queue becomes worth its operational cost at that point. Not an MVP concern (see [MVP_SCOPE.md](./MVP_SCOPE.md)).

## TD-13: `ValidationResult` and `ReviewResult` are not their own database tables
**Decision**: validation check output and reviewer findings are persisted as structured JSON — validation results inside `TaskEvent.payload` (a `VALIDATION_COMPLETED` event) and reviewer output inside `AgentRun.result` (a `StepResult`) — rather than as dedicated `validation_results` / `review_results` tables.
**Alternatives considered**: first-class tables for both, as the brief's candidate entity list suggested.
**Why not**: neither has an independent lifecycle or is ever queried/updated on its own — each is an immutable snapshot produced by, and only ever read alongside, one `AgentRun` or one validation step. A dedicated table would add joins without adding a capability; the append-only `TaskEvent` log and `AgentRun.result` already give full audit history (every validation run, every review verdict, in order) without a schema entity that exists only to be embedded elsewhere. Revisit only if validation/review results need to be queried independently of their owning task/run (e.g. cross-task analytics) — not a Step 2 requirement.

## TD-14: The Reviewer uses the same `StepResult` contract as the Implementer; `ReviewResult` is a derived view, not a second engine contract
**Decision**: `CodingEngine.run()` returns one shape (`StepResult`) regardless of role. `ReviewResult` (verdict/findings/confidence/summary) is computed from a Reviewer's `StepResult` by `deriveReviewResult()` (`src/review/reviewer.ts`): any `severity: "blocker"` finding forces `verdict: "rejected"`.
**Alternatives considered**: a distinct `EngineInvocationRequest`/response contract per role.
**Why**: a single, uniform engine contract is what keeps `CodingEngineRegistry`/`CodingEngine` a genuinely one-interface abstraction (the point of TD-6) — a coding engine only ever needs to implement one `run()` method to support both roles. The Orchestrator, not the engine, is what turns "a `StepResult` with a blocker finding" into "reject and loop back," which keeps the evidence-based-completion rule (TD-10's sibling: the Reviewer's own text never directly sets task status) enforced in one place.

## TD-15: One coding-engine role (Implementer) handles both the original attempt and every "fix based on Reviewer feedback" pass
**Decision**: when the Reviewer rejects a change, the Orchestrator folds the rejection into `Task.taskRecord.decisions` (as a `discovered` entry) and re-invokes the same Implementer role — there is no separate "revise after review" agent role.
**Why**: consistent with TD-2/AGENT_ARCHITECTURE.md's two-role design — a third role here would duplicate the Implementer's own edit/validate capability for no new capability. Reviewer feedback reaching the Implementer through `priorDecisions` (structured, not a transcript) is the same context-bundle mechanism used for human answers, so the self-fix loop and the review-rejection loop share one code path (`runWorkingEpisode` in `src/orchestrator/orchestrator.ts`) instead of two similar-but-different ones.

---

## Step 3 decisions (API, application layer, worker)

## TD-16: The API process never executes tasks; a separate worker process is the only thing that calls the Orchestrator's `executeTask()`
**Decision**: `src/api/server.ts` (HTTP) and `src/worker/run-worker.ts` (polling execution loop) are two independent entrypoints, each building its own `Platform` from the same `DB_PATH`/`WORKSPACES_ROOT`. No API route handler ever calls `Orchestrator.executeTask()`. `npm run dev` runs both together as child processes purely for local convenience (`src/dev.ts`) — it is not a merged process.
**Alternatives considered**: run the worker loop inside the API process (e.g. on an interval registered at server startup) — fewer moving parts to run locally.
**Why not**: task execution is long-running, resource-heavy (spawns a coding engine, runs project builds/tests), and must never be able to block or crash the request-handling process — the brief is explicit that "long-running AI execution must NOT block the API request" and that "the HTTP server [must not be] responsible for long-running execution." Keeping them separate now, even though `npm run dev` launches both together, means production deployment (API replicas scaled independently from worker capacity) requires no rearchitecture — just running the same two entrypoints as separate services. See [ARCHITECTURE.md](./ARCHITECTURE.md) layers 2 and 6.

## TD-17: Express for the HTTP layer, not Fastify/Koa/raw `node:http`, and not a full framework (Nest, etc.)
**Decision**: `src/api/app.ts` builds a plain Express 4 app.
**Alternatives considered**:
- *Raw `node:http` with a hand-rolled router*: consistent with this codebase's existing zero-framework choices (`node:sqlite`, `node:test`), but routing, JSON body parsing, and per-route error propagation are all things Express already does correctly and simply — writing them by hand would be more code to maintain for no behavioral gain at this scale (a dozen routes).
- *Fastify*: comparable simplicity and faster, but its idiomatic value (JSON-schema-driven validation/serialization) duplicates the `zod` validation this codebase already uses (TD-6's "interfaces before implementations" ethos favors validating with the tool already in `package.json`, not adopting a second schema system).
- *NestJS or similar*: rejected outright — decorator-based DI, modules, and an opinionated project structure are real infrastructure for an application layer that is currently three services and a dozen routes; this is exactly the "large framework without justification" the brief warns against.
**Why Express**: the single most widely understood minimal Node HTTP framework, one dependency, plain functions and `Router()` objects that map directly onto `src/api/routes/*.ts` — no new mental model for whoever picks this codebase up next. `@types/express` gives full typing; a small `asyncHandler` wrapper (`src/api/async-handler.ts`) closes Express 4's one real gap (it doesn't forward rejected promises to error middleware on its own).

## TD-18: The MVP endpoint set omits `start`, `resume`, and `cancel` — not an oversight
**Decision**: no `POST /tasks/:id/start`, no `POST /tasks/:id/resume`. `POST /tasks/:id/input` is the only write that moves a task out of `NEEDS_INPUT`, and task creation is the only way a task enters `TODO`.
**Why `start`/`resume` are unnecessary**: task creation already leaves a task in `TODO`, which the worker polls for and claims on its own (TD-12's lease mechanism) — a `start` endpoint would either do nothing (task already eligible) or race the poller. Likewise, "resume" is not a separate decision from "answer the question" — `Orchestrator.submitHumanAnswer()` already performs the `NEEDS_INPUT -> WORKING` transition as part of answering; a distinct resume call would just be a second required round-trip for no added control.
**Why no `cancel`**: `src/domain/task-state-machine.ts` has no cancel trigger — every transition table row was fixed in Step 2 and this step was explicitly told not to redesign that architecture. Adding cancellation properly means deciding what it does mid-flight (kill an in-progress agent invocation? let the current step finish? what happens to the workspace/branch?) — real state-machine and Agent Runtime design work, not an API-layer decision. Recommended as a Step 4 item once those questions are answered deliberately, not backfilled here to complete a checklist.

## TD-19: A named-actor header, not real authentication, is Step 3's identity boundary
**Decision**: `src/api/auth.ts` resolves `req.actorId` from an `x-user-id` header (falling back to a bootstrap system user), and every application service and route already depends only on `req.actorId` — never a client-asserted identity embedded in a request body.
**Why**: per [MVP_SCOPE.md](./MVP_SCOPE.md) the MVP is single-tenant/single-developer, so building real session or token authentication now is infrastructure ahead of a need (no second user to authenticate against). But routes/services taking `actorId` as an opaque input — rather than, say, hardcoding a single global user everywhere — means swapping in real auth later touches exactly one file (`src/api/auth.ts`'s middleware) and zero application-service or route code. This is the same "interface before the real implementation" pattern as TD-6, applied to identity instead of infrastructure providers. **Explicitly not production-ready**: documented in [API.md](./API.md) and [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) as a boundary that must not be exposed outside a trusted network as-is.
**Superseded by TD-29 (Step 6)**: real authentication now exists; this entry is kept as the record of why the placeholder was shaped the way it was, and as evidence for how well that shape held up when replaced (see TD-29's "what stayed the same").

---

## Step 4 decisions (web dashboard)

## TD-20: React + Vite + TypeScript, plain CSS, no state-management library, as a separate `web/` package
**Decision**: the dashboard (`web/`) is a standalone Vite + React 18 + TypeScript app with its own `package.json`, built with hand-written CSS (one stylesheet of design tokens + component classes) and no CSS framework, no component library, and no global state library (Redux/Zustand/etc.) or server-state library (React Query/SWR).
**Alternatives considered**:
- *Next.js or another meta-framework*: brings SSR/routing/data-fetching conventions this single-page, API-backed dashboard doesn't need — the brief's "avoid unnecessary UI libraries" applies directly. Plain Vite + React is the whole stack: a dev server, a build step, nothing else.
- *Svelte/SolidJS/Vue*: any would work at this app's size; React was chosen for being the framework "easy for future developers to maintain" is least likely to require an explanation — the widest-known option, not a novel one, for a product whose complexity budget is meant to go into the backend.
- *Tailwind or a component library (MUI, Chakra, shadcn/ui)*: rejected for the same reason as TD-17's Express-not-Nest call — a dozen screens' worth of cards, badges, and forms doesn't need a design system's worth of tooling; a small tokens-based stylesheet (`index.css`) gets the "clean, modern, minimal" look the brief asks for with zero extra dependencies.
- *React Query/SWR for server state*: their real value (cache invalidation, dedup across many consumers, background refetch policies) isn't needed when there are ~7 data-fetching hooks total, each owned by exactly the component tree that uses it. A single ~90-line `usePolling` hook (`web/src/hooks/usePolling.ts`) covers every polling need in the app; see the brief's "do not create an overly complicated state-management system."
- *Redux/Zustand/Context-as-global-store*: no cross-cutting client state exists to manage — the backend is the only source of truth for task state, and every screen's data is scoped to that screen. Introducing a global store would just be a second place for state to disagree with the API.
**Why a separate package, not merged into the root**: the backend's `tsconfig.json` targets Node with `NodeNext` module resolution; the frontend needs a DOM lib, JSX, and a bundler-oriented `moduleResolution`. Keeping `web/` as its own `package.json`/`tsconfig.json` avoids fighting one tsconfig into serving two incompatible runtimes, without needing npm workspaces tooling — the two apps are independently run and independently deployable, which they should be.
**Why DTO types are hand-duplicated rather than imported from the backend**: `web/src/api/types.ts` re-declares the same shapes documented in [API.md](./API.md), rather than importing from `src/domain/types.ts` or `src/api/dto.ts`. These are wire-format shapes, not logic — duplicating a handful of `interface` declarations is a well-understood, low-risk pattern that keeps the frontend deployable independently of the backend's internal module graph (no build-time coupling to `node:sqlite`-importing backend code ending up in a browser bundle). [API.md](./API.md) is the documented contract both sides are kept in sync against by hand; this is an explicit, bounded duplication, not an oversight.

## TD-21: The frontend proxies `/api` in dev instead of the backend gaining CORS support
**Decision**: `web/vite.config.ts` proxies `/api/*` to the backend (`http://localhost:3000` by default) during `npm run dev` in `web/`, rewriting away the `/api` prefix. The frontend's `apiClient` always calls relative `/api/...` paths — same-origin from the browser's perspective, so no CORS headers are needed anywhere.
**Alternatives considered**: add `cors` middleware to the Express app (`src/api/app.ts`) so the frontend (a different dev-server origin/port) could call it directly.
**Why not**: Step 4's instructions are explicit — do not modify the backend. A dev-server proxy achieves the same outcome (the browser can reach the API) with zero backend changes, and is the standard pattern for this exact situation.
**Known gap, intentionally not solved here**: this proxy only exists in `vite dev`. A production deployment of the built static assets (`vite build`'s `dist/`) needs an equivalent reverse proxy in front of both processes, or the backend needs CORS enabled for the frontend's origin — neither is built in Step 4, since no deployment work is in scope. See [MVP_SCOPE.md](./MVP_SCOPE.md).

## TD-22: No login screen — the frontend never sends an actor identity at all
**Decision**: the frontend's `apiClient` never sets an `x-user-id` header. Every request relies on the API's own documented fallback to a bootstrap system user (TD-19).
**Alternatives considered**: a lightweight "who are you" text field in Settings that sets a header value for subsequent requests.
**Why not**: `x-user-id` must match an existing user's server-side id (a UUID) or the API returns 401 — and there is no endpoint to list or create users (out of scope for Step 3's API surface). A free-text field would either be decorative (never actually validated against anything real) or broken (guaranteed 401 for any value a developer would plausibly type). Building a fake "looks like a login" control that can't authenticate anything would be exactly the "fake enterprise authentication system" the brief warns against. Doing nothing, and stating the limitation plainly in `SettingsPage.tsx`, is the honest MVP choice — consistent with TD-19's existing boundary.
**Superseded by TD-30 (Step 6)**: a real login screen now exists, because `POST /auth/register`/`/auth/login` now exist to authenticate against — the objection above (nothing real to validate against) is exactly what changed.

## TD-23: Board columns render as a single horizontally-scrolling row at every screen width, not a responsive layout switch
**Decision**: `KanbanBoard.tsx` uses one CSS layout (flex row, `overflow-x: auto`, scroll-snap) for desktop, tablet, and phone — no separate mobile layout (tabs, an accordion, a fully stacked column list).
**Alternatives considered**: status tabs on narrow viewports (show one column at a time, switch via a tab bar); fully stacked columns (all five, one below another, phone-scrollable vertically).
**Why horizontal scroll**: it's the simplest option that keeps every column reachable in a single, familiar gesture (a horizontal swipe) without adding new UI (tabs) or forcing a long vertical scroll through five stacked lists to see DONE. One layout, one component, no breakpoint-specific logic to keep in sync — directly serving the brief's "choose the simplest usable solution."

---

## Step 5 decisions (task cancellation)

## TD-24: Cancellation is a domain command (`Orchestrator.requestCancellation`), reachable only through `POST /tasks/:id/cancel` — never a status write
**Decision**: `TaskService.cancelTask()` does nothing but call `Orchestrator.requestCancellation(taskId, actorId)`; there is still no `PATCH /tasks/:id` accepting a client-supplied `status`, and cancellation does not get one either.
**Why**: this is the same principle TD-18 already established for every other lifecycle transition (answering input, accepting a review) — the API surface exposes named actions with their own legality rules enforced by the state machine, never a generic "set this field" escape hatch a client could use to jump to an arbitrary state. See [API.md](./API.md) and [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Cancellation."

## TD-25: CANCELLED gets the same "conditional extra column" treatment as FAILED — not one of the five fixed board columns
**Decision**: `CONDITIONAL_BOARD_COLUMNS` (`web/src/lib/statusMeta.ts`) now lists both `FAILED` and `CANCELLED`; `KanbanBoard.tsx`'s existing mechanism (append a column only if at least one task currently has that status) is reused unchanged for both.
**Alternatives considered**: a dedicated sixth fixed column; a separate "archived/cancelled" view outside the board entirely (per Step 5 instructions §16, which explicitly raised this option).
**Why not a fixed column**: the board is meant to answer "what needs my attention," and a task a developer deliberately stopped needs exactly zero further attention — a permanent column for it would be visual noise in the common case where nothing has ever been cancelled. A separate archived view was considered and rejected as more UI than the MVP needs to build and maintain for what is expected to be a low-volume status; the existing conditional-column mechanism already solves "don't lose it, don't clutter the common case" with no new code.

## TD-26: Cancellation is two-phase — persisted intent, then in-process interruption — because the API and the worker are different processes
**Decision**: `POST /tasks/:id/cancel` never itself terminates anything. For a `WORKING` task it only performs an atomic, guarded database write (`cancel_requested_at`/`cancel_requested_by` on the task row). The actual process termination happens inside `Orchestrator.withCancellation` — a per-execution `AbortController` plus a `setInterval` watcher (default 300ms, `cancellationPollIntervalMs`) that polls `TaskRepository.isCancelRequested` and calls `.abort()` the moment it sees the flag — running only inside whichever `executeTask()` call is actually driving that task, which per TD-16 is only ever the worker process.
**Alternatives considered**:
- *Have the API process kill the child process directly*: impossible in general — TD-16 already established that the API and worker are separate OS processes (so the API request handler has no reference to a child process object living in the worker's memory), and this remains true even before considering that a future deployment could run multiple worker processes/machines.
- *A message broker (Redis pub/sub, etc.) to push a "cancel now" signal from the API to the worker*: real infrastructure for a problem the existing polling architecture already solves — TD-12 deliberately chose lease-based polling over a broker, and this step was explicitly told to keep that decision, not introduce one now for a single new feature.
- *A shorter/longer poll interval*: 300ms was chosen as "fast enough to feel immediate, cheap enough to run constantly" (one indexed single-column SQLite read) — not derived from measurement, easy to change in one place (`OrchestratorConfig`) if it ever needs tuning.
**Why this is safe**: the watcher and the `AbortSignal` it drives are scoped to one `executeTask()` call for one task — no shared global state, no way for cancelling task A to affect task B or another task's child process (see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) and Step 5 instructions §24). The same `AbortSignal` is threaded through the Implementer/Reviewer invocation (`CodingEngine.run()`, extended with a documented cancellation contract — see `EngineCancelledError`), the validation runner (build/test/lint/typecheck child processes), and workspace provisioning (`git clone`) — every long-running child process this execution can spawn, not just the coding engine. Each terminates its own process gracefully (SIGTERM, bounded grace period via the shared `terminateGracefully` helper, then SIGKILL) — see `src/process/terminate-gracefully.ts`.

## TD-27: No new `CancellationRequest` entity — two nullable columns on `tasks`, reusing the existing event log for everything else
**Decision**: cancellation adds exactly two columns to the existing `tasks` table (`cancel_requested_at`, `cancel_requested_by`) and five new `TaskEventType` values (`CANCEL_REQUESTED`, `EXECUTION_CANCELLED`, `WORKSPACE_CLEANUP_STARTED`, `WORKSPACE_CLEANUP_COMPLETED`, `TASK_CANCELLED`) — no new database table.
**Why**: consistent with TD-13's reasoning (why `ValidationResult`/`ReviewResult` aren't their own tables) — a cancellation has no independent lifecycle of its own; it's a property of one task's one terminal outcome. The existing append-only `TaskEvent` log already gives full audit history of what led up to cancellation without a new entity that would just duplicate what the event log already records.

## TD-28: The race-resolution policy is one rule, not eight — "cancellation preempts unstarted work, never completed work"
**Decision**: every cancellation race in [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md)'s table (agent finishes as cancel is clicked, validation finishes mid-request, reviewer approves at the same instant, worker claims a TODO task as cancel arrives, etc.) resolves from the same single principle: the Orchestrator only checks for pending cancellation at loop boundaries — before starting the next unit of work — never in the middle of interpreting a step's result that has already come back. A step that finishes normally always gets to have its result acted on.
**Alternatives considered**: per-case bespoke handling (e.g., "if the Reviewer JUST approved, roll it back specially"); cancelling as soon as technically possible at every point, including retroactively discarding a just-completed, just-approved change.
**Why one rule beats eight**: the brief asks for deterministic, non-contradictory behavior across seven distinct named race scenarios (Cases A–G) — enumerating bespoke logic for each would be both more code and more ways for two cases to accidentally disagree with each other. A single "never discard completed work, always honor pending work" rule, applied uniformly at every loop boundary already present in `runWorkingEpisode` (Step 2's design, unchanged), produces correct, explainable behavior for all seven without any case-specific code. The one deliberate exception called out inline (no boundary check between "Reviewer approved" and the `REVIEW` transition) is this same rule applied consistently, not a special case of it.

---

## Step 6 decisions (real authentication & authorization)

## TD-29: Server-side sessions in an HttpOnly cookie, not a JWT
**Decision**: `AuthService` issues an opaque, random 256-bit token on login/register, stores only its SHA-256 hash server-side (`sessions` table), and sets the raw token as an HttpOnly, `SameSite=Lax` cookie. No JWT anywhere in the system.
**Alternatives considered**: a signed JWT (in an HttpOnly cookie, or — explicitly warned against by the brief — in `localStorage`).
**Why not JWT**: a JWT needs a signing secret to exist at all — one more thing that must come from environment/configuration and never be committed, for a capability this design doesn't need. Revoking a single JWT before its expiry needs a blocklist (defeating half the reason to use a stateless token in the first place); this design's "revoke" is `DELETE FROM sessions WHERE ...` — logout in one statement, no blocklist, no exceptions to reason about. A `localStorage` JWT is also unconditionally readable by any script on the page — one XSS bug anywhere in the app (or a compromised dependency) becomes a stolen, directly replayable session; an HttpOnly cookie is never exposed to page JavaScript at all.
**What this doesn't need, as a direct consequence**: `SESSION_SECRET` (or any signing/verification secret) — there is no such secret in this system's configuration, and none should be added later without first re-reading this entry to ask whether it's actually necessary.

## TD-30: A real login screen replaces the Step 4 "no login" decision (TD-22)
**Decision**: `LoginPage.tsx`, one page with a sign-in/create-account mode toggle, gated by `RequireAuth` in front of every other route.
**Why now, not before**: TD-22 declined to build a login UI specifically because there was nothing real to authenticate against (`x-user-id` was a trusted placeholder, not a credential) — building a form in front of that would have been decorative. `POST /auth/register`/`POST /auth/login` now exist and do real work, so the objection is gone.
**Why one page, not two routes**: the sign-in and create-account forms differ by exactly one field (name) and share every other concern (email, password, submit, error display) — a mode toggle avoids duplicating that scaffolding across `/login` and `/register` routes for no benefit.

## TD-31: `crypto.scrypt` (Node built-in) for password hashing, not an npm package
**Decision**: `src/auth/password.ts` hashes passwords with Node's built-in `crypto.scrypt`, not `bcryptjs`, `bcrypt`, or `argon2`.
**Alternatives considered**: `bcrypt`/`argon2` native-binding packages (the most commonly recommended choices); `bcryptjs` (a pure-JS bcrypt port with no native build step).
**Why not the native packages**: `bcrypt`/`argon2` require compiling a native addon at install time — real risk in a sandboxed or constrained build environment (this one included), and one more thing that can fail on a contributor's machine for reasons unrelated to this codebase.
**Why not `bcryptjs`**: works, but adds a dependency for something Node already ships a vetted implementation of. `scrypt` (RFC 7914) meets the same OWASP password-storage bar as bcrypt/argon2id — memory-hard, tunable cost factor — with zero new dependencies, consistent with this codebase's existing pattern of preferring Node built-ins over npm packages where one exists and is adequate (`node:sqlite` in TD-11, `node:test` throughout). The salt is random per password (`crypto.randomBytes(16)`), and verification uses `crypto.timingSafeEqual`, not `===`, so comparison time doesn't leak how much of the hash matched.

## TD-32: Unauthorized access returns 404, not 403
**Decision**: `assertProjectAccess`/`assertTaskAccess` (`src/application/authorization.ts`) raise the same `NotFoundError` — and therefore the same `404` — whether a project/task doesn't exist or exists but belongs to someone else.
**Alternatives considered**: `403 Forbidden` for "exists but not yours," reserving `404` for "genuinely doesn't exist."
**Why 404**: a `403` response *confirms a resource with that ID exists* to a caller who has no business knowing that — an attacker (or a curious user) enumerating IDs could map out how many projects exist and roughly when they were created just from the pattern of 403s vs 404s, without ever seeing their contents. Returning an identical 404 for both cases gives an unauthorized caller nothing to distinguish "wrong ID" from "someone else's real project." The same choice GitHub makes for private repositories.
**Cost accepted**: a legitimate caller who mistypes an ID gets the same "not found" as one who's genuinely unauthorized — slightly less informative, judged worth it for the leak it closes.

## TD-33: A hand-rolled cookie parser, not the `cookie-parser` package
**Decision**: `src/api/cookies.ts` parses the `Cookie` request header with a ~10-line function; Express's own `res.cookie()` (already built in) handles setting the response cookie, so no new dependency was needed for either direction.
**Why not `cookie-parser`**: it's a small, well-maintained package, and would have been a reasonable choice — but this app only ever needs to read one specific cookie (the session token), and Express has no built-in *incoming*-cookie parsing (only outgoing, via `res.cookie()`) apparently by oversight of the framework's own scope, not because it's hard. A dependency for a two-line `split(";")` loop didn't clear this codebase's bar (see TD-17, TD-20, TD-31 for the same recurring judgment call) — revisit if cookie handling ever needs to get more sophisticated (signed cookies, more than one cookie, etc.) than this MVP does.

## TD-34: `User -> owns -> Project -> tasks` — no `Task.ownerId`, no RBAC, no organizations yet
**Decision**: the only access-control field in the schema is `Project.ownerId`. Tasks have no owner of their own; every task-scoped check resolves the task's project and checks *that* project's owner.
**Alternatives considered**: also stamping `Task.ownerId` (redundant with the project's, since a task can't move between projects); building a `project_members` join table with roles now, ahead of needing more than one member per project.
**Why not `Task.ownerId`**: a task's project never changes after creation, so a second copy of the same fact would only be a place for the two to silently disagree if either write path forgot to keep them in sync. One `ownerId`, one place it's checked (`assertTaskAccess` resolves through the project), is simpler and can't drift.
**Why not RBAC/organizations now**: the brief explicitly scopes this step to single-owner projects, not team access — building a members-with-roles model for a product with no second member to add to any project yet is exactly the kind of ahead-of-need infrastructure this codebase's other decisions (TD-19, TD-29) have consistently avoided. The one-column model is deliberately positioned to grow into one later: `Organization -> members (roles) -> Project` is a new table plus backfilling `ownerId` as each project's sole initial member, not a rewrite of the choke points (`assertProjectAccess`/`assertTaskAccess`) every route already funnels through.

## TD-35: Login/register rate limiting is in-memory and per-process — a documented gap, not a Redis integration
**Decision**: `src/api/rate-limit.ts` is a plain `Map`-backed fixed-window counter (10 attempts / 15 min / IP+email), living entirely in the API process's memory.
**Why not a shared store (Redis, etc.)**: this step's instructions explicitly say not to introduce Redis; a single API process (the only deployment this MVP runs — see TD-16) has no cross-process state to share in the first place, so a shared store would be complexity with no current payoff.
**What this doesn't solve, on purpose**: the moment more than one API process runs (horizontal scaling), each has independent counters — an attacker distributing attempts across processes/instances effectively multiplies the limit. Documented in [AUTHENTICATION.md](./AUTHENTICATION.md) "Rate limiting" as a known limitation with a clear trigger for when it needs solving (going multi-process), not left implicit.

## TD-36: A GitHub Personal Access Token, not a GitHub App, is the Step 7 credential mechanism
**Decision**: `POST /integrations/github` accepts a user-supplied PAT, verified against the real API and stored encrypted — one per user.
**Alternatives considered**: a GitHub App with installation tokens (fine-grained, GitHub-scoped to specific repos, centrally revocable) — the architecturally preferred mechanism for a production multi-tenant product.
**Why not a GitHub App now**: it requires registering a GitHub App and hosting a public OAuth/installation callback URL, neither of which exists for this MVP's deployment story (single operator-run instance, no public app registration — see [MVP_SCOPE.md](./MVP_SCOPE.md)). Building one now would be infrastructure ahead of a need this MVP doesn't have yet.
**Cost accepted, made explicit rather than hidden**: a PAT's scope is whatever the user granted at creation time (the platform can't narrow it further); revoking access fully requires the user to also revoke/rotate the token on GitHub's side, not just disconnect in the platform. See [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) "Credential mechanism" for the full tradeoff. Swapping in a GitHub App later is a new `SourceControlProvider` implementation, not a rewrite — see TD-37.

## TD-37: `SourceControlProviderRegistry`, mirroring `CodingEngineRegistry` exactly
**Decision**: introduced a registry class identical in shape to the existing coding-engine registry, so `Project.sourceControlProvider` selects `GitHubSourceControlProvider` or `LocalGitSourceControlProvider` the same way `Project.codingEngine` already selects a coding engine.
**Why not a single hardcoded provider on the Orchestrator** (the Step 1–6 shape): Step 7 needed a second real implementation (GitHub) to coexist with the local-git one already used by tests and local dev — a single injected provider can't do that per-project. Reusing the coding-engine registry's exact pattern (rather than inventing a different provider-selection mechanism) keeps the codebase's two provider-selection stories mechanically identical, so a reader who understands one understands the other for free.
**Consequence for testing**: the same mechanism that lets `github` resolve to a real provider in production lets a test's `buildPlatform()` call register a deterministic `FakeSourceControlProvider` under the same key (see `additionalSourceControlProviders` in `src/platform.ts`) — the Step 7 test suite needs no live GitHub credential as a result.

## TD-38: Commit/push/PR-open became a required gate, not a best-effort side effect — fixing a latent Step 1–6 bug along the way
**Decision**: `Orchestrator.prepareChanges` now throws (→ task FAILED) on a commit or push failure, and PR creation (`ensurePullRequest`) is called synchronously before the `gates_passed` transition, also throwing on failure.
**What this replaces**: the pre-Step-7 `prepareChanges` caught and swallowed every commit/push error as "non-fatal," and `openPullRequest` was defined in the `SourceControlProvider` interface since Step 2 but the Orchestrator never actually called it. A task could reach `REVIEW` having never pushed its changes anywhere and with no PR — a real functional gap, not an intentional simplification, discovered while implementing Step 7's explicit requirement that these be gates.
**Why a gate and not a warning**: `REVIEW` is presented to the developer as "ready for your review" — a REVIEW state with no pushed branch or PR behind it would be actively misleading, not just incomplete. See [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) "Commit / push as a real gate."
**No new `TaskStatus`**: the existing `infra_failure` → `FAILED` transition (already used for workspace/agent failures) covers this too — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md).

---

## Step 8A decisions (OpenCode coding engine integration)

## TD-39: OpenCode is an interchangeable coding execution engine, not an agent role
**Decision**: `OpenCodeAdapter` implements the existing `CodingEngine` interface (`key: "opencode"`). The Orchestrator remains completely agnostic of the underlying engine, and the two-agent-role model (`implementer` and `reviewer`) is preserved unchanged.
**Alternatives considered**: create an "OpenCodeAgent" role or specialize the Orchestrator with OpenCode-specific workflows.
**Why not**: agent roles define *what judgment/responsibility* is being executed (independent review vs implementation), while coding engines define *how the underlying model/CLI tool* interacts with workspace files. Keeping OpenCode behind `CodingEngine` ensures that switching between OpenCode, Claude Code, and future engines (Aider, local models, etc.) requires zero changes to core orchestration, state transitions, validation gates, or GitHub delivery. See [CODING_ENGINE.md](./CODING_ENGINE.md).

## TD-40: Transient provider-failure retries live inside `OpenCodeAdapter.run()`, not the Orchestrator
**Decision**: when `opencode run` exits non-zero because the underlying model provider returned a transient error (Gemini/OpenAI/etc. 429/500/502/503/504, or an explicit `isRetryable: true`), `OpenCodeAdapter.run()` retries with bounded exponential backoff + jitter entirely on its own, beneath the `CodingEngine` interface. `Orchestrator.runAgent()` is unchanged — it still awaits exactly one `engine.run()` call and creates exactly one `AgentRun` row per invocation.
**Bug this fixes**: before this decision, a transient Gemini 503 ("high demand, retry later," explicitly marked `isRetryable: true` by the provider) was converted straight into a permanent `EngineExecutionError` on the first non-zero exit, with no retry anywhere in the system — `AGENT_FAILED` → `TASK_FAILED` on a purely transient outage.
**Alternatives considered**: (a) retry inside the Orchestrator's `runAgent`/self-fix loop; (b) retry inside a generic wrapper around the `CodingEngineRegistry`.
**Why not the Orchestrator**: the self-fix loop (`maxSelfFixAttempts`) already means something specific and user-visible — "the AI tried to fix a validation failure N times" — visible in `TaskRecord.selfFixAttempts` and the task report. Conflating "the model provider had a 5-second blip" with that counter would make self-fix attempts an inaccurate proxy for actual coding attempts, and would require the Orchestrator to understand engine-specific error shapes (Gemini's `isRetryable`/`statusCode`), breaking the vendor-neutral boundary TD-39 just established.
**Why not a generic registry-level wrapper**: would apply identical retry policy to every engine (including `ClaudeCodeAdapter` and `FixtureCodingEngine`) whether or not their failure modes are actually transient-classifiable the same way; per-adapter retry (only `OpenCodeAdapter` has one, for now) is more honest about what's actually been implemented and tested.
**Why this doesn't risk duplicate work**: retries happen strictly *before* `engine.run()` resolves — every downstream step that could duplicate something (workspace/branch provisioning, `prepareChanges`'s commit/push, `ensurePullRequest`) only runs *after* it resolves, so a retry can never produce a second branch, commit, or PR. See `tests/opencode-adapter.test.ts` test 23 for this asserted directly (exactly one `AgentRun`/`AGENT_FAILED` after retry exhaustion, no `BRANCH_PUSHED`/`PULL_REQUEST_CREATED`).
**Classification is deliberately conservative**: an error that doesn't match a recognized transient-provider signature (auth failures, invalid-model/malformed-request errors, or any unstructured exit-1 with no parseable error JSON) is never retried — see [CODING_ENGINE.md](./CODING_ENGINE.md) "Retry behavior" for the full table.

