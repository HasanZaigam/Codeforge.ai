# Model Gateway

Account-scoped, multi-provider AI configuration — "models are replaceable; CodeForge owns state, context, orchestration, execution, verification, and evidence." Every AI-powered operation (Chat, task implementation/review, backlog analysis) resolves its model/provider/credential through ONE gateway, never a scattered, per-feature choice.

## What already existed, and what this feature extends

This was built as an **extension**, not a rebuild, of substantial pre-existing infrastructure (V1.1 Slice 5, "Hybrid Model Routing"):

- **Deterministic routing** (`routing/model-router.ts`'s `selectModel`) — unchanged. Given a `ModelRegistry` and a `ProviderHealthLookup`, returns the first enabled, healthy candidate for an engine key; `null` when none is available. Never randomized, never a fabricated "intelligence score."
- **Provider-health/cooldown tracking** (`persistence/repositories/provider-health-repository.ts`, migration 012) — unchanged, still global per `providerId` (a documented simplification: "not a distributed production-grade circuit breaker").
- **Per-execution model/provider persistence** (`agent_runs.model_id`/`provider_id`/`fallback_index`, migration 012) — unchanged; this is what the new usage rollup reads.
- **The `CodingEngine` abstraction** (`coding-engine/coding-engine.ts`) — OpenCode is already provider-agnostic via its own `<provider>/<model>` convention (`inferProviderId`). `EngineInvocationRequest.modelSelection` was already the injection point a gateway needed; this feature adds one sibling field, `credentialEnv` (see below) — the SAME additive pattern `modelSelection` itself used.
- **Encrypted credential storage** (`auth/credential-encryption.ts`, AES-256-GCM) — reused AS-IS. No new crypto; provider API keys are encrypted with the exact same `encryptSecret`/`decryptSecret`/`loadEncryptionKey` functions GitHub PATs already use.
- **One shared model-call path** — Chat and backlog analysis already funnel through `BacklogAnalyzer` → `CodingEngineRegistry` → the SAME `ModelRegistry`/routing task execution uses. There was never a second call path to unify; the gateway extends the one that exists.

What's genuinely new: encrypted, account-scoped provider connections; a persisted Global AI Brain (Auto/Fixed) configuration; the `ModelGatewayService` that resolves an account's connections into a per-call `ModelRegistry` (instead of the one static, env-derived registry every account previously shared); `EngineInvocationRequest.credentialEnv`; the Settings UI; and a per-provider usage rollup.

## Data model (migration 027)

- `provider_connections` — one row per `(user_id, provider)`. `provider` is `'google' | 'anthropic' | 'openai'`. The API key is stored as `encrypted_api_key`/`api_key_iv`/`api_key_auth_tag` (the same three-column shape `github_credentials` already uses) — never plaintext. `status` is `'connected' | 'disconnected' | 'error'`; `last_verified_at`/`last_error` record the most recent real validation result.
- `global_ai_configuration` — one row per user. `mode` is `'auto' | 'fixed'`. `fixed_provider`/`fixed_model` apply only in Fixed mode. `auto_allowed_providers_json` is `null` (meaning "every currently connected provider") or an explicit JSON array.

Both are scoped by `User.id` — the existing "MVP access model is User → owns → Project" (`Project.ownerId`'s own doc comment), reused rather than inventing a new account/organization concept this repo's MVP_SCOPE explicitly doesn't have yet.

## `ModelGatewayService` (`src/application/model-gateway-service.ts`)

Two halves:

**Account management** (consumed by the API routes): `listConnections`, `connectProvider` (validates with a REAL provider API call before persisting anything — see Provider adapters below — never trusts a client-supplied key), `testConnection` (re-validates an existing connection on demand), `disconnectProvider`, `getGlobalConfig`, `setGlobalConfig` (rejects a Fixed selection or an Auto-allowed provider that isn't actually connected — never silently accepted), `getUsageSummary`.

**Resolution** (`resolveModelSelection(ownerId, engineKey, operation, fallbackIndex, now, legacyRegistry)`) — the actual gateway every AI execution goes through:

1. **Zero provider connections** → the backward-compatible bridge: resolves through `legacyRegistry` (the pre-existing, static, env-derived `ModelRegistry` from `OPENCODE_MODEL`) exactly as before this feature existed. An account that never touches Settings → AI/Models sees NO behavior change.
2. **Fixed mode** → builds a one-candidate `ModelRegistry` from the fixed connection and calls the UNCHANGED `selectModel`. If that connection isn't currently `connected`, throws `ModelGatewayResolutionError` with an actionable message ("X is selected as the global AI brain, but its connection is unavailable...") — **never silently falls back to a different provider.**
3. **Auto mode** → builds a `ModelRegistry` from every connected, Auto-allowed provider and calls the SAME unchanged `selectModel` — so a provider currently in cooldown (observed failures) is skipped in favor of the next allowed, healthy one, exactly like the pre-existing single-model routing already did for retries.

Returns `{selection, credentialEnv, hadCandidates}`. `credentialEnv` is the resolved provider's REAL decrypted API key, keyed by the environment variable name its adapter declares (e.g. `{ANTHROPIC_API_KEY: "sk-..."}`) — decrypted only in memory, for this one call.

## Reaching the engine: `EngineInvocationRequest.credentialEnv`

A new, additive, optional field (same posture as `modelSelection` itself): an adapter that understands it (`OpenCodeAdapter`) merges it into the sanitized child-process environment it already builds, AFTER the existing secret-stripping pass — so a per-account BYOK key always wins over any operator-wide fallback key, and is NEVER logged (it only ever reaches `spawn()`'s `env` option). An adapter that doesn't understand it (`ClaudeCodeAdapter`, `FixtureCodingEngine`) simply ignores it.

## Wiring: Orchestrator and BacklogAnalyzer

Both gained an optional, trailing `modelGateway: ModelGatewayLookup | null` constructor parameter (see TD-60 for why this is a narrow interface, not the concrete `ModelGatewayService` class). At their existing model-selection call site, when a gateway is wired, they call `resolveModelSelection(project.ownerId, ...)` instead of the raw `selectModel(...)` call directly — falling back to the exact prior behavior when no gateway is wired at all (every pre-existing direct-construction test, and any future caller that doesn't need this feature, needs no change).

A `ModelGatewayResolutionError` (Fixed-mode-unavailable) is handled per each caller's own existing contract — see TD-60: the Orchestrator lets it propagate into its existing error → `TASK_FAILED` handling (no `AgentRun` row is created for the failed resolution); `BacklogAnalyzer.run()` — whose contract is to never throw — catches it and returns an honest `{ok: false}` outcome instead.

## Provider adapters (`src/providers/provider-adapter.ts`)

One per supported provider, each with a REAL network call to validate a key/model (never a fabricated "connected"):

- **Google** — `GET generativelanguage.googleapis.com/v1beta/models`, authenticated via the `X-goog-api-key` header (Google's current, documented mechanism — a real, currently-issued key was confirmed live to be REJECTED via the older `?key=` query-string form with `API_KEY_INVALID`, so the header is the only form used, for every key), env var `GEMINI_API_KEY`.
- **Anthropic** — `GET api.anthropic.com/v1/models`, env var `ANTHROPIC_API_KEY`. Deliberately the models-list endpoint, never a completion call — validating a key never spends a generation token.
- **OpenAI** — `GET api.openai.com/v1/models`, env var `OPENAI_API_KEY`.

Each reports `{valid, error}` — a rejected key, or a key valid but naming a model the account doesn't have access to, are both distinct, actionable, non-secret-bearing error messages.

## Usage (`reporting/provider-usage-rollup.ts`)

Reuses the EXISTING per-`AgentRun` `cost_json` (no new usage-tracking mechanism) via a new, owner-scoped read (`AgentRunRepository.listUsageForOwner`), grouped by the run's own recorded `provider_id`. Follows the SAME honesty rules the pre-existing task-level `reporting/usage-rollup.ts` established: a field is `null` (never a fabricated `0`) when no run under that provider reported it; a run with no recorded `provider_id` (pre-Model-Gateway rows, or a `FixtureCodingEngine` test run) is grouped under `"unknown"`, never silently dropped.

## Settings UI

`Settings → AI / Models` (`web/src/components/settings/AiModelsCard.tsx`): a Global AI Brain selector (Auto / Fixed + provider), a connected-providers list (Connect / Test connection / Manage / Disconnect per provider, via `ConnectProviderDialog.tsx` — API key + model, verified before saving, mirroring the existing `GitHubConnectDialog` pattern exactly), Auto's allowed-provider checkboxes, and an AI Usage summary. Deliberately simple per this feature's own brief: no routing-rule DSL, no model marketplace, no cost optimizer. The pre-existing read-only `GET /settings/ai-model` endpoint (reporting the platform's one env-configured model) is untouched — it still truthfully describes the backward-compatible fallback an account with zero connections uses.

**Model picker**: paste the API key, click "Load models," and pick from a dropdown of that key's REAL available models (`POST /settings/ai-gateway/providers/:provider/models` → `ModelGatewayService.listAvailableModels` → the adapter's own `listModels`, the exact same provider endpoint `connectProvider`'s validation call already uses) — nobody has to remember or type an exact model id. This is a pre-connect, read-only call against the provider's own API; it never persists anything. If the list call fails (or hasn't been run yet), a free-text fallback field is still available — never a hardcoded model catalog either way.

## What this phase deliberately does NOT do

- **No Context Builder / model-neutral compaction** (the "4-layer context architecture" / automatic compaction near a context-window threshold) — scoped out as its own, equally large follow-up phase (confirmed with the user before starting this one). Nothing here changes how much context any AI call receives.
- **No per-task or per-message model selection** — only one account-wide Global AI Brain.
- **No model marketplace or cost optimizer.**
- **No complex Auto routing DSL** — Auto is "first allowed, connected, healthy candidate," via the same deterministic `selectModel` policy that already existed.

## Tests

`tests/model-gateway.test.ts` — provider-connection CRUD (connect validates via a real adapter call before persisting; failure never persists; the stored secret is genuinely encrypted; masked DTOs never include the raw key; disconnect really deletes the row), Global AI Brain configuration (Fixed/Auto validation against actually-connected providers), `resolveModelSelection` (backward-compatible zero-connections bridge; Fixed mode success and its never-silently-falls-back failure; Auto mode skipping a cooldown provider and respecting the allowed list), the usage rollup's honesty rules, and three full Orchestrator end-to-end tests: a Fixed brain's decrypted credential genuinely reaching a `FixtureCodingEngine` invocation and being recorded on the real `AgentRun` row; a Fixed brain naming a disconnected provider failing the task with the actionable message and creating zero `AgentRun` rows; and the backward-compatibility bridge verified against a real task execution. All provider-adapter validation in these tests uses a scripted (never real-network) adapter — **live verification against real Google/Anthropic/OpenAI API keys has not been performed**; that is the one acceptance-test category (connect/test against a genuinely live key) still pending real credentials.
