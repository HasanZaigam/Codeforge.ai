import { spawn } from "node:child_process";
import type { CodingEngine, EngineInvocationRequest, EngineInvocationResult } from "./coding-engine.js";
import { EngineCancelledError, EngineExecutionError, EngineTimeoutError } from "./coding-engine.js";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompt-builder.js";
import { terminateGracefully } from "../process/terminate-gracefully.js";
import type { StepResult } from "../domain/types.js";

const MAX_LOG_EXCERPT_CHARS = 4000;

/**
 * Production CodingEngine implementation: invokes the Claude Code CLI
 * headlessly (`claude -p ... --output-format json`) with the workspace
 * directory as cwd, so the engine reads/edits real files on disk using its
 * own native tools and its own hierarchical CLAUDE.md/AGENTS.md discovery
 * (see CONTEXT_ARCHITECTURE.md) — the platform never re-implements that.
 *
 * SECURITY BOUNDARY (documented per docs/SECURITY_ARCHITECTURE.md): this
 * adapter assumes the workspace it is given is already isolated (see
 * LocalGitWorkspaceProvider's own documented boundary) and that credentials
 * needed for repository access were injected into the environment by the
 * Workspace layer, never passed as CLI arguments or embedded in the prompt.
 *
 * Requires the `claude` CLI to be installed and authenticated in the host
 * environment. Not exercised by the automated test suite or the bundled
 * demo — both use FixtureCodingEngine instead, since this sandbox has
 * neither the CLI nor credentials available (see /docs/MVP_SCOPE.md).
 */
export class ClaudeCodeAdapter implements CodingEngine {
  readonly key = "claude-code";

  async run(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
    const prompt =
      request.promptOverride ??
      (request.role === "implementer" ? buildImplementerPrompt(request.context) : buildReviewerPrompt(request.context));

    const raw = await this.spawnClaude(prompt, request);
    return this.parseResult(raw, request);
  }

  private spawnClaude(prompt: string, request: EngineInvocationRequest): Promise<string> {
    if (request.signal.aborted) {
      return Promise.reject(new EngineCancelledError(request.role));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        "claude",
        ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits"],
        { cwd: request.workspacePath, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new EngineTimeoutError(request.role, request.timeoutMs));
      }, request.timeoutMs);

      // Cancellation: only this invocation's own child process is ever signaled — never a PID/name
      // looked up elsewhere. Graceful SIGTERM first, bounded grace period, then SIGKILL if needed —
      // see terminate-gracefully.ts and /docs/SECURITY_ARCHITECTURE.md.
      const onAbort = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        terminateGracefully(child).then(() => reject(new EngineCancelledError(request.role)));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));

      child.on("error", (err) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        reject(new EngineExecutionError(request.role, err));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        if (request.signal.aborted) {
          // The process exited as a direct result of our own termination — already handled by onAbort.
          return;
        }
        if (code !== 0) {
          reject(new EngineExecutionError(request.role, `exit code ${code}: ${stderr.slice(-2000)}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Claude Code's JSON output is a transcript/result envelope, not our
   * StepResult shape. This adapter is the ONLY place that translates
   * engine-specific output into the platform's structured contract — the
   * rest of the system never sees engine-native shapes.
   */
  private parseResult(raw: string, request: EngineInvocationRequest): EngineInvocationResult {
    let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number } = {};
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new EngineExecutionError(request.role, `unparseable engine output: ${String(err)}`);
    }

    const result: StepResult = {
      status: parsed.is_error ? "blocked" : "completed",
      summary: parsed.result ?? "(no summary returned)",
      filesChanged: [],
      diffRef: null,
      confidence: null,
      findings: [],
      needsInput: null,
    };

    return {
      result,
      cost: { costUsd: parsed.total_cost_usd, durationMs: parsed.duration_ms },
      logExcerpt: raw.slice(-MAX_LOG_EXCERPT_CHARS),
    };
  }
}
