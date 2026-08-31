# Security Architecture

The platform executes AI-driven code changes against real repositories and, eventually, real deployment targets. Security is a first-class concern from MVP, not a later hardening pass — retrofitting isolation and credential scoping into a system that started without them is far more expensive than designing for it now.

## Threat surface

- Untrusted/uncertain LLM output executing shell commands and editing files.
- Credentials for source control and (later) deployment/cloud.
- Multi-project, eventually multi-tenant, data and secret isolation.
- A human-in-the-loop UI that can trigger real, hard-to-reverse actions (push, PR, deploy).

## Principles

1. **No raw credentials in prompts, logs, or source files.** Credentials are injected into the execution environment (env vars / mounted short-lived files) by the Workspace provisioning step, never included in any text sent to a coding engine or persisted in the task record/event log.
2. **Least privilege, scoped, short-lived.** A workspace receives only a credential scoped to the one repository the task targets, with an expiry tied to the task's execution window — not a broad personal-access token reused across tasks.
3. **Sandboxed execution.** Every task runs in an isolated, ephemeral container: no access to other tasks' workspaces, other projects' credentials, or the host beyond what the project's declared build/test environment requires.
4. **Command execution restrictions.** The execution environment applies a constrained policy (resource limits; network access limited to what the project's build/test/dependency-install step needs) rather than unrestricted host access.
5. **Deployment requires explicit human approval.** No gate pass ever triggers a deployment automatically — a human action in the UI is required before the Deployment abstraction is invoked (see [INTEGRATION_ARCHITECTURE.md](./INTEGRATION_ARCHITECTURE.md)).
6. **Audit everything.** Every state transition, gate result, and agent action is recorded in the append-only task event log (see [ARCHITECTURE.md](./ARCHITECTURE.md#16-observability--audit)) — who/what triggered a change is always reconstructable.
7. **Project isolation now, tenant isolation ready.** MVP runs single-tenant, but `tenant_id` is present on every relevant table and every workspace/credential scoping decision is made at the project level — so tenant-level isolation is a policy change, not a schema migration, when multi-tenant ships.

## Secrets management

- **What's stored**: a *reference* (e.g. a secret-manager path/ID) in the platform database — never the secret value itself.
- **What's issued at runtime**: the Workspace provisioning step resolves the reference against a secrets manager and injects a scoped, short-lived credential directly into the container for that task's duration only.
- **MVP**: a single, operator-managed secrets store (e.g. a managed secrets manager or, for pure local dev, an encrypted local store) — the interface is what matters, so this is swappable later without touching how credentials are consumed by the Workspace layer.
- **Never**: secrets committed to project repos, embedded in project context files, or written into task records/reports.
- **Implemented (Step 7 & 8A) — GitHub credentials & Engine Sanitization**: the first concrete secret type stored by the platform. AES-256-GCM at rest (`src/auth/credential-encryption.ts`), key from `CREDENTIAL_ENCRYPTION_KEY` (env, resolved lazily), one credential per user. Injected into the platform's own `git clone`/`push` child processes only, as ephemeral environment variables (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`) — never written to `.git/config` (which the coding engine can read), never a CLI flag (visible via `ps aux`), never embedded in a clone URL. Coding engine adapters (`OpenCodeAdapter`, `ClaudeCodeAdapter`) sanitize their child process environments to ensure `CREDENTIAL_ENCRYPTION_KEY`, `GITHUB_TOKEN`, and platform secrets never enter the coding agent. Full design in [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) and [CODING_ENGINE.md](./CODING_ENGINE.md).

## Isolation model

- **Per-task workspace**: fresh clone/worktree, dedicated branch, dedicated container, torn down after the task's step completes or the task reaches a terminal/paused state.
- **Per-project boundary**: a project's credentials, context files, and workspace are never accessible from another project's task execution, even when tasks run concurrently on the same worker pool.
- **Per-tenant boundary (future)**: same mechanism, one level up — workspaces, secrets, and data queries are always scoped by `tenant_id` once multi-tenant is enabled.

## Authentication & Authorization

**Implemented (Step 6)** — see [AUTHENTICATION.md](./AUTHENTICATION.md) for the full design. Summary: server-side sessions (opaque token, HttpOnly `SameSite=Lax` cookie, no JWT, no client-side secret storage), `crypto.scrypt` password hashing, and ownership-based authorization (`User -> owns -> Project -> tasks`) enforced in the application layer on every request — never left to the frontend. Every project/task access check returns `404`, not `403`, for a resource that exists but isn't the caller's, so the API never confirms existence to an unauthorized caller.

- **Deployment approval** and any future "risky action" (e.g. merging, force-pushing) are treated as privileged actions distinct from ordinary task creation — eligible for stricter checks later (e.g. requiring a specific role) without redesigning the auth model, because authorization is already action-scoped, not just project-scoped.

## What's explicitly deferred (and why that's safe)

- Fine-grained RBAC beyond project membership — not needed with one role (developer) in MVP; the authorization boundary is already action-scoped so adding roles later is additive.
- A dedicated enterprise secrets/HSM integration — MVP uses one pluggable secrets-manager interface; swapping the backend doesn't change any calling code.
- Network egress allowlisting per project — MVP uses a conservative default sandbox policy; per-project policy is a config addition to the same Workspace abstraction, not a new layer.

See [MVP_SCOPE.md](./MVP_SCOPE.md) for the explicit in/out boundary.
