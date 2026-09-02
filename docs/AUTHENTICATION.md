# Authentication & Authorization

Step 6 replaces the Step 3 placeholder (a trusted `x-user-id` header — see TECHNICAL_DECISIONS.md TD-19) with real authentication: every request now carries a server-issued session, and every project/task access is checked against who actually owns it. This document covers the design; [API.md](./API.md) has the endpoint contract and [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) has the broader security posture this fits into.

## Why this exists now

The platform has real user actions with real consequences — creating a project (which connects to a real repository), creating and cancelling autonomous work, answering `NEEDS_INPUT` decisions. Before adding anything that touches a developer's actual GitHub repository or a deployment target, the platform needs to know, with certainty a client can't fake, **who** is asking.

## Architecture

```
Browser (cookie, HttpOnly)
        ↓
Auth middleware (src/api/auth.ts) — resolves req.user from the cookie
        ↓
Application services — take an actorId, enforce ownership (src/application/authorization.ts)
        ↓
Domain / Orchestrator — unchanged: still just sees a plain actorId string
```

The domain layer knows nothing about cookies, sessions, or HTTP — exactly as TD-19 promised when the placeholder was built: swapping it for real auth touched `src/api/auth.ts`, added one new application service (`AuthService`) and one new helper module (`authorization.ts`), and changed call sites to pass a real `actorId` instead of a trusted header value. The Orchestrator, state machine, and every domain type are unchanged.

## Authentication mechanism

**Server-side sessions with an opaque token in an HttpOnly cookie** — not a JWT in `localStorage`, and not a hand-rolled scheme.

| Piece | Choice | Why |
|---|---|---|
| Password storage | `crypto.scrypt` (Node built-in) | Vetted, memory-hard KDF (RFC 7914) meeting OWASP's password-storage guidance, with zero new dependency and no native-module build risk. See TECHNICAL_DECISIONS.md. |
| Session identity | A random 256-bit token (`crypto.randomBytes(32)`), not a JWT | Opaque and server-validated on every request — revocation (logout) is a plain `DELETE`, not a blocklist a JWT design would need. No signing secret exists anywhere in this system as a result — see "Secrets" below. |
| What's stored | `sha256(token)`, never the raw token | Same "don't store the secret itself" principle as password hashing — a stolen database backup doesn't hand out usable sessions. |
| Transport | HttpOnly, `SameSite=Lax` cookie | Unreachable from JavaScript (closes off the main XSS token-theft path); `SameSite=Lax` is the primary CSRF defense for this single-origin app — see "Browser security" below. |

Why not JWT-in-localStorage (the thing the brief explicitly warned against): a JWT would need a signing secret to exist (drag along all the "never commit it" concerns for something this design doesn't need at all), can't be revoked before it expires without a blocklist (defeating half the point of using one), and `localStorage` is readable by any script on the page — a single XSS bug becomes a stolen, replayable session. Nothing here needed that trade.

## Session lifecycle

- **Created** on `POST /auth/register` or `POST /auth/login` — a session row is inserted, the raw token is set as the `session` cookie.
- **Validated** on every request to a protected route: the cookie is read, hashed, looked up. A missing, unknown, or expired session is indistinguishable from "not logged in" — 401, never a different error.
- **Expiry**: fixed 7-day TTL from creation (`SESSION_TTL_MS`, `src/auth/session-tokens.ts`). No sliding renewal in this MVP — a session that's still being actively used gets a `last_seen_at` touch on each validated request (useful for a future "your active sessions" view), but that doesn't extend `expires_at`. Simple, and 7 days is generous for a single-tenant internal tool; revisit if that turns out to be wrong in practice.
- **Revoked** on `POST /auth/logout` — the session row is deleted server-side. The exact same cookie, replayed after logout, is rejected — logout is not merely "the frontend forgets a variable."
- **Expired mid-use**: the frontend's API client emits an internal event on any 401 from a protected route (excluding `/auth/*` itself, so a failed login isn't misread as "your session expired"); `AuthContext` listens and clears its user, which redirects to `/login` on the next render — see [UI_ARCHITECTURE.md](./UI_ARCHITECTURE.md) "Session bootstrap."

## Authorization model

**MVP model: `User -> owns -> Project -> (all of that project's tasks)`.** `Project.ownerId` is the only access-control field in the schema. A task has no owner field of its own — every task-scoped operation resolves the task's project and checks that project's `ownerId` against the authenticated actor (`src/application/authorization.ts`).

This is deliberately not RBAC and not organizations — the brief is explicit that those are later steps. But it's shaped so they can be added without breaking this: `ownerId` today, `Organization -> members (with roles) -> Project` later, is a schema migration (add a table, backfill `ownerId` as the sole initial member), not a redesign of how every route checks access — every route already goes through one `assertProjectAccess`/`assertTaskAccess` choke point, so a future org-aware version of those two functions is the only place that needs to change.

### 404, not 403

Every unauthorized access to a project or task that *does* exist returns the same `404 NOT_FOUND` as one that doesn't. This is deliberate: the API never confirms that a resource exists to a caller who isn't allowed to see it (the same reasoning GitHub uses for private repositories). The cost is a slightly less informative error for a legitimate caller who mistyped an ID — acceptable; the alternative (403 for "exists but not yours") leaks existence to anyone willing to guess IDs.

### What's checked where

Every method on `ProjectService`, `TaskService`, and `HumanInputService` takes the authenticated `actorId` as a parameter and enforces access before touching a repository — never in a route handler, never left to the frontend. There is no code path from the API into the Orchestrator that skips this. See [API.md](./API.md) for the endpoint-by-endpoint list.

This choke point has held across every later milestone without change: `TaskService.checkReviewFeedback` (the human-GitHub-review-feedback loop) and the execution-history fields added to `GET /tasks/:taskId/report` (`agentRuns`, `durations`, `failureContext` — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Execution history and observability") both went through `assertTaskAccess` from the moment they were added, not as a retrofit — new task-scoped capabilities extend an existing, already-checked method rather than opening a new, unchecked path. Audited and explicitly IDOR-tested as part of the authentication/authorization/isolation milestone — see `tests/auth.test.ts`.

## Actor attribution / audit

`Task.createdBy`, `Task.cancelRequestedBy`, and `HumanInputRequest.answeredBy` are always the authenticated `actorId` now — never a client-asserted value, never the old placeholder "system" user. Every `TaskEvent` produced by the Orchestrator's own execution (`AGENT_STARTED`, `VALIDATION_COMPLETED`, `WORKSPACE_CLEANUP_STARTED`, etc.) carries no actor at all — that absence is itself the signal that it's a system/agent action, not a human one; the platform never fabricates a human identity for autonomous work. The worker process (see below) never authenticates and never needs to — nothing it does on its own is attributed to a person.

## The worker doesn't authenticate — and shouldn't

The worker (`src/worker/`) calls `Orchestrator.executeTask()` directly, in-process — it never goes through the HTTP API, and per [TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-16, it never did even before real auth existed. Requiring the worker to "log in" would mean minting it a standing credential with no expiry a compromised worker process could then use to act as an arbitrary human — worse, not better, security. The worker is trusted as what it is: the system process that drives execution, distinct from any developer.

## Browser security

- **HttpOnly**: the session cookie is never readable from page JavaScript — an XSS bug can't exfiltrate it.
- **SameSite=Lax**: the primary CSRF defense here. A cross-site page cannot trigger a state-changing (`POST`) request that carries this cookie — `Lax` only attaches the cookie to top-level, same-site-initiated navigations and safe (`GET`) cross-site requests. No separate CSRF token is implemented. **This is enough only because the frontend and API are served from the same origin** (in dev, via the Vite proxy — see TD-21; in a same-origin production deployment, the same holds). If the frontend and API are ever split across origins, `SameSite=Lax` alone stops protecting `POST` requests made by a **same-site** page — the moment "same-site" stops being true, this needs a real CSRF token, and that's a deliberate flag for whoever does that split, not something to discover by incident.
- **Secure**: only set outside local development (`NODE_ENV=production`) — an HTTP dev server could never get a browser to accept a `Secure` cookie, and there's no HTTPS dev server in this MVP.
- **No token in `localStorage`/`sessionStorage`** anywhere in the frontend — the browser never sees the raw session value as JavaScript-readable data.

## Password security

- **Never** logged, never returned in any API response (`UserDTO` — `src/api/dto.ts` — has no password field at all; `toUserDTO` doesn't accept the hash as input, so there's no representable bug where a route accidentally returns it).
- Length floor (10 characters) enforced at the API boundary, not a composition policy (uppercase/digit/symbol rules) — composition rules are well-documented (NIST SP 800-63B) to push people toward predictable patterns more than they help; length is what actually matters for `scrypt`-hashed storage.
- Verified with `crypto.timingSafeEqual`, not `===` — the comparison time doesn't leak how much of the derived hash matched.

## Rate limiting

A minimal, **in-memory, per-process** fixed-window limiter on `/auth/login` and `/auth/register` (`src/api/rate-limit.ts`) — 10 attempts per 15 minutes per IP+email. This is explicitly not sufficient once more than one API process is running (each process has independent counters) — a production deployment needs a shared store (Redis or similar). Not built here: the brief for this step explicitly says not to introduce Redis. Documented as a known gap, not silently missing.

## Registration

`POST /auth/register` is open in this MVP — no invite code, no admin approval gate. That's acceptable **only** behind the same trusted-network boundary the rest of the MVP already assumes (see [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md)): anyone who can reach this API can create an account and start using it. **Before this is exposed beyond a trusted local/dev network, registration needs to be gated** — an invite flow, an admin-provisioning step, or an allowlisted email domain, none of which are built here (organizations/RBAC are explicitly out of scope for this step).

## Migrations

`src/persistence/migrations/003_auth.sql` adds `users.password_hash`, `projects.owner_id`, and the new `sessions` table. **Development reset note**: any local `.data/platform.sqlite` from Steps 1–5 only ever contained the placeholder bootstrap "system" user (no real password, unusable for login) — there's no real user data to migrate. Delete that file and let the app create a fresh one; this is a documented reset path, not silent data loss.

## Future extension point: OAuth/SSO

Not built in this step (explicitly out of scope). The seam it would occupy: `AuthService.login`/`register` are the only places that turn a credential into a session; an OAuth provider would add a third method (e.g. `loginWithOAuthCode`) that verifies a provider's token/code and either finds or creates a `User` by a new `oauth_provider`/`oauth_subject` column pair, then issues a session exactly the same way password login does today. Nothing about the session/cookie mechanism, the auth middleware, or authorization would need to change — only how a `User` gets identified in the first place.

## Known limitations

- No password reset / "forgot password" flow.
- No email verification.
- No multi-factor authentication.
- Rate limiting is per-process and in-memory (see above) — not sufficient for a multi-process deployment.
- Registration is open (see "Registration" above).
- No "view/revoke my other sessions" UI, though the data model (`sessions` table, one row per session) already supports building one.
- No CSRF token — relies on `SameSite=Lax` plus same-origin deployment (see "Browser security").
