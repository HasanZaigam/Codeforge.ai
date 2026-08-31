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
- **Cancellation**: Listens to `request.signal`. On abort, invokes `terminateGracefully(child)` (SIGTERM, 5s grace period, SIGKILL fallback) and rejects with `EngineCancelledError`.

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

---

## 6. Known Limitations & Boundaries
1. **Live Model Credentials**: Running `OpenCodeAdapter` against live LLM providers requires the respective provider's API key (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`) configured in the environment.
2. **No Autonomous Merging**: The coding engine cannot approve or merge Pull Requests; PR merging remains under human authority.
3. **No Direct Remote Git Access**: The coding engine never receives GitHub credentials; source-control operations are handled exclusively by the platform.
