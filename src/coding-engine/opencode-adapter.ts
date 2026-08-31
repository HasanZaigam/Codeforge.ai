import { spawn } from "node:child_process";
import type { CodingEngine, EngineInvocationRequest, EngineInvocationResult } from "./coding-engine.js";
import { EngineCancelledError, EngineExecutionError, EngineTimeoutError } from "./coding-engine.js";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompt-builder.js";
import { terminateGracefully } from "../process/terminate-gracefully.js";
import type { CostMetadata, Finding, NeedsInputDraft, StepResult } from "../domain/types.js";

export const MAX_LOG_EXCERPT_CHARS = 4000;

export interface OpenCodeAdapterOptions {
  executablePath?: string;
  model?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
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

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? process.env.OPENCODE_BIN_PATH ?? "opencode";
    this.model = options.model ?? process.env.OPENCODE_MODEL;
    this.extraArgs = options.extraArgs ?? [];
    this.customEnv = options.env;
  }

  async run(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
    const prompt =
      request.role === "implementer"
        ? buildImplementerPrompt(request.context)
        : buildReviewerPrompt(request.context);

    const { stdout, stderr } = await this.spawnOpenCode(prompt, request);
    return this.parseResult(stdout, stderr, request);
  }

  private spawnOpenCode(
    prompt: string,
    request: EngineInvocationRequest,
  ): Promise<{ stdout: string; stderr: string }> {
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

      const cleanEnv = this.buildCleanEnvironment();

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
        if (code !== 0) {
          const detail = stderr.slice(-2000) || stdout.slice(-2000) || `exit code ${code}`;
          reject(new EngineExecutionError(request.role, `exit code ${code}: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  /**
   * Sanitizes process.env to ensure platform secrets never enter the coding engine child process.
   */
  private buildCleanEnvironment(): NodeJS.ProcessEnv {
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
