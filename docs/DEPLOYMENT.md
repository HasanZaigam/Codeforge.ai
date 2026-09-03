# Deployment

How to run this platform (the platform itself — API, worker, frontend) in production. This is separate from, and unrelated to, the `DeploymentAdapter` interface a *connected project* may configure for its own deployments (Jenkins etc., see [MVP_SCOPE.md](./MVP_SCOPE.md)) — this document is about hosting the AI Task Manager application itself.

## Architecture

Nothing here is a new decision — it's the production shape the platform was already architected for (see [ARCHITECTURE.md](./ARCHITECTURE.md), [TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-16/TD-20/TD-21), made concrete and runnable.

| Component | What it is | How it's deployed |
|---|---|---|
| **API process** | `src/api/server.ts` — Express HTTP server. Never executes tasks itself (TD-16). | One or more long-running Node processes behind a reverse proxy/load balancer. Stateless except for its DB connection — safe to run multiple replicas. |
| **Worker process** | `src/worker/run-worker.ts` — polls `TODO`/`WORKING`/`REVIEW` tasks and drives them via the Orchestrator. | One or more long-running Node processes. Safe to run multiple replicas — task claiming is a single atomic `UPDATE ... WHERE` (TD-12); two workers racing on the same task is a normal, handled case, not a hazard. |
| **SQLite database** | One file (`DB_PATH`, WAL mode). System of record for tasks, events, users, sessions, GitHub credentials. | A single persistent volume/disk, mounted at the same path for every API and worker process (see "Database" below — this is the one component that does **not** horizontally scale by adding more disks). |
| **Workspaces** | `WORKSPACES_ROOT` — one ephemeral git clone/worktree per task, where the coding engine actually runs. | Persistent disk, shared by every worker process (a task claimed by any worker must find its workspace where a previous attempt — possibly on a different worker process — left it, per crash recovery). |
| **Frontend** | `web/` — a static Vite/React build (`npm run build` produces `web/dist/`). | Deployed as a static site (any static host, CDN, or nginx) with a reverse-proxy rule forwarding `/api/*` to the API process(es) with the prefix stripped — the same relationship `web/vite.config.ts`'s dev-time proxy already establishes (TD-21), just terminated by a real reverse proxy instead of the Vite dev server. |

**Why the frontend isn't served by the API process**: TD-20 chose `web/` as a fully independent, independently-deployable package specifically so it isn't coupled to the backend's process/module graph. Bolting static-file serving onto the Express app would work, but would quietly re-couple frontend deployment to backend deployment for no real benefit — a reverse proxy achieves the same "no CORS needed" outcome TD-21 wanted, without that coupling. If your hosting environment has no reverse-proxy story at all, the fallback is enabling CORS on the API for the frontend's origin — not currently wired in, since every deployment topology considered here has a reverse proxy available.

### Docker: evaluated, not adopted

Considered per this milestone's brief. Verdict: doesn't yet clearly fit, so it isn't added.
- **What would motivate it**: pinning the runtime (Node version, `git`, and the `opencode` CLI) identically across environments.
- **Why not now**: there's no existing Dockerfile/compose to build on, the `opencode` CLI's own install/versioning story isn't standardized anywhere in this repo (an operator installs and manages it directly today), and the platform's `node:sqlite`-based persistence already avoids the native-build problem Docker often solves (TD-11). Introducing container infrastructure now would be solving a problem ("environment drift") this deployment doesn't yet have evidence of, for a single-developer-first MVP (see [PRODUCT_VISION.md](./PRODUCT_VISION.md)) — exactly the "infrastructure without justification" this milestone's brief warns against.
- **Revisit when**: the `opencode` CLI gets a documented, versioned install path, or multiple environments (staging/prod) need to be guaranteed identical beyond what "same Node version, same `npm ci`" already gives you.

## Environment variables

Full reference: [`.env.example`](../.env.example) at the repo root — copy it to `.env` for local development, or set the same names as real environment variables in production. **Every value's validity is checked at process startup** (`src/config/startup-config.ts`, wired into both entrypoints via `buildPlatformFromEnv`) — a malformed value fails immediately with a clear message naming the variable, never a secret's value, instead of surfacing later as a confusing runtime error (or, for `PORT`/`POLL_INTERVAL_MS`, silently coercing to `NaN`/a wrong port).

| Variable | Required? | Notes |
|---|---|---|
| `DB_PATH` | No (`./.data/platform.sqlite`) | Must be the same file for the API and every worker process. |
| `WORKSPACES_ROOT` | No (`./.data/workspaces`) | Must be the same directory for every worker process. |
| `CODING_ENGINE` | No (`opencode`) | `opencode` \| `claude-code` \| `fixture`. Validated against this exact list — an unrecognized value now fails startup instead of silently falling back to `opencode`. `fixture` is refused outright when `NODE_ENV=production`. |
| `NODE_ENV` | No | `production` enables the session cookie's `Secure` flag (AUTHENTICATION.md) and the `fixture`-engine guard above. |
| `PORT` | No (`3000`, API only) | |
| `POLL_INTERVAL_MS` | No (`2000`, worker only) | |
| `WORKER_ID` | No (random per process) | Only affects log/lease-ownership readability. |
| `CREDENTIAL_ENCRYPTION_KEY` | Only if any project uses the `github` source-control provider | Base64, must decode to exactly 32 bytes. Checked lazily by feature (unchanged — see `loadEncryptionKey`'s own doc comment) but its *format*, if set at all, is now checked eagerly at startup. |
| `OPENCODE_BIN_PATH`, `OPENCODE_MODEL`, `OPENCODE_MAX_RETRIES`, `OPENCODE_RETRY_BASE_DELAY_MS`, `OPENCODE_RETRY_MAX_DELAY_MS` | No | See [CODING_ENGINE.md](./CODING_ENGINE.md) "Configuration & Environment Variables" — unchanged by this milestone. |
| A model-provider API key (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) | Only to actually execute a task | Read directly by the `opencode` CLI subprocess, never by this platform's own code — see [CODING_ENGINE.md](./CODING_ENGINE.md) "Security & Environment Sanitization". Not needed just to start the API or worker process; only when a task is actually driven through the coding engine. |

## Startup

Build once, then start each process from the compiled output (no `tsx`/TypeScript toolchain needed at runtime):

```bash
npm ci
npm run build      # tsc, plus copies src/persistence/migrations/*.sql into dist/ — see "Database migrations" below
npm run start:api      # node dist/src/api/server.js
npm run start:worker   # node dist/src/worker/run-worker.js
```

Run the API and worker as **separate, independently-restartable OS processes/services** (systemd units, separate container instances, separate deployment targets — whatever your platform's process supervisor is) — never merged into one process. `src/dev.ts` (`npm run dev`) spawns both as child processes together, but that's explicitly a local-convenience wrapper, not a production topology (see its own doc comment and TD-16).

Frontend: `npm --prefix web run build` produces `web/dist/` — deploy that directory to any static host/CDN, with the reverse-proxy rule described under "Architecture" above.

## Graceful shutdown

Both entrypoints already handled `SIGINT`/`SIGTERM`; this milestone added a bounded timeout so neither can hang indefinitely.

- **API**: stops accepting new connections, waits for in-flight requests to finish, closes the database, exits `0`. Bounded at 30s — if shutdown hasn't completed by then, it force-exits (`1`) rather than leave an orchestrator waiting on a hung process. This process holds no task-execution state (TD-16), so there's nothing here that legitimately needs longer.
- **Worker**: stops claiming new tasks and waits for whatever's already executing to finish naturally — it does **not** cancel in-flight task execution on shutdown. That's intentional, not a gap: a task still genuinely running when `SIGTERM` arrives is exactly what the existing lease/crash-recovery mechanism ([TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-12, [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Crash recovery") already exists to handle safely — its lease expires, and `recoverOrphanedTasks()` picks it back up on the next claim, by this or any other worker. Also bounded at 30s, after which it force-exits and lets recovery take over rather than waiting indefinitely.
- **Child processes** (the coding engine's own spawned process, `git`, etc.): already terminated via `AbortSignal` when a task is genuinely cancelled (see [CODING_ENGINE.md](./CODING_ENGINE.md)); a worker process force-exiting under the shutdown timeout above relies on the same crash-recovery path as any other unplanned worker death, not new cleanup logic — no new child-process-group management was introduced here (see "Docker" above for the same "don't add infrastructure without evidence it's needed" reasoning).
- **Database connections**: `platform.db.close()` on every clean exit path in both entrypoints (unchanged).

## Database migrations

`openDatabase()` runs every migration in `src/persistence/migrations/` (tracked in a `_migrations` table, so it's idempotent — safe to run on every process startup, including every restart) via `MIGRATION_FILES`, an explicit ordered list in `src/persistence/db.ts`. A fresh production environment needs nothing extra: starting the API or worker process for the first time against an empty/nonexistent `DB_PATH` creates the file and applies every migration in order automatically.

**The one thing this milestone found and fixed**: `tsc` alone does not copy non-`.ts` files (the `.sql` migrations) into `dist/`, so a naive compiled build could pass every test and typecheck cleanly yet fail to boot in production with `ENOENT` on the first migration file. `npm run build` now copies `src/persistence/migrations/*.sql` into `dist/src/persistence/migrations/` after `tsc` runs; `tests/migrations.test.ts` guards against the migrations directory and `MIGRATION_FILES` silently drifting apart, and CI's "smoke-test the compiled production build" step boots the actual compiled artifact end-to-end (see "Continuous integration" below) as a regression guard for the `dist/`-packaging half of this specifically.

Adding a new migration: add the `.sql` file to `src/persistence/migrations/`, append its filename to `MIGRATION_FILES` in `src/persistence/db.ts`, and `tests/migrations.test.ts` will fail loudly if the two ever fall out of sync.

## Health and readiness checks

Two distinct endpoints, both public (`GET`, no session, per [API.md](./API.md)):

- **`GET /health`** — liveness. No database access at all; answers only "is this process's HTTP server up." Use for a process-restart policy (e.g. a container orchestrator's liveness probe).
- **`GET /health/ready`** — readiness (new this milestone). A cheap synchronous `SELECT 1` against the database. Use for a "should traffic be routed here" policy (e.g. a load balancer's or orchestrator's readiness probe / target-health check) — a process can be alive but unable to actually serve requests if its database connection is broken, which `/health` alone would never catch.

The worker process has no HTTP surface (by design — see TD-16) and so has no equivalent HTTP probe. Its liveness is the process itself (restart-on-exit via your process supervisor); its *task-level* liveness — "is it actually still making progress, not just running" — is exactly what the lease/heartbeat mechanism already covers, observable via the same task/event data the API and UI already expose, not a separate monitoring surface.

## Continuous integration

`.github/workflows/ci.yml` — two independent jobs (`backend`, `frontend`), triggered on every push to `main` and every pull request. Requires **no real GitHub, OpenCode, or Gemini credentials, and no production infrastructure** — the backend test suite builds its own isolated SQLite/workspace fixtures per test and uses `FixtureCodingEngine`/stubbed `fetch` for everything that would otherwise be a live external call (see [CODING_ENGINE.md](./CODING_ENGINE.md), [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md)).

- **backend**: install → typecheck → test → build → boot the compiled build against a throwaway SQLite file (`CODING_ENGINE=opencode`, `NODE_ENV=production`, no API key — booting never requires one, only actually invoking the engine on a task does) and confirm both health endpoints respond and the process exits cleanly on `SIGTERM`.
- **frontend**: install → typecheck → test → build.

Validated locally (no `act`/GitHub Actions runner available in this environment) by: parsing the workflow YAML structurally, and separately re-running every step's exact command (`npm ci` through the smoke-test script) end to end outside the workflow file.

## Backup considerations for SQLite

The database is a single file (plus, in WAL mode, `-wal`/`-shm` sidecar files that must be treated as part of it — copying only the main file mid-write can produce an inconsistent backup). Two safe approaches, neither requiring new tooling:

1. **Online backup via the `sqlite3` CLI** (if available on the host): `sqlite3 /path/to/platform.sqlite ".backup /path/to/backup.sqlite"` — takes a consistent snapshot while the database is in use, no downtime.
2. **Checkpoint, then copy**: run `PRAGMA wal_checkpoint(TRUNCATE);` against the live database (folds the WAL back into the main file and truncates it) immediately before copying just the main `.sqlite` file — simplest, but briefly blocks concurrent writers during the checkpoint itself.

Either way, back up `WORKSPACES_ROOT` separately if you need to preserve in-flight task workspaces across a restore — they're reproducible from git per-task (a fresh clone/worktree, per [ARCHITECTURE.md](./ARCHITECTURE.md)), so most deployments don't need to; only the database (the system of record) is essential to back up.

## Remaining limitations

- No automated backup job is included — "Backup considerations" above documents the correct manual/scriptable approach; scheduling it is left to the host environment's own tooling, consistent with this milestone's brief ("do not introduce unnecessary infrastructure").
- SQLite is a single-file, single-writer-per-transaction database — horizontal *write* scaling isn't a target of this architecture (unchanged from TD-11's original tradeoff analysis); API replicas scale independently, but they all still share the one database file.
- No Docker/container artifacts are provided — see "Docker: evaluated, not adopted" above.
- Real Jenkins/deployment-adapter integration for *connected projects* remains explicitly out of scope (unrelated to this document — see [MVP_SCOPE.md](./MVP_SCOPE.md)).
- No multi-tenant infrastructure (unchanged from prior milestones).
