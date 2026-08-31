# Coding Engine Architecture & Adapters

This document details the platform's **Coding Engine abstraction** and its concrete adapter implementations: `OpenCodeAdapter`, `ClaudeCodeAdapter`, and `FixtureCodingEngine`.

---

## 1. Architectural Role & Boundary

The Coding Engine is an **interchangeable execution component**, not an agent role and not a control-flow authority.

```
                    WEB DASHBOARD
                          |
                          v
                         API
                          |
                          v
                    APPLICATION
                          |
                          v
                    ORCHESTRATOR
                          |
                          v
                    CodingEngine
                          |
              +-----------+-----------+
              |           |           |
              v           v           v
           OpenCode   Claude Code   Fixture
              |
              v
        Model Provider
```

### Core Invariants
1. **The Orchestrator is vendor-agnostic**: It only ever communicates through `CodingEngine.run(request: EngineInvocationRequest): Promise<EngineInvocationResult>`.
2. **OpenCode and Claude Code are execution engines, not agent roles**: The platform has exactly two agent roles (`implementer` and `reviewer`). Either engine can execute either role.
3. **The platform owns Git and GitHub delivery**: The coding engine modifies files on disk inside the isolated workspace; the platform's deterministic gates perform build/test validation, commit, push, and Pull Request creation.
4. **Platform secrets never enter the coding engine**: The engine process receives a sanitized environment; GitHub tokens, session secrets, database paths, and encryption keys are strictly omitted.

---

## 2. The `CodingEngine` Interface Contract

Defined in `src/coding-engine/coding-engine.ts`:

```typescript
export interface EngineInvocationRequest {
  role: AgentRole; // "implementer" | "reviewer"
  context: ContextBundle;
  workspacePath: string; // Absolute path to isolated workspace
  timeoutMs: number;
  signal: AbortSignal;
}

export interface EngineInvocationResult {
  result: StepResult;
  cost: CostMetadata | null;
  logExcerpt: string; // Bounded tail (max 4000 chars), secret-free
}

export interface CodingEngine {
  readonly key: string;
  run(request: EngineInvocationRequest): Promise<EngineInvocationResult>;
}
```

### Registry & Selection
Engines are registered in `CodingEngineRegistry` and resolved per-project via `Project.codingEngine` (defaulting to the environment selection in `CODING_ENGINE`).

---

## 3. Adapters

### A. OpenCodeAdapter (`key = "opencode"`)
The primary open-source coding engine adapter for MVP execution.

- **Executable**: `opencode` CLI (configured via `OPENCODE_BIN_PATH` or `options.executablePath`).
- **Invocation**: Non-interactive headless execution:
  ```bash
  opencode run --format json --auto [--model <model>] "<prompt>"
  ```
- **Working Directory**: Set to `request.workspacePath` (`cwd`).
- **Standard Input**: Redirected (`stdio: ["ignore", "pipe", "pipe"]`) to prevent blocking on interactive TUI prompts.
- **Output Parsing**: Parses streaming JSON Lines (NDJSON), JSON objects, or formatted text into `StepResult`, extracting `summary`, `cost`, `findings`, and `needsInput` drafts.
- **Cancellation**: Listens to `request.signal`. On abort, invokes `terminateGracefully(child)` (SIGTERM, 5s grace period, SIGKILL fallback) and rejects with `EngineCancelledError`. A cancellation arriving while a retry is waiting out its backoff delay preempts the wait immediately (see "Retry behavior" below) rather than sleeping it out.

#### Retry behavior for transient provider failures

A model provider outage (e.g. Gemini/OpenAI/Anthropic returning HTTP 429/500/502/503/504, or explicitly marking its own error `isRetryable: true`) makes `opencode run` exit non-zero. Before this was fixed, that exit code was turned directly into a permanent `EngineExecutionError` with no retry — a transient few-second provider blip killed the entire task (`AGENT_FAILED` → `TASK_FAILED`).

`OpenCodeAdapter.run()` now retries transient failures with bounded exponential backoff + full jitter, entirely beneath the `CodingEngine` interface — **the Orchestrator is unaware retries happen at all**: it still awaits one `engine.run()` call and gets back either a success or one final `EngineExecutionError`. This is why retries can never duplicate an `AgentRun`, branch, commit, or PR — those are all created outside and after `engine.run()` resolves (see `Orchestrator.runAgent`/`prepareChanges`/`ensurePullRequest`). Verified live against real Gemini (see `.data/platform.sqlite` task history and `tests/*.test.ts`'s live-captured payload fixtures) on 2026-08-31/09-01.

**Provider-suggested wait time is respected, not just blind exponential backoff.** A live free-tier Gemini 429 (`RESOURCE_EXHAUSTED`, quota exceeded) explicitly says e.g. `"Please retry in 48.88s."` in its message — retrying on our own default ~1-20s backoff just re-hits the same still-exhausted quota. `engine-failure-classifier.ts`'s `parseSuggestedDelayMs()` extracts this hint from the message text; the adapter uses `max(exponentialBackoff, suggestedDelay)`, still capped at `retryMaxDelayMs` so a provider can never force an unbounded wait. This was discovered and fixed via a real live smoke test, not a hypothetical — see the `18c`/`18d` tests in `tests/opencode-adapter.test.ts`.

**`responseBody` shape**: the real (live-captured) OpenCode/Gemini payload sends `error.data.responseBody` as a JSON-encoded **string** (the raw HTTP response body, e.g. `"{\n  \"error\": {...}}\n"`), not a pre-parsed object as an earlier version of this doc assumed. `extractResponseBodyError()` in `engine-failure-classifier.ts` handles both shapes and never throws on a malformed one — see `tests/engine-failure-classifier.test.ts`.

Classification (`src/coding-engine/engine-failure-classifier.ts`) parses OpenCode's own `{"type":"error","error":{...}}` NDJSON record and is deliberately conservative — an error that doesn't look like a recognized transient-provider failure is **not** retried:

| Signal | Category | Retried? |
|---|---|---|
| `isRetryable: true` (explicit, from the provider) | whatever `statusCode` indicates, or `unknown` | Yes |
| HTTP 429 | `rate_limit` | Yes |
| HTTP 500 / 502 / 503 / 504 | `server_unavailable` | Yes |
| HTTP 401 / 403, or a message matching "invalid api key" / "unauthorized" / "authentication" | `auth` | **No** — fails on the first attempt |
| HTTP 400, or a message matching "invalid model" / "malformed" / "bad request" | `invalid_request` | **No** |
| No structured error found at all (plain stderr text) | `unknown` | **No** — same behavior as before this fix |

On exhaustion, the final `EngineExecutionError.message` reads e.g. `"Coding engine invocation (implementer) failed after 4 attempts: Gemini returned retryable HTTP 503 UNAVAILABLE: This model is currently experiencing high demand..."` — never just `"exit code 1"`. `EngineExecutionError.meta` (`{attempts, retryable, classification}`) is also attached for callers that want structured detail (the Orchestrator uses it for its worker-terminal log line — see "Observability" below).

**OpenCode's own retry behavior**: as of the version tested (`opencode-ai@1.18.25`), OpenCode does not itself retry this class of provider error — the observed failure is a single `type:"error"` event followed immediately by exit 1, with no repeated attempts. If a future OpenCode version adds its own provider-level retry, revisit whether this adapter's retry becomes redundant.

### B. ClaudeCodeAdapter (`key = "claude-code"`)
The reference CLI adapter for Claude Code.

- **Executable**: `claude` CLI.
- **Invocation**: `claude -p "<prompt>" --output-format json --permission-mode acceptEdits`
- **Working Directory**: Set to `request.workspacePath`.
- **Cancellation**: Graceful process termination via `terminateGracefully`.

### C. FixtureCodingEngine (`key = "fixture"`)
Deterministic, scriptable in-memory adapter used by automated test suites and local demos.

- Satisfies the exact same `CodingEngine` interface.
- Executes role-specific handlers without external CLI or API dependencies.

---

## 4. Security & Environment Sanitization

OpenCode runs as a separate, untrusted child process. `OpenCodeAdapter` constructs a clean environment for every invocation:

### Sanitization Policy
- **Forbidden Variables (Stripped)**:
  - `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, `GITHUB_SECRET`
  - `CREDENTIAL_ENCRYPTION_KEY`
  - `SESSION_SECRET`, `JWT_SECRET`
  - `DB_PATH`, `DATABASE_URL`
  - `AWS_*`, `JENKINS_*`
- **Allowed Variables (Forwarded)**:
  - System runtime: `PATH`, `HOME`, `TMPDIR`, `USER`, `SHELL`, `LANG`, `TERM`, etc.
  - Model provider API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_*`.

---

## 5. Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODING_ENGINE` | `opencode` | Default engine key (`opencode`, `claude-code`, `fixture`) |
| `OPENCODE_BIN_PATH` | `opencode` | Path to the `opencode` binary |
| `OPENCODE_MODEL` | *(none / opencode default)* | Default model passed via `--model` flag |
| `OPENCODE_MAX_RETRIES` | `3` | Retries after the first attempt for a transient/retryable provider failure (so up to 4 total attempts by default). Clamped to `[0, 8]` regardless of what's set — see "Retry behavior" above. |
| `OPENCODE_RETRY_BASE_DELAY_MS` | `1000` | Base delay for exponential backoff between retries (full jitter: actual wait is uniformly random in `[0, min(base·2^(attempt-1), max)]`). |
| `OPENCODE_RETRY_MAX_DELAY_MS` | `20000` | Upper bound on any single backoff wait. Clamped to `[base, 300000]`. |

---

## 6. Observability

`Worker.tick()` logs `[worker] picked up task <id> ("<title>") [status=<status>]` the moment it starts driving a task, and `[worker] task <id> finished with status <status>` when `executeTask()` returns — so the worker terminal shows activity even for a task that ultimately succeeds, not only failures.

`Orchestrator.runAgent`'s catch block logs one line per failed agent invocation to the worker's terminal — `[orchestrator] task <id> ("<title>") — <role> failed on self-fix attempt <n> [engine=<key>, invocationAttempts=<meta.attempts>, retryable=<meta.retryable>, classification=<meta.classification>]: <message>` — so a task landing in `FAILED` is never silent in the worker process's stdout/stderr, without needing to inspect the database. `OpenCodeAdapter` itself additionally logs one line per individual retry attempt (`[opencode] <role> attempt <n>/<total> failed transiently ... — retrying in <delay>ms[ (provider suggested <ms>ms)]: <reason>`) and one final line when it gives up. Nothing here logs the raw `Error` object, environment, or any credential — only the already-sanitized `.message` string, which adapters never populate with secrets.

## 7. Known Limitations & Boundaries
1. **Live Model Credentials**: Running `OpenCodeAdapter` against live LLM providers requires the respective provider's API key (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`) configured in the environment.
2. **No Autonomous Merging**: The coding engine cannot approve or merge Pull Requests; PR merging remains under human authority.
3. **No Direct Remote Git Access**: The coding engine never receives GitHub credentials; source-control operations are handled exclusively by the platform.
4. **No automatic model fallback**: if the configured model (`OPENCODE_MODEL`, e.g. `gemini-3-flash-preview`) is unavailable long enough to exhaust all retries, the task fails — it does not silently fall back to a different model. Retrying the *same* model is what actually fixes a transient outage (the failure is the provider being temporarily overloaded, not the model being wrong); substituting a different model automatically would mean code changes get made by a model the user never chose, without their knowledge. Falling back to a configured secondary model is a reasonable future enhancement, but needs to be an explicit, documented per-project opt-in — not implemented here.
5. **Timeouts are not retried**: if an invocation hits `agentInvocationTimeoutMs` (default 10 minutes — see `orchestrator/config.ts`), it fails immediately rather than retrying, since retrying a multi-minute timeout could silently turn one task into a very long-running one with no additional bound. Only a fast, structured provider error response (429/5xx) is retried.
