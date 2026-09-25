import type { AgentRole, ContextBundle, CostMetadata, ModelSelection, StepResult } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";

/**
 * The platform <-> AI coding engine boundary. No Claude-specific (or any
 * vendor-specific) concept crosses this interface — the Orchestrator and
 * Agent Runtime only ever see ContextBundle in, EngineInvocationResult out.
 * See /docs/INTEGRATION_ARCHITECTURE.md and AGENT_ARCHITECTURE.md.
 */
export interface EngineInvocationRequest {
  role: AgentRole;
  context: ContextBundle;
  /** Absolute path to the already-provisioned, isolated workspace this invocation may read/write. */
  workspacePath: string;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * V1.1 Slice 5 — the platform's own routing decision (see domain/types.ts
   * ModelSelection) for this exact invocation, or `null` when no
   * ModelRouter/ModelRegistry was wired (older callers) or no candidate
   * model was configured/eligible (see routing/model-registry.ts). An
   * adapter that understands per-invocation model selection (OpenCodeAdapter)
   * uses `modelSelection.modelId`; one that doesn't (ClaudeCodeAdapter,
   * FixtureCodingEngine) is free to ignore this field entirely and keep its
   * own prior behavior — this is additive, never a required capability.
   * Optional (not just nullable) so every pre-Slice-5 call site that builds
   * an `EngineInvocationRequest` literal directly (tests, in particular)
   * needs no change — omitted is treated identically to `null`.
   */
  modelSelection?: ModelSelection | null;
  /**
   * Phase 4A (Backlog Intelligence) — when set, an adapter that renders role prompts (OpenCode,
   * Claude Code) sends THIS text verbatim instead of building an Implementer/Reviewer prompt from
   * `context`. This is how a purpose-specific, read-only invocation (backlog analysis) reuses the
   * existing engine boundary, model routing, cancellation and timeout handling WITHOUT adding an
   * agent role (see /docs/AGENT_ARCHITECTURE.md — the two-role design is deliberate). Optional and
   * additive: every existing call site omits it and behaves exactly as before; an adapter that
   * doesn't render prompts (FixtureCodingEngine) simply receives it and may inspect it.
   */
  promptOverride?: string;
}

export interface EngineInvocationResult {
  result: StepResult;
  cost: CostMetadata | null;
  /** Raw log tail for "View Details" — bounded, never containing secrets. */
  logExcerpt: string;
}

/**
 * Usage the engine really emitted before an invocation ended abnormally (GAP-034), attached to the error so
 * the caller can persist it on the failed AgentRun instead of losing it. `null` = none was emitted/captured.
 */
export interface FailedInvocationUsage {
  usage: CostMetadata | null;
}

export class EngineTimeoutError extends Error implements FailedInvocationUsage {
  usage: CostMetadata | null = null;
  constructor(role: AgentRole, timeoutMs: number) {
    super(`Coding engine invocation (${role}) exceeded timeout of ${timeoutMs}ms`);
    this.name = "EngineTimeoutError";
  }
}

export interface EngineFailureMetadata {
  /** How many total invocation attempts were made before giving up (1 = failed on the first try, no retry). */
  attempts: number;
  /** Whether the underlying failure was classified as transient/retryable — false if it failed fast on purpose. */
  retryable: boolean;
  /** Coarse failure category (e.g. "rate_limit", "server_unavailable", "auth") — see engine-failure-classifier.ts. */
  classification: string;
}

export class EngineExecutionError extends Error implements FailedInvocationUsage {
  usage: CostMetadata | null = null;
  /** Present only when the adapter performed structured failure classification (currently: OpenCodeAdapter). */
  readonly meta: EngineFailureMetadata | null;

  constructor(role: AgentRole, cause: unknown, meta: EngineFailureMetadata | null = null) {
    super(`Coding engine invocation (${role}) failed${meta ? ` after ${meta.attempts} attempt${meta.attempts === 1 ? "" : "s"}` : ""}: ${String(cause)}`);
    this.name = "EngineExecutionError";
    this.meta = meta;
  }
}

/**
 * Thrown instead of resolving/EngineExecutionError when `request.signal` is
 * (or becomes) aborted — the platform's cancellation signal (see
 * /docs/TASK_LIFECYCLE.md "Cancellation"). Extends the shared
 * CancellationError so the Orchestrator can catch cancellation uniformly
 * regardless of which layer (coding engine, validation runner) it came
 * from, without needing to know engine-specific error types.
 */
export class EngineCancelledError extends CancellationError implements FailedInvocationUsage {
  usage: CostMetadata | null = null;
  constructor(role: AgentRole) {
    super(`Coding engine invocation (${role}) was cancelled`);
    this.name = "EngineCancelledError";
  }
}

/**
 * Implemented once per supported coding engine (Claude Code first). A
 * project selects an engine by key (Project.codingEngine); the Orchestrator
 * never imports a concrete adapter directly — see CodingEngineRegistry.
 *
 * Cancellation contract: `request.signal` may fire at any point during
 * `run()`, including before it's even called. An implementation MUST, on
 * abort, stop whatever process/work it owns for this invocation (gracefully
 * where possible) and reject with `EngineCancelledError` — never resolve
 * normally, and never leave the underlying process running. See
 * ClaudeCodeAdapter for the reference implementation (graceful SIGTERM,
 * bounded grace period, then SIGKILL).
 */
export interface CodingEngine {
  readonly key: string;
  run(request: EngineInvocationRequest): Promise<EngineInvocationResult>;
}

export class UnknownCodingEngineError extends Error {
  constructor(key: string) {
    super(`No CodingEngine registered for key "${key}"`);
    this.name = "UnknownCodingEngineError";
  }
}

/** Simple provider registry — how a new engine is added without touching core logic. */
export class CodingEngineRegistry {
  private readonly engines = new Map<string, CodingEngine>();

  register(engine: CodingEngine): void {
    this.engines.set(engine.key, engine);
  }

  resolve(key: string): CodingEngine {
    const engine = this.engines.get(key);
    if (!engine) throw new UnknownCodingEngineError(key);
    return engine;
  }
}

/** The usage an engine error carries, if any (never fabricated: an error with no captured usage yields `null`). */
export function usageFromError(err: unknown): CostMetadata | null {
  const usage = (err as Partial<FailedInvocationUsage> | null)?.usage;
  return usage && typeof usage === "object" ? usage : null;
}
