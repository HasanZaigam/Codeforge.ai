import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { CodingEngine, EngineInvocationRequest, EngineInvocationResult } from "./coding-engine.js";
import { EngineCancelledError, EngineExecutionError, EngineTimeoutError } from "./coding-engine.js";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompt-builder.js";
import { terminateGracefully } from "../process/terminate-gracefully.js";
import { classifyEngineFailure } from "./engine-failure-classifier.js";
import { computeBackoffDelayMs, sleepUnlessAborted } from "./retry-backoff.js";
import type { CostMetadata, Finding, NeedsInputDraft, StepResult } from "../domain/types.js";

export const MAX_LOG_EXCERPT_CHARS = 4000;

/** Bounds so an env var/caller can't accidentally configure a near-infinite or near-zero-delay retry loop. */
const MAX_ALLOWED_RETRIES = 8;
const MAX_ALLOWED_DELAY_MS = 5 * 60 * 1000;

export interface OpenCodeAdapterOptions {
  executablePath?: string;
  model?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Retries AFTER the first attempt for transient/retryable provider
   * failures (HTTP 429/500/502/503/504, or an explicit `isRetryable: true`
   * from the provider) — see engine-failure-classifier.ts. Default 3 (so up
   * to 4 total attempts). Non-retryable failures (auth, invalid
   * model/request) never retry regardless of this value. Configurable via
   * `OPENCODE_MAX_RETRIES`, clamped to [0, 8] — see /docs/CODING_ENGINE.md.
   */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries. Default 1000ms. Configurable via `OPENCODE_RETRY_BASE_DELAY_MS`. */
  retryBaseDelayMs?: number;
  /** Upper bound on any single backoff delay. Default 20000ms. Configurable via `OPENCODE_RETRY_MAX_DELAY_MS`. */
  retryMaxDelayMs?: number;
}

/** Sensitive environment variable patterns/keys that must never enter the OpenCode child process. */
const SENSITIVE_ENV_KEYS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "SESSION_SECRET",
  "JWT_SECRET",
  "DB_PATH",
  "DATABASE_URL",
]);

/**
 * OpenCode coding engine adapter: invokes the open-source `opencode` CLI
 * headlessly (`opencode run --format json --auto [prompt]`) with the
 * workspace directory as cwd, running non-interactively in an isolated
 * task-specific workspace.
 *
 * Security boundary (/docs/SECURITY_ARCHITECTURE.md):
 * 1. Operates strictly within request.workspacePath (cwd).
 * 2. Does NOT inherit platform secrets (GITHUB_TOKEN, CREDENTIAL_ENCRYPTION_KEY,
 *    DB_PATH, session secrets) — sanitized environment only.
 * 3. Does not perform git commit/push/PR creation; those remain platform-owned.
 * 4. Respects AbortSignal for graceful child process termination without orphans.
 */
export class OpenCodeAdapter implements CodingEngine {
  readonly key = "opencode";
  private readonly executablePath: string;
  private readonly model?: string;
  private readonly extraArgs: string[];
  private readonly customEnv?: NodeJS.ProcessEnv;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? process.env.OPENCODE_BIN_PATH ?? "opencode";
    this.model = options.model ?? process.env.OPENCODE_MODEL;
    this.extraArgs = options.extraArgs ?? [];
    this.customEnv = options.env;
    this.maxRetries = clamp(options.maxRetries ?? envInt("OPENCODE_MAX_RETRIES", 3), 0, MAX_ALLOWED_RETRIES);
    this.retryBaseDelayMs = clamp(options.retryBaseDelayMs ?? envInt("OPENCODE_RETRY_BASE_DELAY_MS", 1000), 0, MAX_ALLOWED_DELAY_MS);
    this.retryMaxDelayMs = clamp(options.retryMaxDelayMs ?? envInt("OPENCODE_RETRY_MAX_DELAY_MS", 20_000), this.retryBaseDelayMs, MAX_ALLOWED_DELAY_MS);
  }

  /**
   * Retries a transient provider failure (Gemini/OpenAI/etc. 429/500/502/503/504,
   * or an explicit `isRetryable: true`) with bounded exponential backoff +
   * full jitter, entirely beneath the CodingEngine.run() boundary — the
   * Orchestrator awaits this once and sees either a success or one final
   * EngineExecutionError, so retries never create extra AgentRun rows,
   * branches, commits, or PRs (those all happen only after run() resolves).
   * A non-retryable failure (auth, invalid model/request) or exhausted
   * retries fails fast. See /docs/CODING_ENGINE.md "Retry behavior" and
   * engine-failure-classifier.ts.
   */
  async run(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
    const prompt =
      request.role === "implementer"
        ? buildImplementerPrompt(request.context)
        : buildReviewerPrompt(request.context);

    const totalAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const { stdout, stderr, code } = await this.spawnOnce(prompt, request);

      if (code === 0) {
        return this.parseResult(stdout, stderr, request);
      }

      const classification = classifyEngineFailure(stdout, stderr, code);
      const isLastAttempt = attempt === totalAttempts;

      if (!classification.retryable || isLastAttempt) {
        console.error(
          `[opencode] model=${this.model ?? "(unset)"} ${request.role} attempt ${attempt}/${totalAttempts} failed permanently ` +
            `(category=${classification.category}, retryable=${classification.retryable}): ${classification.reason}`,
        );
        throw new EngineExecutionError(request.role, classification.reason, {
          attempts: attempt,
          retryable: classification.retryable,
          classification: classification.category,
        });
      }

      // Respect the provider's own suggested wait (e.g. Gemini's "Please retry in 48.88s" on a
      // quota-exhaustion 429) when it gave one — retrying sooner than that just re-hits the same
      // still-exhausted quota. Still capped at retryMaxDelayMs so a provider can't force an
      // unbounded wait; see /docs/CODING_ENGINE.md "Retry behavior".
      const backoffDelayMs = computeBackoffDelayMs(attempt, this.retryBaseDelayMs, this.retryMaxDelayMs);
      const delayMs = classification.suggestedDelayMs !== null ? Math.min(Math.max(backoffDelayMs, classification.suggestedDelayMs), this.retryMaxDelayMs) : backoffDelayMs;
      console.warn(
        `[opencode] model=${this.model ?? "(unset)"} ${request.role} attempt ${attempt}/${totalAttempts} failed transiently ` +
          `(category=${classification.category}) — retrying in ${delayMs}ms` +
          `${classification.suggestedDelayMs !== null ? ` (provider suggested ${classification.suggestedDelayMs}ms)` : ""}: ${classification.reason}`,
      );
      await sleepUnlessAborted(delayMs, request.signal, () => new EngineCancelledError(request.role));
    }

    // Unreachable: the loop above always either returns or throws before exhausting totalAttempts.
    throw new EngineExecutionError(request.role, "retry loop exited without a result");
  }

  /**
   * Spawns `opencode run` exactly once and resolves with its raw
   * stdout/stderr/exit code — even on a non-zero exit — so the retry loop in
   * run() can classify the failure. Only spawn-level failures (binary
   * missing, timeout, cancellation) reject directly; those are never
   * retried here (see run()'s per-attempt handling above).
   */
  private spawnOnce(
    prompt: string,
    request: EngineInvocationRequest,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    if (request.signal.aborted) {
      return Promise.reject(new EngineCancelledError(request.role));
    }

    return new Promise((resolve, reject) => {
      const args = ["run", "--format", "json", "--auto"];
      if (this.model) {
        args.push("--model", this.model);
      }
      if (this.extraArgs.length > 0) {
        args.push(...this.extraArgs);
      }
      args.push(prompt);

      const cleanEnv = this.buildCleanEnvironment(request.workspacePath);

      let child;
      try {
        child = spawn(this.executablePath, args, {
          cwd: request.workspacePath,
          stdio: ["ignore", "pipe", "pipe"],
          env: cleanEnv,
        });
      } catch (err) {
        reject(new EngineExecutionError(request.role, err));
        return;
      }

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new EngineTimeoutError(request.role, request.timeoutMs));
      }, request.timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        terminateGracefully(child).then(() => reject(new EngineCancelledError(request.role)));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));

      child.on("error", (err) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        reject(new EngineExecutionError(request.role, err));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        if (request.signal.aborted) {
          // Exited due to our cancellation handler
          return;
        }
        // Non-zero exit resolves (not rejects) here — classification and the retry/fail-fast
        // decision happen one level up, in run(), which needs the raw output either way.
        resolve({ stdout, stderr, code });
      });
    });
  }

  /**
   * Sanitizes process.env to ensure platform secrets never enter the coding
   * engine child process — AND forces `PWD` to match the real workspace
   * directory `spawn()`'s `cwd` option is about to set.
   *
   * Critical isolation fix: `spawn({cwd})` changes the OS-level working
   * directory of the child process, but does NOT update an inherited `PWD`
   * env var — so without this, the child inherited the *worker process's own*
   * stale `PWD` (the platform repo's own directory, since that's where
   * `node .../run-worker.ts` was launched from). OpenCode's own directory
   * resolution (used by its `bash` tool and its project/context detection)
   * was observed, in a real live run, trusting that stale `PWD` over the
   * actual OS cwd — causing it to read and write files in the PLATFORM
   * REPOSITORY itself instead of the isolated task workspace (see
   * /docs/SECURITY_ARCHITECTURE.md "Isolation model" and
   * /docs/CODING_ENGINE.md "Workspace isolation" for why this must never
   * happen). Reproduced directly, fixed by this line, and covered by a
   * regression test — see tests/opencode-adapter.test.ts.
   */
  private buildCleanEnvironment(workspacePath: string): NodeJS.ProcessEnv {
    const baseEnv = this.customEnv ?? process.env;
    const clean: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      // Skip known sensitive keys
      if (SENSITIVE_ENV_KEYS.has(key)) continue;
      // Skip AWS, Jenkins, and sensitive prefix patterns
      if (key.startsWith("AWS_") || key.startsWith("JENKINS_")) continue;
      clean[key] = value;
    }

    clean.PWD = resolvePath(workspacePath);

    return clean;
  }

  /**
   * Translates OpenCode output (JSON stream, single JSON, or structured text)
   * into the platform's standardized StepResult shape.
   */
  private parseResult(
    stdout: string,
    stderr: string,
    request: EngineInvocationRequest,
  ): EngineInvocationResult {
    const combinedLogs = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : "");
    const logExcerpt = combinedLogs.slice(-MAX_LOG_EXCERPT_CHARS);

    let summary = "";
    let isError = false;
    let cost: CostMetadata | null = null;
    let needsInput: NeedsInputDraft | null = null;
    const findings: Finding[] = [];

    // Attempt to parse JSON Lines or single JSON output
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    let parsedAnyJson = false;

    for (const line of lines) {
      if ((line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]"))) {
        try {
          const parsed = JSON.parse(line);
          parsedAnyJson = true;
          this.extractFromJsonRecord(parsed, {
            setSummary: (s) => {
              if (s) summary = summary ? `${summary}\n${s}` : s;
            },
            setError: (e) => {
              if (e) isError = true;
            },
            setCost: (c) => {
              cost = { ...cost, ...c };
            },
            setNeedsInput: (n) => {
              needsInput = n;
            },
            addFinding: (f) => {
              findings.push(f);
            },
          });
        } catch {
          // If a single line fails to parse as JSON, continue
        }
      }
    }

    if (!parsedAnyJson) {
      // Non-JSON fallback: full stdout text is the summary
      summary = stdout.trim() || stderr.trim() || "(no output returned)";
    }

    if (!summary) {
      summary = stdout.trim() || "(no summary returned)";
    }

    const result: StepResult = {
      status: isError ? "blocked" : needsInput ? "needs_input" : "completed",
      summary,
      filesChanged: [],
      diffRef: null,
      confidence: null,
      findings,
      needsInput,
    };

    return {
      result,
      cost,
      logExcerpt,
    };
  }

  private extractFromJsonRecord(
    record: Record<string, unknown>,
    accum: {
      setSummary: (s: string) => void;
      setError: (e: boolean) => void;
      setCost: (c: CostMetadata) => void;
      setNeedsInput: (n: NeedsInputDraft) => void;
      addFinding: (f: Finding) => void;
    },
  ): void {
    if (typeof record.result === "string") {
      accum.setSummary(record.result);
    } else if (typeof record.summary === "string") {
      accum.setSummary(record.summary);
    } else if (typeof record.text === "string") {
      accum.setSummary(record.text);
    } else if (typeof record.message === "string") {
      accum.setSummary(record.message);
    } else if (typeof record.content === "string") {
      accum.setSummary(record.content);
    }

    if (record.is_error === true || record.error) {
      accum.setError(true);
    }

    const costMeta: CostMetadata = {};
    if (typeof record.total_cost_usd === "number") costMeta.costUsd = record.total_cost_usd;
    if (typeof record.cost_usd === "number") costMeta.costUsd = record.cost_usd;
    if (typeof record.duration_ms === "number") costMeta.durationMs = record.duration_ms;
    if (typeof record.input_tokens === "number") costMeta.inputTokens = record.input_tokens;
    if (typeof record.output_tokens === "number") costMeta.outputTokens = record.output_tokens;
    if (Object.keys(costMeta).length > 0) {
      accum.setCost(costMeta);
    }

    if (record.needs_input && typeof record.needs_input === "object") {
      const draft = record.needs_input as Partial<NeedsInputDraft>;
      if (typeof draft.question === "string" && typeof draft.discovered === "string" && typeof draft.blocker === "string") {
        accum.setNeedsInput({
          question: draft.question,
          discovered: draft.discovered,
          blocker: draft.blocker,
          attempted: Array.isArray(draft.attempted) ? draft.attempted : [],
          options: Array.isArray(draft.options) ? draft.options : [],
        });
      }
    }

    if (Array.isArray(record.findings)) {
      for (const f of record.findings) {
        if (f && typeof f === "object" && typeof f.summary === "string" && typeof f.category === "string") {
          accum.addFinding(f as Finding);
        }
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Reads a positive integer env var, falling back to `fallback` if unset, empty, or not a valid non-negative integer. */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
