# CLAUDE.md — Platform repository

This file governs work **on this repository** — the Autonomous Software Development Platform product itself. It does not apply to, and is never loaded during, task execution against a *connected project's* codebase (e.g. OTT, E-True, XYZ). See [docs/CONTEXT_ARCHITECTURE.md](./docs/CONTEXT_ARCHITECTURE.md) for why that separation exists and is enforced.

## What this product is

Read [docs/PRODUCT_VISION.md](./docs/PRODUCT_VISION.md) first. One sentence: the platform takes a plain-language task, autonomously drives it through investigation, implementation, testing, self-fix, and independent review against a connected project's real repository, and interrupts a human only when a genuine decision is required.

## Where the reasoning lives

Don't duplicate architectural reasoning into this file — it goes stale. Read the relevant doc instead:

- [docs/PRODUCT_VISION.md](./docs/PRODUCT_VISION.md) — why this exists, north star, non-goals.
- [docs/PRODUCT_REQUIREMENTS.md](./docs/PRODUCT_REQUIREMENTS.md) — functional/non-functional requirements.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layers, responsibilities, key design-question answers, high-level diagram.
- [docs/AGENT_ARCHITECTURE.md](./docs/AGENT_ARCHITECTURE.md) — orchestrator vs. agent roles, why only two agent roles exist, the self-fix loop.
- [docs/TASK_LIFECYCLE.md](./docs/TASK_LIFECYCLE.md) — task states, NEEDS INPUT contract, evidence-based completion, report shape.
- [docs/INTEGRATION_ARCHITECTURE.md](./docs/INTEGRATION_ARCHITECTURE.md) — coding engine / source control / deployment adapter interfaces.
- [docs/SECURITY_ARCHITECTURE.md](./docs/SECURITY_ARCHITECTURE.md) — secrets, isolation, credential scoping.
- [docs/CONTEXT_ARCHITECTURE.md](./docs/CONTEXT_ARCHITECTURE.md) — platform vs. project context, instruction file hierarchy.
- [docs/MVP_SCOPE.md](./docs/MVP_SCOPE.md) — what ships in v1 and what's explicitly deferred.
- [docs/TECHNICAL_DECISIONS.md](./docs/TECHNICAL_DECISIONS.md) — decision log with rationale and alternatives considered.
- [docs/API.md](./docs/API.md) — the HTTP contract the web UI consumes: endpoints, DTOs, error format, auth boundary.
- [docs/UI_ARCHITECTURE.md](./docs/UI_ARCHITECTURE.md) — screen structure, component boundaries, polling strategy, responsive strategy.
- [docs/GITHUB_INTEGRATION.md](./docs/GITHUB_INTEGRATION.md) — GitHub integration, encrypted credential storage, repository/branch validation, PR creation.
- [docs/CODING_ENGINE.md](./docs/CODING_ENGINE.md) — Coding engine abstraction, OpenCode adapter, Claude Code adapter, fixture engine, sanitization and process cancellation.

## Ground rules for working in this repo

- **Platform vs. Project stays separate.** Never add project-specific logic, credentials, or context (for OTT, E-True, or any connected project) into this repository. Project-specific behavior belongs in that project's own repo/config, discovered through the adapters defined in [docs/INTEGRATION_ARCHITECTURE.md](./docs/INTEGRATION_ARCHITECTURE.md).
- **Interfaces before implementations.** Any new coding engine, source-control provider, or deployment provider must implement the existing abstraction (`CodingEngineAdapter`, `SourceControlProvider`, `DeploymentAdapter`) — never bypass it with vendor-specific calls from core logic.
- **Orchestrator stays deterministic.** Task state transitions are rule-based; don't route control-flow decisions through an LLM call.
- **No secrets in code, prompts, or context files.** See [docs/SECURITY_ARCHITECTURE.md](./docs/SECURITY_ARCHITECTURE.md).
- **Don't add agent roles casually.** The two-role design (Implementer, Reviewer) was a deliberate rejection of a larger multi-agent design — see [docs/AGENT_ARCHITECTURE.md](./docs/AGENT_ARCHITECTURE.md) before proposing a new one.
- **MVP boundary is intentional, not incomplete.** Before adding a capability, check [docs/MVP_SCOPE.md](./docs/MVP_SCOPE.md) — an item listed "out of scope" was excluded deliberately, not forgotten.

## Status

Step 8A complete: OpenCode Coding Engine integration — see [docs/CODING_ENGINE.md](./docs/CODING_ENGINE.md). The platform defaults to `OpenCodeAdapter` (`opencode`) behind the vendor-neutral `CodingEngine` abstraction with environment sanitization and graceful cancellation, while preserving `ClaudeCodeAdapter` and `FixtureCodingEngine`. Step 7 real GitHub integration (encrypted PAT storage, PR opening, idempotency) and Step 6 authentication/authorization remain fully operational. Real Jenkins integration and multi-tenant (multi-organization) infrastructure still don't exist — see [docs/MVP_SCOPE.md](./docs/MVP_SCOPE.md).

### Running this repo

Backend (repo root):
- `npm install`
- `npm run typecheck` — strict TypeScript, no emit
- `npm test` — Node's built-in test runner over `tests/*.test.ts`
- `npm run demo` — runs the full task lifecycle twice directly against the domain/orchestrator (no HTTP), against a disposable local git fixture repo: once showing the self-fix loop reaching `REVIEW`, once showing `NEEDS_INPUT` → human answer → `REVIEW`. Uses `FixtureCodingEngine`, not a live Claude Code CLI call — see the security-boundary note at the top of `src/coding-engine/claude-code-adapter.ts`.
- `npm run api` / `npm run worker` — the HTTP server and the background execution poller, as two separate processes (see [TECHNICAL_DECISIONS.md](./docs/TECHNICAL_DECISIONS.md) TD-16); `npm run dev` runs both together for local convenience. Set `CODING_ENGINE=fixture` to exercise them without a real Claude Code CLI/credentials. Full contract in [docs/API.md](./docs/API.md). Every request now needs a session — `curl` against a protected route without first `POST`ing to `/auth/register` or `/auth/login` (and reusing the returned cookie) gets a `401`.
- **Local data reset**: a `.data/platform.sqlite` from before Step 6 has no real user accounts (only the old placeholder), so nothing is lost by deleting it and letting the app create a fresh one — see [docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md) "Migrations."

Frontend (`web/`, its own package — see TECHNICAL_DECISIONS.md TD-20):
- `cd web && npm install`
- `npm run dev` — Vite dev server on `:5173`, proxying `/api` to the backend on `:3000` (see TD-21). Run `npm run api` and `npm run worker` from the repo root alongside it.
- `npm run typecheck` / `npm run build` / `npm run test` (Vitest + Testing Library). Full structure in [docs/UI_ARCHITECTURE.md](./docs/UI_ARCHITECTURE.md).
