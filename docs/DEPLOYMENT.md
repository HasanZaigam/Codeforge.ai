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

## Deployment architecture decision

This milestone's brief asks for a hosted, single-instance, multi-user MVP reachable over HTTPS. Three realistic shapes were compared against this repo's actual requirements (an API process, a genuinely separate worker process per TD-16, a single SQLite file, a persistent `WORKSPACES_ROOT` directory the worker's crash-recovery mechanism depends on being stable across restarts, a static-built frontend, session-cookie auth, and a lease/heartbeat mechanism that assumes "the same disk" across a process restart):

| Option | Fit | Why |
|---|---|---|
| **A. Single VM/host, two long-lived OS processes (API + worker) behind a reverse proxy, one persistent disk** | **Chosen** | Every persistence assumption this codebase already makes (single `DB_PATH`, single `WORKSPACES_ROOT`, both processes reading the same disk) is satisfied for free — nothing to work around. `systemd` gives process supervision, restart-on-failure, and `SIGTERM`-based graceful shutdown/restart with zero new code (the entrypoints already handle `SIGTERM` — see "Graceful shutdown" below). One TLS-terminating reverse proxy in front covers HTTPS and same-origin frontend serving in one step. |
| **B. PaaS with persistent volumes (Render/Fly.io/Railway-style: a "web service" + a "background worker" service type, each mountable to a persistent volume)** | Also viable, not chosen | Structurally the same shape as Option A — two long-lived processes, a persistent volume for `.data` — just operated by a platform instead of by hand. Would work with essentially the same process definitions (`start:api`/`start:worker`) and no code changes. Not chosen only because it requires picking one specific vendor's volume/service model to write concrete configuration against, and this milestone asks for an architecture decision the operator can act on generically; Option A's systemd units and Caddy config are the provider-agnostic version of the exact same shape, and translate to Option B almost mechanically (a Render/Fly `[[services]]`/`fly.toml` process group per systemd unit, a mounted volume in place of `ReadWritePaths`). Worth revisiting if the operator already has a PaaS account and would rather not manage a bare host at all — nothing here forecloses that. |
| **C. API and worker split across ephemeral containers with no persistent local disk (e.g. a typical "serverless container" platform, Cloud Run-style)** | **Rejected** | Breaks three load-bearing assumptions at once, not one: (1) SQLite is a single file on local disk — an ephemeral container gives it a fresh, empty filesystem on every cold start/redeploy, so the database silently resets; (2) `WORKSPACES_ROOT` needs to survive a worker crash-and-restart for `recoverOrphanedTasks` to find an in-progress task's workspace where a previous attempt left it (TASK_LIFECYCLE.md "Crash recovery") — an ephemeral filesystem makes every restart look like "the workspace is just gone," turning ordinary crash recovery into permanent task-progress loss; (3) TD-12's lease/claim model assumes "the database" is one place every process instance can see — a queue or object-storage layer would need to be introduced to make any of this safe on ephemeral compute, which is explicitly out of scope for this MVP ("do not migrate off SQLite for theoretical scalability"). Making Option C work would mean adding a hosted Postgres and an object-storage-backed workspace layer — real new infrastructure this milestone's brief explicitly says not to add. |

**Chosen: Option A — a single host, provider-agnostic** (works identically on a bare VM from any IaaS, or a persistent-volume PaaS if the operator prefers one). This is the simplest architecture that satisfies every one of the 16 numbered requirements below without adding infrastructure (no Kubernetes, no Redis/Kafka/queue, no Docker — see "Docker: evaluated, not adopted" above, no hosted Postgres, no object storage) beyond what the platform was already architected for. Concrete artifacts for this option are checked into the repo under [`deploy/`](../deploy/): `deploy/systemd/ai-task-manager-api.service`, `deploy/systemd/ai-task-manager-worker.service`, and `deploy/Caddyfile`.

## Environment variables

Full reference: [`.env.example`](../.env.example) at the repo root — copy it to `.env` for local development, or set the same names as real environment variables in production. **Every value's validity is checked at process startup** (`src/config/startup-config.ts`, wired into both entrypoints via `buildPlatformFromEnv`) — a malformed value fails immediately with a clear message naming the variable, never a secret's value, instead of surfacing later as a confusing runtime error (or, for `PORT`/`POLL_INTERVAL_MS`, silently coercing to `NaN`/a wrong port).

| Variable | Required? | Notes |
|---|---|---|
| `DB_PATH` | No (`./.data/platform.sqlite`) | Must be the same file for the API and every worker process. |
| `WORKSPACES_ROOT` | No (`./.data/workspaces`) | Must be the same directory for every worker process. |
| `PROJECT_WORKSPACE_ROOT` | No (`./.data/project-workspaces`) | Persistent, project-scoped ProjectWorkspace directories (Phase 3) — a separate root from `WORKSPACES_ROOT`, never a subdirectory of it. Must be the same directory for every API/worker process. |
| `CODING_ENGINE` | No (`opencode`) | `opencode` \| `claude-code` \| `fixture`. Validated against this exact list — an unrecognized value now fails startup instead of silently falling back to `opencode`. `fixture` is refused outright when `NODE_ENV=production`. |
| `NODE_ENV` | No | `production` enables the session cookie's `Secure` flag (AUTHENTICATION.md), the `fixture`-engine guard above, and the `ALLOW_LOCAL_GIT_PROJECTS` guard below. |
| `ALLOW_LOCAL_GIT_PROJECTS` | No (`false`) | Only meaningful when `NODE_ENV=production`. Must be a clean `"true"` or `"false"` (case-insensitive) if set — anything else fails startup, never silently coerced. Outside production, `local-git` projects are always creatable regardless of this value (so the automated test suite and `npm run demo` need not set it). Under `NODE_ENV=production`, `local-git` project creation is refused (`403 LOCAL_GIT_PROJECTS_DISABLED`) unless this is explicitly `true`. See [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) "Local git / plain-git testing" for why this provider is dev/testing-only. |
| `PORT` | No (`3000`, API only) | |
| `POLL_INTERVAL_MS` | No (`2000`, worker only) | |
| `WORKER_MAX_CONCURRENT_TASKS` | No (`2`, worker only) | Caps how many TODO/WORKING task executions one worker process runs at once — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Worker concurrency and lease loss". Must be a positive integer if set. Tasks beyond capacity simply stay `TODO` and are picked up on a later poll — no queue, no new status. Does not bound the separate REVIEW/human-review-feedback poll. |
| `REVIEW_POLL_INTERVAL_MS` | No (`30000`, worker only) | How often a real GitHub call is allowed for a single REVIEW task's PR — a separate cadence from `POLL_INTERVAL_MS`, which still governs how often `tick()` itself runs. Tracked per-task in the database (`tasks.next_review_check_at`) and claimed atomically, so GitHub call volume for a given REVIEW task stays bounded to this interval regardless of how many worker processes are running. See [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "REVIEW polling". Must be a positive integer if set. |
| `WORKER_ID` | No (random per process) | Only affects log/lease-ownership readability. |
| `CREDENTIAL_ENCRYPTION_KEY` | Only if any project uses the `github` source-control provider | Base64, must decode to exactly 32 bytes. Checked lazily by feature (unchanged — see `loadEncryptionKey`'s own doc comment) but its *format*, if set at all, is now checked eagerly at startup. |
| `OPENCODE_BIN_PATH`, `OPENCODE_MODEL`, `OPENCODE_MAX_RETRIES`, `OPENCODE_RETRY_BASE_DELAY_MS`, `OPENCODE_RETRY_MAX_DELAY_MS` | No | See [CODING_ENGINE.md](./CODING_ENGINE.md) "Configuration & Environment Variables" — unchanged by this milestone. |
| A model-provider API key (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) | Only to actually execute a task | Read directly by the `opencode` CLI subprocess, never by this platform's own code — see [CODING_ENGINE.md](./CODING_ENGINE.md) "Security & Environment Sanitization". Not needed just to start the API or worker process; only when a task is actually driven through the coding engine. |

### Secrets configuration in production

No secrets manager is introduced for this MVP — that would be new infrastructure ahead of an actual need (a single-operator-run instance, per [MVP_SCOPE.md](./MVP_SCOPE.md)). Instead, secrets reach the process the same way every variable in the table above already does — the environment — just sourced from a file that never enters this git repository, rather than a developer's shell:

1. Create `/etc/ai-task-manager/api.env` and `/etc/ai-task-manager/worker.env` on the host (see [`deploy/systemd/`](../deploy/systemd/) for the units that reference these exact paths), each containing `KEY=value` lines for that process's variables — `DB_PATH`, `WORKSPACES_ROOT`, `NODE_ENV=production`, and `CREDENTIAL_ENCRYPTION_KEY` are shared across both files (both processes read the same database/workspace paths and must be able to decrypt the same stored credentials); `PORT` is API-only, `POLL_INTERVAL_MS`/`REVIEW_POLL_INTERVAL_MS`/`WORKER_ID` are worker-only.
2. Lock the files down: `chown root:root /etc/ai-task-manager/*.env && chmod 600 /etc/ai-task-manager/*.env` — readable only by root, which is what starts the systemd-managed service before dropping to the `aitaskmanager` service user (systemd's `EnvironmentFile=` directive reads the file before the process itself even starts, so the service account never needs read access to the file, only to the parsed-and-injected environment).
3. Generate `CREDENTIAL_ENCRYPTION_KEY` once, on the host, never in this repo: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Losing it means every previously-connected GitHub PAT becomes permanently undecryptable (the same "authenticated encryption" property that detects tampering also means there is no recovery path without the original key) — back it up in whatever secret store your organization already trusts (a password manager, a cloud provider's secrets service used purely as cold storage — not wired into the app itself, which stays out of scope per the brief), completely separately from the SQLite backups described below.
4. Never commit `api.env`/`worker.env`/any real `.env` to this repository (already covered by `.gitignore`'s `.env` entry at the repo root — the production files live entirely outside the repo, under `/etc/ai-task-manager/`, so there's no risk of accidentally committing them from this checkout in the first place).
5. Rotating `CREDENTIAL_ENCRYPTION_KEY` requires re-encrypting every stored `github_credentials` row (out of scope to automate here — there is currently no key-rotation tooling; a full re-connect of every user's GitHub account, after updating the key, is the documented manual path if rotation is ever needed).

This satisfies "secure environment-variable/secret configuration for production" without building a secrets manager: the secret's value never touches the git repository, a process listing (`ps aux`) never reveals it (it's an environment variable set by systemd from a file, not a CLI argument), and file permissions are the actual access boundary — the same trust boundary root-owned config already has on any Unix host.

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

## Production deployment runbook (single-host)

Concrete, ordered steps for the chosen architecture (see "Deployment architecture decision" above), assuming a fresh Linux host (any distro with `systemd` and a package manager) with a domain name already pointed at its public IP.

### First-time setup

1. **Create a dedicated service account** (never run either process as root): `sudo useradd --system --create-home --home-dir /opt/ai-task-manager --shell /usr/sbin/nologin aitaskmanager`.
2. **Install Node.js 22.9+** (whatever mechanism your distro/host prefers — a version manager or the distro's own package) and `git` (required at runtime — the workspace provider shells out to it).
3. **Check out and build the platform**: `git clone <this repo> /opt/ai-task-manager && cd /opt/ai-task-manager && npm ci && npm run build && npm --prefix web ci && npm --prefix web run build`. `dist/` (backend) and `web/dist/` (frontend) are what actually run in production — see "Startup" above for why `dist/` needs `npm run build` specifically (it packages the SQL migrations tsc alone would silently drop).
4. **Create the secrets files** as described in "Secrets configuration in production" above, then `chown -R aitaskmanager:aitaskmanager /opt/ai-task-manager`.
5. **Install the systemd units**: `sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload`.
6. **Install and configure the reverse proxy**: install Caddy (`https://caddyserver.com/docs/install`), `sudo cp deploy/Caddyfile /etc/caddy/Caddyfile`, edit the placeholder domain to your real one, `sudo systemctl reload caddy`. Caddy obtains and renews the TLS certificate automatically (ACME/Let's Encrypt) the first time it successfully binds the domain — no manual certbot step. See "HTTPS / reverse-proxy configuration" below for what this actually does.
7. **Start the application processes**: `sudo systemctl enable --now ai-task-manager-api ai-task-manager-worker`. First boot creates `DB_PATH`'s parent directory and runs every migration automatically (see "Database migrations" above) — no separate migration command to run by hand, first deploy or any later one.
8. **Verify**: `curl https://your-domain.example.com/api/health/ready` should return `{"status":"ready"}`; `sudo systemctl status ai-task-manager-api ai-task-manager-worker` should both show `active (running)`; `sudo journalctl -u ai-task-manager-api -n 50` should show the `[api] listening on ...` startup log line with no errors above it.

### Redeploying a new version

```bash
cd /opt/ai-task-manager
git pull
npm ci && npm run build
npm --prefix web ci && npm --prefix web run build
sudo systemctl restart ai-task-manager-api ai-task-manager-worker
```
Migrations run automatically as part of process startup on the restart above (idempotent — see "Database migrations"), so there's no separate migration step to sequence around the restart. The API restart is a brief connection gap only (Caddy simply gets connection-refused for the handful of seconds systemd takes to restart it, then resumes proxying — no code needed to handle this, it's ordinary process-restart behavior); the worker restart relies on the same lease/crash-recovery mechanism a crash would (see "Restart/crash recovery behavior" in the milestone report) — any task genuinely mid-execution when the restart happens is picked back up, by this or another worker, once its lease expires.

### Rollback

```bash
cd /opt/ai-task-manager
git checkout <previous-known-good-commit-or-tag>
npm ci && npm run build
npm --prefix web ci && npm --prefix web run build
sudo systemctl restart ai-task-manager-api ai-task-manager-worker
```
Safe because migrations are additive and forward-only in this codebase's actual history so far (no destructive migration has ever shipped) — rolling back application code while the database stays on its current (newer) schema is fine as long as the older code doesn't reference a column/table a rollback-target version never expected. **If a future migration is ever destructive** (drops/renames a column a rolled-back version still reads), this simple code-rollback is insufficient and the database itself would need restoring from a pre-migration backup (see "Backup and restore" below) — flagged here as a real constraint, not solved preemptively for a migration that doesn't exist yet.

## HTTPS / reverse-proxy configuration

[`deploy/Caddyfile`](../deploy/Caddyfile) does three things, all in one config file: terminates TLS (automatic ACME certificate issuance/renewal for the configured domain — this is Caddy's actual advantage over nginx here, since nginx would need certbot wired up as a separate step), serves the built frontend (`web/dist/`) as static files with SPA fallback (`try_files {path} /index.html`, so client-side routes survive a hard refresh), and reverse-proxies `/api/*` to the API process on `localhost:3000` with the prefix stripped — the exact same `/api` → backend relationship `web/vite.config.ts`'s dev-time proxy already establishes (TD-21), just terminated by a real reverse proxy instead of the Vite dev server. An equivalent nginx+certbot config achieves the same three things if that's already an operator's standard tooling — the proxy *behavior* (strip `/api`, forward to `localhost:3000`, serve `web/dist/` with SPA fallback) is what matters, not which specific software provides it.

## CORS / origin configuration

**No CORS configuration exists in the API, and none is needed for this architecture.** Because the reverse proxy serves the frontend and proxies the API from the same public hostname (`your-domain.example.com`), the browser sees frontend and API as the same origin — exactly the property TD-21 already relied on for the dev-time Vite proxy, now reproduced in production by Caddy instead. This is also load-bearing for the session cookie's CSRF defense: [AUTHENTICATION.md](./AUTHENTICATION.md) "Browser security" is explicit that `SameSite=Lax` "is enough only because the frontend and API are served from the same origin" — this deployment's same-origin-via-reverse-proxy shape is what keeps that true in production, not an accident. If a future deployment ever splits the frontend onto a different origin (a separate static host/CDN instead of Caddy serving `web/dist/` directly), that document's own warning applies: `SameSite=Lax` alone stops protecting `POST` requests at that point, and real CORS configuration plus a CSRF token would both be needed — not done here because this deployment doesn't split them.

## Graceful shutdown

Both entrypoints already handled `SIGINT`/`SIGTERM`; this milestone added a bounded timeout so neither can hang indefinitely.

- **API**: stops accepting new connections, waits for in-flight requests to finish, closes the database, exits `0`. Bounded at 30s — if shutdown hasn't completed by then, it force-exits (`1`) rather than leave an orchestrator waiting on a hung process. This process holds no task-execution state (TD-16), so there's nothing here that legitimately needs longer.
- **Worker**: stops claiming new tasks and waits for whatever's already executing to finish naturally — it does **not** cancel in-flight task execution on shutdown. That's intentional, not a gap: a task still genuinely running when `SIGTERM` arrives is exactly what the existing lease/crash-recovery mechanism ([TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-12, [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Crash recovery") already exists to handle safely — its lease expires, and `recoverOrphanedTasks()` picks it back up on the next claim, by this or any other worker. Also bounded at 30s, after which it force-exits and lets recovery take over rather than waiting indefinitely.
- **Child processes** (the coding engine's own spawned process, `git`, etc.): already terminated via `AbortSignal` when a task is genuinely cancelled (see [CODING_ENGINE.md](./CODING_ENGINE.md)); a worker process force-exiting under the shutdown timeout above relies on the same crash-recovery path as any other unplanned worker death, not new cleanup logic — no new child-process-group management was introduced here (see "Docker" above for the same "don't add infrastructure without evidence it's needed" reasoning).
- **Database connections**: `platform.db.close()` on every clean exit path in both entrypoints (unchanged).
- **Mapped onto systemd** (this milestone's addition, [`deploy/systemd/`](../deploy/systemd/)): both units set `KillSignal=SIGTERM` (systemd's default, made explicit) and a `TimeoutStopSec` slightly larger than each process's own internal shutdown bound (35s for the API's 30s bound, 45s for the worker's 30s bound) — so `systemctl restart`/`stop`, and the `SIGTERM` a host reboot or `systemctl daemon-reexec` sends, always exercise the application's own graceful path first; systemd's `SIGKILL` escalation is a backstop for a genuinely hung process, not the normal path. `Restart=on-failure` gives the worker process-level liveness with no HTTP surface needed (per "Health and readiness checks" below) — if the process itself dies unexpectedly (not a clean `SIGTERM` shutdown), systemd restarts it, and any task it had leased is picked up by the restarted process (or another worker) once the lease expires, via the same crash-recovery path a `kill -9` already exercises (see TD-44's real `kill -9` verification).

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

## Backup and restore for SQLite and workspaces

The database is a single file (plus, in WAL mode, `-wal`/`-shm` sidecar files that must be treated as part of it — copying only the main file mid-write can produce an inconsistent backup). Two safe approaches, neither requiring new tooling:

1. **Online backup via the `sqlite3` CLI** (if available on the host): `sqlite3 /path/to/platform.sqlite ".backup /path/to/backup.sqlite"` — takes a consistent snapshot while the database is in use, no downtime.
2. **Checkpoint, then copy**: run `PRAGMA wal_checkpoint(TRUNCATE);` against the live database (folds the WAL back into the main file and truncates it) immediately before copying just the main `.sqlite` file — simplest, but briefly blocks concurrent writers during the checkpoint itself.

Either way, back up `WORKSPACES_ROOT` separately if you need to preserve in-flight task workspaces across a restore — they're reproducible from git per-task (a fresh clone/worktree, per [ARCHITECTURE.md](./ARCHITECTURE.md)), so most deployments don't need to; only the database (the system of record) is essential to back up.

**Restore procedure**: stop both processes first (`sudo systemctl stop ai-task-manager-api ai-task-manager-worker` — never restore into a live database), copy the backed-up `.sqlite` file (and its `-wal`/`-shm` sidecars if the backup was taken by the checkpoint-then-copy method and they exist) over `DB_PATH`, then `sudo systemctl start ai-task-manager-api ai-task-manager-worker`. Any task that was `WORKING` at backup time and has no matching directory under the restored `WORKSPACES_ROOT` (e.g. workspaces weren't backed up, per the note above) is picked up by `recoverOrphanedTasks` once its lease expires and simply re-provisions a fresh workspace — no different from ordinary crash recovery, since workspace provisioning is idempotent by design (TD-12).

**Persistence verified locally for this milestone** (per requirement 15 — a design property confirmed against a real running process, not just asserted): started the API and worker against the repo's real `.data/platform.sqlite`/`.data/workspaces`, confirmed existing task/project/user rows were present via `GET /health/ready` and an authenticated `GET /projects` call, cleanly stopped both processes (`SIGTERM`, graceful shutdown log lines observed — see "Verification performed for this milestone" below), then started them again against the same `.data` directory and confirmed the same data was still present with no re-migration side effects (the `_migrations` table made the second startup's migration pass a no-op, as designed). This is the same property a systemd restart or a redeploy relies on in production — a persistent disk mounted at the same path is what makes it true, not anything process-specific.

## Logging and diagnostics

No logging platform/aggregator is introduced for this MVP (per the brief — "stdout/stderr structured enough to be useful is fine"). Every entrypoint and failure path already prefixes its output with a `[component]` tag (`[api]`, `[worker]`, `[orchestrator]`, `[github]`, `[config]`) — `journalctl -u ai-task-manager-api -f` / `journalctl -u ai-task-manager-worker -f` (systemd captures stdout/stderr automatically, no extra wiring) is the diagnostic entry point for all five failure classes this milestone's brief asks for:

| Failure class | Where to look | What you'll see |
|---|---|---|
| **API startup failure** | `journalctl -u ai-task-manager-api -n 100` | Fail-fast config validation (`src/config/startup-config.ts`) throws with a message naming the invalid variable (never its value) before the HTTP server ever binds a port — e.g. a malformed `CREDENTIAL_ENCRYPTION_KEY` or an unrecognized `CODING_ENGINE`. `[api] fatal startup error: ...` is the last line if it never came up at all; systemd's `Restart=on-failure` will keep retrying a persistently-misconfigured process, so a repeating crash loop in `journalctl` is itself the symptom to look for. |
| **Worker startup failure** | `journalctl -u ai-task-manager-worker -n 100` | Same fail-fast validation (shared `buildPlatformFromEnv`), `[worker] fatal startup error: ...` on failure, `[worker] starting, poll interval ...` on success. |
| **Task execution failure** | The task's own event log in the UI/API (`GET /tasks/:taskId/events`, `GET /tasks/:taskId/report`) is authoritative and per-task — every `AGENT_FAILED`/`WORKSPACE_FAILED`/`SOURCE_CONTROL_FAILED`/`TASK_FAILED` event is durable, queryable, and already exposed to the frontend (see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Execution history and observability"). `journalctl -u ai-task-manager-worker` supplements this with `[orchestrator]`-prefixed lines for failures that happen *outside* normal per-task event recording (e.g. lease loss mid-run) and the catch-all `[worker] task <id> raised an unexpected error outside the Orchestrator's own handling: ...` for anything that somehow escapes the Orchestrator's own error handling entirely. |
| **GitHub failures** | Same per-task event log (`SOURCE_CONTROL_FAILED` events carry `payload.step` and a sanitized error — see [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) "Failure recovery") plus `journalctl -u ai-task-manager-worker` for `[github] push to ... failed transiently — retrying ...` lines during an in-progress retry. Never a raw GitHub response body, header, or credential in either place (`error-classifier.ts`/`safeErrorMessage` — see "Safe error handling" in GITHUB_INTEGRATION.md). |
| **AI/provider failures** | Same per-task event log for the task-level outcome; `journalctl -u ai-task-manager-worker` for `[opencode]`-adapter-level lines (retry attempts, classification) during an in-progress retry — see [CODING_ENGINE.md](./CODING_ENGINE.md) "Retry behavior." |

Unhandled API-layer errors (anything not already mapped to a typed error class) are logged server-side as `[api] unhandled error: ...` before a generic, detail-free `500` reaches the client (`src/api/error-middleware.ts`) — the client never sees a stack trace or internal path; the server log is where that detail lives.

**Not built, and why that's an acceptable gap for this MVP**: log aggregation/shipping to a centralized store, structured JSON logging (every line here is a prefixed plain string, not machine-parsed JSON), and metrics/alerting. A single-host deployment's logs are already in one place (`journalctl`) with no cross-host aggregation problem to solve; revisit if this ever runs on more than one host.

## Remaining limitations

- No automated backup job is included — "Backup and restore" above documents the correct manual/scriptable approach; scheduling it (e.g. a cron entry running the checkpoint-then-copy sequence nightly) is left to the host environment's own tooling, consistent with this milestone's brief ("do not introduce unnecessary infrastructure").
- SQLite is a single-file, single-writer-per-transaction database — horizontal *write* scaling isn't a target of this architecture (unchanged from TD-11's original tradeoff analysis); API replicas scale independently, but they all still share the one database file. **What would change before horizontal scaling across multiple hosts**: SQLite would need to become a real network database (Postgres, per TD-11's own documented migration path — a repository-class SQL-dialect swap, not a core-logic rewrite) and `WORKSPACES_ROOT` would need to become shared network storage (NFS/EFS-style) or be replaced with an object-storage-backed workspace layer, since two hosts can't share one local disk. Neither is done here — SQLite and local-disk workspaces are acceptable for this MVP's single-host target, per the brief's explicit instruction not to migrate off SQLite "for theoretical scalability."
- Login/register rate limiting remains in-memory/per-process (TD-35, [AUTHENTICATION.md](./AUTHENTICATION.md) "Rate limiting") — this deployment runs exactly one API process, so the documented "each process has independent counters" gap doesn't yet apply, but running more than one API replica on this same architecture would reintroduce it; not solved here since this deployment is single-replica.
- No Docker/container artifacts are provided — see "Docker: evaluated, not adopted" above.
- Real Jenkins/deployment-adapter integration for *connected projects* remains explicitly out of scope (unrelated to this document — see [MVP_SCOPE.md](./MVP_SCOPE.md)).
- No multi-tenant infrastructure (unchanged from prior milestones) — see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) "Multi-user isolation audit" for what multi-*user* (not multi-tenant/organization) isolation this milestone did verify.
- No log aggregation/centralized logging or metrics/alerting — see "Logging and diagnostics" above.
- GitHub PAT credential model's limitations (scope, revocation) are unchanged by this milestone — see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) "GitHub credential model" and [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) "Credential mechanism."

## Verification performed for this milestone

Ordinary test/typecheck/build commands and their results are reported in the milestone report (not duplicated here to avoid a second, driftable copy). What's recorded here is the *production-build/startup* verification specifically, since it exercises real process behavior a unit test can't:

1. `npm run build` (backend) and `npm --prefix web run build` (frontend) — both clean.
2. `NODE_ENV=production CODING_ENGINE=opencode DB_PATH=<throwaway path> node dist/src/api/server.js` — confirmed fail-fast config validation passes (no misconfiguration present), `[api] listening on ...` logged, `GET /health` and `GET /health/ready` both responded `200`.
3. Same for `node dist/src/worker/run-worker.js` against the same `DB_PATH` — confirmed `[worker] starting, poll interval ...` logged, no startup error.
4. Sent `SIGTERM` to both processes — confirmed `[api]`/`[worker] received SIGTERM, ...` and the corresponding clean-exit log lines appeared, and both processes actually exited (no orphaned process left running).
5. Confirmed no stray background process was left running after verification (checked via process list before concluding).

This is the same sequence CI's own "smoke-test the compiled production build" step already automates (see "Continuous integration" above) — this milestone's verification additionally exercised it manually against the real local `.data` directory specifically to confirm persistence (see "Backup and restore" → "Persistence verified locally" above), which the CI step (a throwaway SQLite file) doesn't cover.
