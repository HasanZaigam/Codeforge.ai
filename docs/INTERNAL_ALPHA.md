# Internal Developer Alpha — Runbook

Target: ~5 internal developers, several projects/repositories, concurrent tasks, real GitHub and a real AI provider, on one host. This document is the operating manual, the safety boundary, the infrastructure assessment and the manual test plan. Design background: [ARCHITECTURE.md](./ARCHITECTURE.md), [DEPLOYMENT.md](./DEPLOYMENT.md), [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md), [PLATFORM_GAPS.md](./PLATFORM_GAPS.md).

## 1. Infrastructure assessment (is the current architecture enough?)

| Component | Today | Sufficient for 5 developers? |
|---|---|---|
| API | one Node process (`npm run start:api`) behind Caddy | Yes |
| Worker | 1–N Node processes sharing the DB (`npm run start:worker`), each capped by `WORKER_MAX_CONCURRENT_TASKS` (default 2) | Yes — 2 workers × 2 tasks is ample |
| Database | SQLite, WAL, `busy_timeout=5000`, `foreign_keys=ON` (`src/persistence/db.ts`) | **Yes, with the constraints below.** No Postgres migration is required for this alpha |
| Workspaces | plain directories `<WORKSPACES_ROOT>/<taskId>` (fresh clone per task) | Yes, but **never cleaned up automatically** (GAP-006) — budget disk |
| Frontend | Vite build served by Caddy, same origin as the API | Yes |
| AI provider | one model via OpenCode (`OPENCODE_MODEL`) | Yes; no fallback exists until a second real provider is registered |

**SQLite constraints (accepted, bounded).** TD-11 chose SQLite for a single-process MVP and named "multiple worker processes" as the trigger to revisit. The mitigation already in place is WAL + a 5 s busy timeout + single-statement atomic claims/fenced writes, exercised by `tests/concurrency.test.ts` (two connections, one file) and `tests/alpha-hardening.test.ts` (5 tasks × 2 workers). Rules for the alpha:
1. Exactly **one host**; API and every worker on the same machine, same local disk (never NFS/network storage — WAL and `O_EXCL` locks are not reliable there).
2. Keep workers ≤ 3 and `WORKER_MAX_CONCURRENT_TASKS` ≤ 3. Beyond that, SQLite's single-writer limit shows up as `SQLITE_BUSY` after 5 s — the signal to move to Postgres (post-alpha).
3. Start **one** process first on a fresh database (migrations are forward-only and not lock-protected; the second process then finds them applied).
4. Back up with `sqlite3 <DB_PATH> ".backup <file>"` (never a bare `cp` of the live file) — see DEPLOYMENT.md "Backup and restore". No backup job is installed for you: schedule one. Back up `CREDENTIAL_ENCRYPTION_KEY` separately; without it every stored GitHub token is unreadable.

Nice for later, not needed now: Postgres, per-task containers/sandbox (GAP-011), workspace reaper (GAP-006), a shared rate limiter, session rotation.

## 2. Prerequisites

- Node 22+, git, and the `opencode` CLI on PATH (or `OPENCODE_BIN_PATH`).
- A GitHub personal access token per developer with `repo` scope (entered in the UI; stored AES-256-GCM encrypted).
- A provider API key for the model in `OPENCODE_MODEL` (e.g. `GEMINI_API_KEY`) in the **worker's** environment.
- A writable, local, absolute directory for data (e.g. `/var/lib/codeforge`).

## 3. Configuration (internal alpha)

Copy `.env.example`; see its "INTERNAL ALPHA" block. With `NODE_ENV=production` the API **and** worker refuse to start unless these are set (clear `ConfigError`, never printing a secret):

```
NODE_ENV=production
DB_PATH=/var/lib/codeforge/platform.sqlite
WORKSPACES_ROOT=/var/lib/codeforge/workspaces
PROJECT_WORKSPACE_ROOT=/var/lib/codeforge/project-workspaces
CREDENTIAL_ENCRYPTION_KEY=<base64 32 bytes>
CODING_ENGINE=opencode
OPENCODE_MODEL=<model id>
GEMINI_API_KEY=<worker only>
COOKIE_SECURE=false      # ONLY if served over plain HTTP; true behind TLS
TRUST_PROXY=1            # behind Caddy
```

Single-origin requirement: API and UI must share one origin (Caddy, or the Vite proxy in dev). There is deliberately no CORS; a UI on another origin will be refused. Worker ids must be distinct (leave `WORKER_ID` unset, or unique per process) — the claim guard lets an owner re-claim its own task, so two processes sharing an id could double-execute.

## 4. Starting services

Development (three terminals):
```
npm run api          # http://localhost:3000
npm run worker
cd web && npm run dev  # http://localhost:5173, proxies /api
```
Production-style (systemd units in `deploy/systemd/`):
```
npm run build
npm run start:api
npm run start:worker      # repeat for a second worker; do not share WORKER_ID
```
API and worker are independent processes sharing only the database file and the two workspace roots. Restarting either never corrupts task state: a worker that dies mid-task leaves a lease that expires (default 5 min) and any worker resumes the task; an API restart holds no execution state.

Health: `GET /health` (liveness), `GET /health/ready` (does a real `SELECT 1`; 503 if the DB is unusable). Worker liveness: it logs `[worker] heartbeat todo=… working=… review=…` every 60 s — no heartbeat line for >2 min means the worker is hung or dead.
Operations: `GET /ops/summary` (authenticated, scoped to *your* tasks) returns task counts by status, queued/active, WORKING tasks with an expired lease (a dead worker), failures / infrastructure failures / retries / lease losses in the last 24 h, and provider health/cooldowns (no secrets).

## 5. First project (developer flow)

1. Register/login (UI). Passwords ≥ 10 chars; sessions last 7 days.
2. Settings → connect GitHub (paste PAT). Use "verify" to confirm it still works.
3. Create project: GitHub owner/repo (use *Validate repository*), coding engine `opencode`, and the build/test/lint/typecheck commands that work on a **clean clone** (run them once yourself first — GAP-009).
4. Project → Workspace → configure Project Context (architecture notes, conventions). It is *data*, never policy: it cannot change git behaviour, retries, or verification.
5. Create task (plain language, optionally branch mode/base), then **Start**.

## 6. Running a task

BACKLOG → (Start) TODO → WORKING (clone, implement, validate, self-fix ≤3, review, fix ≤2) → REVIEW (PR opened) → human review on GitHub → merge on GitHub → DONE (detected by polling). NEEDS_INPUT = the agent asked a question; answer in the UI. The task report shows: what changed (from `git`, not the AI's claim), validation outcomes, reviewer verdict and whether it was *static* or *executed*, bug-fix verification evidence, infrastructure retries and failure category, per-attempt model/provider, and the telemetry block (§10). A human merge decision is always required; nothing auto-merges.

## 7. Isolation & security audit summary (verified)

| Property | Status / evidence |
|---|---|
| Authentication | scrypt hashes, 256-bit random session token (only SHA-256 stored), HttpOnly + SameSite=Lax cookie, server-side logout, same 401 for unknown-user/bad-password, login+register throttled (10 / 15 min per ip+email) |
| Every `/projects`, `/tasks`, `/integrations`, `/ops` route needs a session | mounted behind `requireAuth` at router level — a new route is protected by default |
| Project/task authorization | every service method calls `assertProjectAccess`/`assertTaskAccess`; unauthorized = **404** (existence-masked). `tests/alpha-hardening.test.ts` sweeps all 22 project/task routes: 401 anonymous, 404 for another user, and the owner's data untouched |
| GitHub credentials | AES-256-GCM at rest; DTOs are status-only; token reaches only the platform's own `git` child via env, never `.git/config`/CLI/prompt/event/report |
| AI provider credentials | `ModelProfile` holds no secrets; keys live only in the worker's environment and are inherited by the `opencode` child (it needs them). **Known limit:** the child can run a shell, so an agent could print its environment. Mitigation added: any secret-named env value (`*KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL*`, ≥8 chars) is redacted from agent output before it is stored (`src/security/redact.ts`). This is defence in depth, not a sandbox (GAP-011): treat provider keys as scoped, low-limit, rotatable |
| Workspace isolation | task workspace path = `<root>/<server-generated taskId>`; project workspace has whitelist ids, resolve+prefix containment and a no-symlink policy |
| Errors | `{error:{code,message}}`; 500s are generic (no stack/paths); malformed JSON is now a 400 (was 500) |
| Multi-worker | atomic claim (`UPDATE … WHERE`), `lock_generation` fencing on every write, heartbeat lease, cancellation watcher — `tests/concurrency.test.ts`, `tests/recovery.test.ts`, `tests/infrastructure-retry.test.ts`, and the 5-developer/2-worker test |

Known, accepted alpha gaps: registration is open to anyone who can reach the server (keep it on a trusted network/VPN); no CSRF token (SameSite=Lax + same origin); rate limiting covers login/register only and is in-memory per API process; a task-dependency request naming another user's task id answers 409 rather than 404 (UUIDs, low risk); no session rotation/"log out everywhere".

## 8. Workspaces and disk

- Each task = one full `git clone` under `WORKSPACES_ROOT/<taskId>`. **Nothing deletes it** when a task ends (only cancellation cleans up) — GAP-006. Budget ~0.1–1 GB per task depending on repo size; 5 developers can accumulate tens of GB.
- A FAILED task's workspace may hold the only copy of unpublished work — do not blindly prune it. Safe to remove: workspaces of DONE/CANCELLED tasks (`sqlite3 $DB_PATH "select id from tasks where status in ('DONE','CANCELLED')"`, then `rm -rf $WORKSPACES_ROOT/<id>`), ideally with the API stopped or only for tasks completed > 1 day ago. Deleting a project leaves its directories on disk.
- After a worker crash the workspace is kept and reused on resume (a `ready` workspace is never re-cloned).
- Watch free disk; a full disk shows up as `workspace_provision_failure`.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Task stays TODO | Is a worker running (heartbeat line)? `GET /ops/summary` `queued`. Worker at its concurrency cap? Dependencies not DONE? Two workers sharing one DB path? |
| Task stuck WORKING | `/ops/summary` → `workingWithExpiredLease`>0 means the worker died: the lease expires (5 min) and the next worker tick resumes it — wait, don't edit the DB. A live worker renews every 60 s |
| Provider fails | Report → failure category (`provider_quota_exhausted`, `rate_limited`, `timeout`…) and *Infrastructure retries*. `/ops/summary` → `providers` shows cooldowns. With one model there is nothing to fall back to: wait for the cooldown/quota, then create the task again |
| Auth error to provider | `authentication_failure` is never retried; fix the key in the worker env and restart the worker |
| GitHub fails | Settings → verify token. `source_control_failure` = transient (retried); 401/403/422 = permanent (fix token scope/branch) |
| Workspace fails | `workspace_provision_failure`: disk, network, repo access. Retried up to 2×; then FAILED |
| Recovered task | Report shows *Recovered from a crash* and `telemetry.recoveryEvents` — expected after a worker restart; no duplicate PR/commit is created |
| Cancelled | Cancel in UI; execution, retries and fallback stop; the workspace is cleaned up |

## 10. Reset / recovery (without editing the database)

- **Stuck task**: Cancel it in the UI (safe in BACKLOG/TODO/WORKING/NEEDS_INPUT), then create a new task. A FAILED task cannot be retried in place (open gap); create a new task with the same text.
- **Worker misbehaving**: `systemctl restart codeforge-worker` (in-flight tasks are recovered automatically after their lease expires). API restart is always safe.
- **Provider cooldown blocking work**: it expires by itself (default 5 min, max 30 min, or the provider's own retry-after).
- **Corrupt/lost DB**: stop API + workers, restore the `.backup` file, start. Workspaces are reproducible from git.
- Never `rm` the database while services run; never share one `WORKER_ID`.

## 11. Telemetry (what the alpha measures)

`GET /tasks/:id/report` → `telemetry`: implementer attempts, reviewer runs and rejections, human-feedback cycles, infrastructure retries, fallback runs, recovery events, human interventions (NEEDS_INPUT), AI execution ms, token totals **only where the engine reported them** (`tokensReportedRuns` says how many runs; `null` = unavailable, never zero), and `modelsUsed`. Plus `durations`, `checks`/`validationOutcome`, `failureCategory`, `infrastructureFailures`, and per-attempt `modelId/providerId/fallbackIndex`. Final result = task status; "manual intervention required" = `humanInterventions > 0` or a FAILED/NEEDS_INPUT end state.

## 12. What alpha users should NOT expect

No bulk bug-sheet/backlog import or triage; no Jira/Slack/Sentry; no MCP; no project chat; no guaranteed model fallback unless a second real provider is configured; no billing/usage limits (usage is only recorded); no SLA; no automatic merge — human PR review is required; no sandbox — tasks run with the worker's OS privileges (GAP-011); no automatic workspace cleanup; failed tasks are not resumable in place; local-git projects are disabled in production unless `ALLOW_LOCAL_GIT_PROJECTS=true`.

## 13. Manual alpha test plan

Automated coverage noted where it exists; every item still needs one human pass on the real host.

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | User isolation | Dev A and Dev B register | Each sees only their own projects; `/ops/summary` counts differ (auto: `alpha-hardening`) |
| 2 | Project isolation | A creates project; B `GET /projects/<A id>` | 404 (auto) |
| 3 | Task isolation | B calls report/events/start/cancel on A's task | 404 on all; A's task unchanged (auto) |
| 4 | Simultaneous starts, two users | A and B start tasks at the same moment | Both reach REVIEW; distinct workspaces/branches (auto: 5 devs × 2 workers) |
| 5 | Same task started twice | Double-click Start / two curls | One 200, one 409; one `TASK_RELEASED` (auto) |
| 6 | Worker crash | Start a task; `kill -9` the worker mid-WORKING; start a worker | Within ~5 min the task resumes to REVIEW; one PR; report says recovered (auto in-process: `recovery.test.ts`; **real kill -9 is manual** — TD-44) |
| 7 | Cancellation | Cancel while WORKING (also during a retry wait) | CANCELLED; no further agent/validation/retry/fallback (auto) |
| 8 | Provider transient failure | Temporarily break the provider key/network briefly | `INFRASTRUCTURE_RETRY` events; recovers or fails with an infra category, not `task_failure` |
| 9 | Provider cooldown | Trigger a quota error, then start a 2nd task | `/ops/summary` shows cooldown; 2nd task does not re-probe when a fallback exists (auto with 2 test providers) |
| 10 | GitHub transient failure | Interrupt network at push/PR | Retried; exactly one PR (auto) |
| 11 | Reviewer rejection → AI fix | Task where the reviewer finds an issue | Fix cycle runs (≤2), report lists rejections |
| 12 | Human GitHub feedback → AI fix | Request changes on the PR | Task returns to WORKING, pushes to the same branch, back to REVIEW; feedback processed once |
| 13 | Bug reproduction → verification | Task with a bug-fix contract (API/service-level today) | Report shows platform-captured reproduction + fix verification |
| 14 | PR creation | Any successful task | PR link in UI, branch = task branch, no auto-merge |
| 15 | Merge sync | Merge the PR on GitHub | Task becomes DONE within one review poll interval |
| 16 | Invalid authorization | Use a stale/foreign cookie or foreign ids | 401/404 only, never data |
| 17 | Workspace isolation | Two tasks on different projects | Distinct dirs under `WORKSPACES_ROOT`; no cross-writes |
| 18 | Concurrent multi-project | 5 devs each start a task at once | All finish; `/ops/summary` `workingWithExpiredLease` stays 0 |

## 14. Change log for this milestone

Added: `COOKIE_SECURE`/`TRUST_PROXY`; production startup validation (absolute paths, encryption key); malformed-JSON 400 and 413; API request/headers timeouts; hourly expired-session purge; agent-output secret redaction; `/ops/summary`; worker heartbeat line; per-task `telemetry`; frontend now shows failure category, infrastructure retries, bug-fix verification and model/provider per attempt; INFRA_* variables documented.

## 15. Backlog Intelligence (Phase 4A) — what alpha users can now try

A **Backlog** tab per project: add items, run **Analyze**, review the AI's *proposal* (with the platform's own file-existence checks), duplicate/dependency proposals and a task proposal, then **Approve** and **Convert to task** — which creates an ordinary `BACKLOG` task you still **Start** from the Tasks tab. Nothing runs automatically. Reference: [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md). Notes for testers: **analysis is executed by the worker process — `npm run worker` must be running** (otherwise the item sits at *Queued — waiting for a worker*; nothing is lost). It uses the project's coding engine/model (so `OPENCODE_MODEL` and provider credentials must work), takes as long as one model call (~10–15 s observed), is capped globally by `MAX_BACKLOG_ANALYSIS_CONCURRENCY` (default 2, across all workers), retries transient provider failures with bounded backoff (a *Retry scheduled* state), can be cancelled while queued/running, and needs the repository to be cloneable (a failed listing degrades to "unavailable", not an error); with `CODING_ENGINE=fixture` analysis will land in **Needs clarification** because the demo engine does not return analysis JSON. Limits: no import; analysis selects files with a revision-bound index but is not a code understanding system (GAP-032); usage/cost is shown when the engine reports it (GAP-031). Real-model check: `npm run validate:backlog -- --project <id> --title … --description …` (works on a database copy; see [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md) §11). Manual check: create two overlapping items, analyze both, confirm duplicate proposals appear and nothing is merged or started.

### 15a. Evidence and usage (Phase 4A.2)

Analysis now separates **what the AI claims** from **what CodeForge verified**: the platform reads a bounded amount of real repository content (≤12 files, 64 KiB each, 256 KiB total; never `.env`/keys/credentials), checks the AI's claims against it, and shows each claim as SUPPORTED / CONTRADICTED / UNRESOLVED / NOT_CHECKED with the evidence — a confident claim that the evidence contradicts moves the item to *Needs clarification*. "Supported" only ever means *something matching exists*, never *it works*. Real token usage and the engine's cost estimate are shown when the engine reported them (nothing is shown for unknown — never `$0`). The repository needs to be cloneable by the worker (a failure degrades to "repository unavailable — claims not checked"). Manual checks: analyze an item whose subject already exists in the repo and confirm the contradiction is shown; confirm no secret file is ever quoted; `npm run validate:backlog` prints usage and the assessment.

### 15b. Repository index and task usage (Phase 4A.3)

The first analysis of a repository revision builds a small **repository index** (paths, application/feature, declared symbols, routes, imports — TypeScript/JavaScript and Dart) inside the analysis job; it takes about a minute for a ~1,000-file repository (`~2 min` end to end in the observed Jinvani runs, because the clone is blobless and files are fetched one blob at a time) and is cached in SQLite per commit SHA, so later analyses of the same revision are quick. A new commit ⇒ a new index; another project never reuses it. If another worker is building it at that moment, an analysis simply selects files by name (the analysis says so: *"Files chosen by file name only — …"*). The analysis panel shows how files were chosen and why. Nothing new to configure. **Task usage:** the task report has a **Usage** section — tokens the engine reported (never `0` for unreported), the engine's own cost estimate (labelled as an estimate), and a per-run list that distinguishes implementation, fix, review and review-follow-up-after-a-check runs; a run that failed, timed out or was cancelled keeps the usage it emitted before stopping, labelled *partial* (totals are then lower bounds); one that emitted nothing shows none (GAP-034, closed). Real check on your own credentials: `npm run validate:task-usage` runs ONE real task against a throwaway local fixture repository (nothing is pushed, your database is untouched; costs a few cents) and reconciles OpenCode's own `step_finish` events against the persisted AgentRun rows and the report totals.

### 15c. Reconciliation, benchmark and failure usage (Phase 4A.4)

After the model answers, CodeForge reconciles each claim with its own repository evidence and may show *"Possibly already implemented"* — meaning implementation evidence conflicts with a reported absence, **never** that the item is fixed. Behaviour claims stay *unresolved*. Real check: `npm run validate:backlog …` prints `platformChecks.assessment.reconciliation`; `npm run validate:task-usage -- --failure-scenario` also reconciles a real timeout kill; `npm run benchmark:retrieval -- --ground-truth … --repo …` measures file selection against your own ground truth (see [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md) §4e).

### 15d. Investigation, review states, approved checks (Phase 4A.5)

The analysis now also **investigates the item's premise itself** ("There is no limit on OTP attempts") against the repository and may show *Possibly already implemented* — implementation evidence exists, **behavior is still unverified**. The backlog list gains a review-state filter. To let CodeForge *verify* a behaviour claim you must declare an **approved claim check** in the project's commands (`PATCH /projects/:id/commands`, e.g. a real test that exercises OTP throttling, with the words a claim must contain to be bound to it); nothing runs unless you ask. Today that request is a CLI: `npm run validate:claim-verification -- --source-project <id> --repo-dir <local clone at the revision> --check-file check.json --title … --description …` (works on a database copy; it will run your check's command, e.g. `npm ci && npx tsx …`). Expect it to bind rarely: it only binds behaviour claims whose own words satisfy every binding group and match the check's application, and it only ever says CONTRADICTED for explicit absence wording. Jinvani has almost no tests, so few claims can be verified there.
