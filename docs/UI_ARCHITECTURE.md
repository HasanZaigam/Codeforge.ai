# UI Architecture

The web dashboard (`web/`) is the first user-facing layer of the platform. It consumes the existing HTTP API ([API.md](./API.md)) exclusively — it has no direct access to the database, the Orchestrator, workspaces, git, or the coding engine. See [ARCHITECTURE.md](./ARCHITECTURE.md)'s layer boundary: `Web UI → Application/API → Domain → Orchestrator → Execution infrastructure`.

Tech stack decision (React + Vite + TypeScript, no CSS framework, no global state library) is recorded in [TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-20.

## Product framing (read before changing any screen)

Per the Step 4 brief: the user should feel they delegated a task to an autonomous developer, not that they're operating a workflow engine. Concretely, that means:
- The board shows only what's needed to decide "should I open this?" — title, description, current activity. No logs, no internal event names, no agent/gate terminology.
- `REVIEW` is never framed as "definitely correct" — see `ReportPanel.tsx`'s explicit "awaiting your review" language, matching [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md)'s own stance that evidence-based completion isn't a guarantee.
- `NEEDS_INPUT` is the one place technical detail is front and center, because that's exactly when the developer needs it to make a decision.

## Screen structure

```
/login                  Public — sign in / create account (see "Authentication" below)
/                       Projects — list, connect a new project             \
/projects/:projectId    Project board — Kanban (BACKLOG/TODO/WORKING/NEEDS_INPUT/REVIEW/DONE), create task  |  all behind
/projects/:projectId/backlog[/:itemId]   Backlog (Phase 4A) — list + detail; backlog items are NOT tasks
/tasks/:taskId          Task details — header, NEEDS_INPUT panel (if applicable), activity, result   |  RequireAuth
/settings               Account info, GitHub connection status (connect/disconnect)        /
```

Navigation is exactly two links (`AppShell.tsx`): **Projects** and **Settings**, plus a current-user indicator and **Log out**. No sidebar, no nested menus — per the brief's "do not create a large navigation system." `AppShell` (and therefore its nav) is never rendered on `/login` — see "Authentication" below.

## Component boundaries

```
web/src/
  auth/            AuthContext.tsx (session state + login/register/logout), RequireAuth.tsx (route guard),
                   auth-events.ts (tiny pub/sub the API client uses to report an expired session).
  api/            One HTTP client (client.ts) + typed, resource-scoped modules (auth.ts, projects.ts, tasks.ts,
                   humanInput.ts, integrations.ts — GitHub account connect/status/disconnect, added Step 7).
                   Every network call in the app goes through these — no component calls fetch() directly.
  hooks/           One hook per data need (useProjects, useProject, useProjectTasks, useTask, useTaskEvents,
                   useTaskInput, useTaskReport) plus the generic usePolling primitive they're built on.
  components/      layout/ (AppShell), common/ (StatusBadge, LoadingState, ErrorState, EmptyState, Dialog),
                   projects/ (CreateProjectDialog — provider-aware since Step 7), settings/ (GitHubConnectDialog),
                   board/, task-detail/ — grouped by the screen that owns them, not by "atoms/molecules."
  pages/           One component per route, composing hooks + components, including LoginPage.tsx. Pages hold
                   layout/composition only — no business logic (see "State handling" below).
  lib/              Pure, stateless helpers: eventLabels.ts (event type → human text), statusMeta.ts
                   (status → label/color), time.ts (relative/absolute/duration formatting).
```

No component reimplements a backend rule. `statusMeta.ts` decides how a status is *displayed*; it never decides what status a task *is* — that's the API's answer, always. `eventLabels.ts` is presentation-only translation of an enum the backend already computed and returned.

## API integration

- **One client, one error shape**: `api/client.ts` wraps `fetch`, parses the `{error:{code,message}}` envelope from [API.md](./API.md), and throws `ApiError` (server-returned) or `NetworkError` (request never reached the server) — the only two error types the rest of the app needs to handle.
- **Resource-scoped modules**: `authApi`, `projectsApi`, `tasksApi`, `humanInputApi` — each a thin object of typed functions mapping 1:1 to API.md's endpoints. Adding an endpoint means adding one function here, not touching every component that might need it.
- **DTO types are hand-kept in sync with API.md** (`api/types.ts`), not imported from the backend package. This is a deliberate decoupling, not an oversight — see TD-20.

## Authentication (Step 6)

- **`AuthContext`** (`auth/AuthContext.tsx`) is the single source of truth for "who's signed in," holding `user: UserDTO | null | undefined` — `undefined` specifically means "session not resolved yet," distinct from `null` ("resolved, not signed in"). Nothing else in the app calls `authApi.me()`.
- **Session bootstrap**: `AuthProvider` calls `GET /auth/me` exactly once on mount. `RequireAuth` (`auth/RequireAuth.tsx`) renders a loading state while `user === undefined`, so the private dashboard (or the login screen) never flashes before the real answer is known — see Step 6 instructions §20.
- **`RequireAuth`** wraps every route except `/login` (see App.tsx) — `user === null` redirects to `/login` via `<Navigate>`, preserving the original destination (`location.state.from`) so a deep link works correctly after signing in.
- **Expired sessions**: the API client (`api/client.ts`) emits an internal event (`auth/auth-events.ts`) on any 401 from a route other than `/auth/*` itself; `AuthContext` listens and clears `user`, which sends `RequireAuth` straight to `/login` on the next render — no polling `/auth/me` repeatedly to detect this.
- **Logout** is a real server round-trip (`POST /auth/logout`), not just clearing local state — `AppShell`'s logout button awaits it before navigating, so the cookie is actually revoked server-side first.
- **Login/register is one page, one component** (`LoginPage.tsx`) with a mode toggle, not two routes — per the brief's "keep login simple," and because both forms differ by exactly one field (name).

## State handling

- **No global state library.** Server state (projects, tasks, events, reports) lives in the hooks above, scoped to whatever component tree needs it — React's own state and props are sufficient at this app's size (four pages, a handful of dialogs).
- **The backend remains the source of truth for task state**, always. No component ever computes or overrides a task's `status`; the frontend only renders what `GET /tasks/:id` returns and triggers the two writes the API allows (create task, submit input) — see [API.md](./API.md) "Task lifecycle semantics."
- **Optimistic-but-honest updates**: creating a task inserts the returned `TaskDTO` (already `BACKLOG` — every task is created into `BACKLOG`, from the real API response — not fabricated) into the board immediately via `useProjectTasks`'s `addOptimisticTask`, so the developer isn't stuck watching a spinner for a background poll to catch up. The next poll reconciles naturally.

## Responsive strategy

One layout serves desktop, tablet, and phone — no separate mobile app or mobile-only routes (see Step 4 brief §3, §21).
- **Board**: a responsive CSS grid (`repeat(auto-fit, minmax(...))`) that shares the container's actual width evenly across however many status columns exist, wrapping to additional rows once columns would drop below a readable floor — not fixed-width columns in a horizontally-scrolling row. The original all-viewport horizontal-scroll design (see TECHNICAL_DECISIONS.md TD-23) fixed each column at 280px regardless of container width, which meant five columns (1400px+) never actually fit inside `--max-content-width` (1200px) — REVIEW/DONE were pushed off-screen on ordinary desktop widths, not just narrow ones. `overflow-x: auto` remains on `.board` as a defensive fallback (an unusually high column count on a narrow viewport), never the primary mechanism.
- **Dialogs** (create project/task): a bottom sheet on narrow viewports, a centered modal from `640px` up — one component, one media query.
- **Task detail**: single-column content at all widths; nothing in it depends on horizontal space, so it needs no responsive variant at all.
- **FAILED and CANCELLED tasks**: neither is one of the fixed board columns. `FAILED` is rare (an infrastructure failure) — `KanbanBoard.tsx` adds it as a conditional extra column only once at least one task actually has that status, keeping the common case free of an always-empty column. `CANCELLED` is treated differently, not the same way: it is never added as a board column at all, conditional or otherwise — a cancelled task simply doesn't appear on the board (it stays fully visible via its own task detail page, per TASK_LIFECYCLE.md "Cancellation"). See TECHNICAL_DECISIONS.md TD-25 for why FAILED and CANCELLED are treated differently here.

## Polling strategy

No WebSockets — the brief is explicit not to introduce one without a real need, and a small, single-developer dashboard doesn't have one yet. `hooks/usePolling.ts` is a generic, **self-rescheduling** poll (a `setTimeout` chained after each response resolves, not `setInterval`) — mirroring the same principle the backend worker already uses (`src/worker/worker.ts`): never let a slow response overlap the next request.

Per-hook polling stops on its own once there's nothing left to watch:

| Hook | Polls while | Stops at |
|---|---|---|
| `useProjectTasks` (board) | at least one task is `TODO` or `WORKING` | every task is `NEEDS_INPUT`/`REVIEW`/`DONE`/`FAILED`/`CANCELLED` |
| `useTask` (detail) | task is `TODO` or `WORKING` | `NEEDS_INPUT`/`REVIEW`/`DONE`/`FAILED`/`CANCELLED` |
| `useTaskEvents`, `useTaskReport` | driven by the same active/inactive signal as `useTask` | same |
| `useTaskInput` | one-shot fetch when the task becomes `NEEDS_INPUT` | never polls — nothing changes until the developer submits an answer |
| `useProjects`, `useProject` | never (one-shot + manual refetch) | project config doesn't change from background execution |

`NEEDS_INPUT` intentionally stops polling: nothing will change there until the developer acts, and acting (submitting an answer) immediately re-fetches the task, which then resumes polling if it moved to `WORKING`. Interval: 3000ms, chosen as a reasonable "feels live without hammering a single local API process" default — not derived from any load testing, and easy to change in one place per hook if it needs to.

`CANCELLED` is terminal for polling purposes exactly like `DONE`/`REVIEW`/`FAILED` — `isActiveStatus()` (`useTask.ts`) already only returns true for `TODO`/`WORKING`, so no hook needed a special case added for Step 5; a task that transitions to `CANCELLED` simply stops matching `isActiveStatus` on the very next poll and polling ends there. While a `WORKING` task has a cancellation pending but not yet confirmed (`cancelRequested: true` on the `TaskDTO`), it is still `WORKING`, so polling correctly continues — the developer sees "Cancelling…" update live until the task actually reaches `CANCELLED`.

`usePolling` also pauses while the browser tab is hidden (`document.hidden`, via the Page Visibility API) and immediately refetches when the tab becomes visible again — a small, unconditional efficiency measure, not a feature toggle.

## Error and loading/empty states

Every hook exposes `{data, error, loading}`; every page renders exactly three states in order — loading (`LoadingState`), error (`ErrorState`, with retry where the action is a page-level fetch), then success/empty (`EmptyState` when the collection is empty). No component ever renders a raw `Error` message or stack trace — `ApiError`/`NetworkError` messages are already human-safe (from the API's own `{error:{message}}` or a fixed "could not reach the server" string).

## What was deliberately not built (see also MVP_SCOPE.md)

- **No password reset, email verification, or "my other sessions" screen.** Real login/register/logout exist as of Step 6 (see "Authentication" above and [AUTHENTICATION.md](./AUTHENTICATION.md) "Known limitations") — these specific pieces are the documented remaining gaps, not a missing login flow.
- **No per-project task count on the Projects list.** `GET /projects` doesn't return aggregate counts, and fetching every project's task list just to show a number would be an N+1 request pattern for a cosmetic detail — `ProjectCard` shows `—` instead of fabricating or over-fetching.
- **No file-list in the report.** `TaskReport` exposes `filesChanged` as a count, not filenames (see [API.md](./API.md)) — the report panel shows the count and never invents filenames to match the brief's illustrative mockup.
- **No per-test-case counts** ("42 passed") — the backend only reports pass/fail per named check (build/test/lint), not per-test-case results (see TECHNICAL_DECISIONS.md TD-13). The report shows check-level pass/fail instead of fabricating a test count.

## Backlog *(Phase 4A)*

A **Backlog** tab sits between Tasks and Workspace (`ProjectBacklogPage`, `BacklogItemPage`, `components/backlog/*`, `hooks/useProjectBacklog|useBacklogItem`, `lib/backlogLabels.ts`). The product distinction is the point of the screen: every item is labelled *"Backlog item — not an executable task"*; AI output is always presented as a **proposal**, with the platform's own checks (e.g. "verified in repository" / "not found in repository listing") shown separately from the model's claims; and **Approve** and **Convert to task** are two explicit, separate buttons — converting produces a task in Backlog on the Tasks tab, which the user still has to start there. Actions are driven strictly by server-reported status; server 409s (`ANALYSIS_IN_PROGRESS`, `CONVERSION_IN_PROGRESS`, `INVALID_OPERATION`, `DUPLICATE_BACKLOG_REFERENCE`) are shown verbatim. Analysis is **asynchronous** — `Analyze` only enqueues a job (no long HTTP request waits for the model), and the analysis panel renders the job (`analysisJob`): *Queued — waiting for a worker*, *Running — attempt n of m* (model/provider), *Retry scheduled* (cause, next attempt time), *Failed* (category, reason, nothing accepted), *Cancelled*, with a **Cancel analysis** button while queued/running. A refresh only GETs. Polling (3 s) runs only while an item is `ANALYZING` or its proposal is `CONVERTING`. Deliberately not built: filters, drag-and-drop, kanban, bulk actions. Details: [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md).

**Evidence and usage *(Phase 4A.2)*.** The analysis panel is split into three labelled regions — *AI analysis — what the model believes (a proposal, not verified)* (incl. the AI's claims), *Platform evidence — what CodeForge actually checked* (listing state, files read/skipped, evidence lines with code excerpts) and *Evidence assessment — claim vs evidence* (per claim: "AI says" | "Platform checked" | a status badge that always carries its word, the platform's reason, and what it establishes). A contradicted claim is visually prominent; a `confidenceOverridden` notice reads "Confidence does not override evidence"; static help says existence is not correctness. *Model usage* lists only reported (non-null) token counts and shows an estimated cost only when one exists, labelled with its source as an estimate — never `$0` for unknown. A QUEUED job shows *Queued…* (not an "Analyzing…" spinner). Proposals show an *Investigate first* banner and the claim assessments. Verified in a live browser run (see [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md) §13).

**Index and usage roll-up *(Phase 4A.3)*.** Under the context line the analysis states how files were chosen — *"Files chosen using the repository index @ abc1234 …"* with a collapsible "Why these files" (per-file reasons), or *"Files chosen by file name only — <why the index was not used>"*, and flags a partial index. Index-derived `SYMBOL_MATCH` appears as platform evidence (never among the AI's claims); a behaviour claim's planned check shows as *"test check: not run"* with the platform's reason — never as passed. The task report gains a compact **Usage** section (`UsageSummary`): only reported token totals (never `0` for unreported), the engine's cost estimate labelled with its source (and how many runs reported none), and a per-run list. No analytics dashboard, no billing UI, no repository browser.

**Reconciliation and usage status *(Phase 4A.4)*.** Inside the *Evidence assessment* region a separate **Reconciliation** block (`ReconciliationSection`) states, per claim, the platform's conclusion — *"Implementation evidence conflicts with the reported absence"* (strong/weak), *"Related code may conflict…"*, *"Not resolved by the evidence"*, or *"Verified by a platform check bound to this claim"* — with the platform's explanation, and always a line *"Behavior verification: not verified — no platform check bound to a claim was run."* plus the revision reconciled and any ignored other-revision evidence. A *"Possibly already implemented (strong|possible)"* banner says explicitly that this does not mean the item is fixed. It never says "fixed". The proposal panel shows the same signal as an investigation banner. The task **Usage** section shows a *Usage status* line when totals are `partial` (lower bounds) and marks partial runs; nothing is shown for unavailable usage (never zero).
