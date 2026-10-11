import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextBundle, CostMetadata, ModelSelection, Project } from "../domain/types.js";
import { CancellationError } from "../domain/errors.js";
import { CodingEngineRegistry, EngineTimeoutError, UnknownCodingEngineError, usageFromError, type CodingEngine } from "../coding-engine/coding-engine.js";
import { mergeCostMetadata } from "../coding-engine/engine-usage.js";
import type { ModelRegistry } from "../routing/model-registry.js";
import { selectModel, type ModelGatewayLookup } from "../routing/model-router.js";
import { deriveHealthOnFailure, deriveHealthOnSuccess, type CooldownPolicyConfig } from "../routing/provider-health-policy.js";
import type { ProviderHealthRepository } from "../persistence/repositories/provider-health-repository.js";
import { classifyOrchestratorFailure } from "../orchestrator/failure-classifier.js";
import { ModelGatewayResolutionError } from "../application/errors.js";
import { redactSecrets } from "../security/redact.js";
import type { AnalysisFailureCategory } from "./backlog-types.js";

export interface AnalyzerAttempt {
  modelId: string | null;
  providerId: string | null;
  outcome: "succeeded" | "failed";
  /** Redacted, bounded, non-secret. Only for a failed attempt. */
  reason?: string;
}

export type AnalyzerOutcome =
  | {
      ok: true;
      /** The engine's final natural-language text — untrusted until schema-validated by the caller. */
      rawOutput: string;
      selection: ModelSelection | null;
      engineKey: string;
      cost: CostMetadata | null;
      attempts: AnalyzerAttempt[];
    }
  | {
      ok: false;
      category: AnalysisFailureCategory;
      reason: string;
      selection: ModelSelection | null;
      engineKey: string | null;
      attempts: AnalyzerAttempt[];
      /** Usage the engine emitted in the failed model attempt(s) — real and billed, so kept (labelled partial). `null` = none was captured. */
      cost?: CostMetadata | null;
      /**
       * From the EXISTING failure taxonomy (orchestrator/failure-classifier.ts) — never a second one:
       * true only for an infrastructure failure the platform already treats as retryable (timeout,
       * provider quota/rate limit, 5xx, …) or for "every model is cooling down". Malformed output,
       * auth failures, permanent-configuration errors, unknown errors and cancellation are never retryable.
       */
      retryable: boolean;
      /** A provider- or cooldown-suggested wait, when there is one. */
      retryAfterMs: number | null;
    };

export interface BacklogAnalyzerOptions {
  timeoutMs: number;
  cooldown: CooldownPolicyConfig;
  /** How many DISTINCT models one analysis may try. Fallback happens only on an infrastructure-classified failure and only to a genuinely different model. */
  maxModelAttempts?: number;
  /** Environment used only to redact secret-valued variables from any failure text (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

const MAX_REASON_CHARS = 500;

/**
 * Runs one backlog-analysis prompt through the EXISTING coding-engine boundary — the same
 * `CodingEngineRegistry`, `ModelRegistry` + `selectModel` routing, provider-health cooldown, timeout
 * and cancellation machinery task execution uses — without adding an agent role, a provider, or a
 * second way to call a model. Provider-agnostic by construction: nothing here names a vendor; the
 * model comes from the registry, the engine from `Project.codingEngine`.
 *
 * What this class does NOT do: parse the output, decide any status, or write any row. It returns raw
 * text plus the platform's own routing/health facts; BacklogService validates and decides.
 *
 * Safety: the engine is pointed at an EMPTY throwaway directory (never a repository or a task
 * workspace), and the prompt is self-contained and tells the model not to act. So even an agent
 * engine with tools enabled has nothing to read or damage; the directory is always removed.
 */
export class BacklogAnalyzer {
  private readonly maxModelAttempts: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly engines: CodingEngineRegistry,
    private readonly modelRegistry: ModelRegistry | null,
    private readonly providerHealth: ProviderHealthRepository | null,
    private readonly options: BacklogAnalyzerOptions,
    /** Model Gateway — see Orchestrator's own `modelGateway` doc comment; `null` preserves exact prior (env-registry-only) behavior. */
    private readonly modelGateway: ModelGatewayLookup | null = null,
  ) {
    this.maxModelAttempts = options.maxModelAttempts ?? 2;
    this.env = options.env ?? process.env;
  }

  async run(project: Project, prompt: string, signal: AbortSignal): Promise<AnalyzerOutcome> {
    const attempts: AnalyzerAttempt[] = [];

    let engine: CodingEngine;
    try {
      engine = this.engines.resolve(project.codingEngine);
    } catch (err) {
      const reason = err instanceof UnknownCodingEngineError ? err.message : "The project's coding engine could not be resolved.";
      return { ok: false, category: "engine_error", reason: this.clean(reason), selection: null, engineKey: null, attempts, retryable: false, retryAfterMs: null };
    }

    const scratch = await mkdtemp(join(tmpdir(), "codeforge-analysis-"));
    try {
      const triedModelIds: string[] = [];
      let lastSelection: ModelSelection | null = null;
      let lastClassification: ReturnType<typeof classifyOrchestratorFailure> | null = null;
      let lastCategory: AnalysisFailureCategory = "engine_error";
      // GAP-034: usage emitted by model attempts that FAILED (timeout, kill, …) is real — carried into whatever outcome ends the run.
      let failedUsage: CostMetadata | null = null;

      for (let attempt = 1; attempt <= this.maxModelAttempts; attempt++) {
        if (signal.aborted) return { ok: false, category: "cancelled", reason: "The analysis was cancelled.", selection: lastSelection, engineKey: engine.key, attempts, retryable: false, retryAfterMs: null };

        const now = new Date().toISOString();
        // Model Gateway — see Orchestrator.runAgent's own identical wiring/doc comment. Unlike
        // Orchestrator (which lets a thrown ModelGatewayResolutionError propagate through its own
        // existing error->TASK_FAILED path), `run()`'s established contract is to NEVER throw —
        // every failure, including this one, becomes an honest `AnalyzerOutcome`, never silently
        // falling back to a different model.
        let gatewayResult: ReturnType<ModelGatewayLookup["resolveModelSelection"]> | null = null;
        if (this.modelGateway) {
          try {
            gatewayResult = this.modelGateway.resolveModelSelection(project.ownerId, engine.key, "backlog_analysis", triedModelIds.length, now, this.modelRegistry);
          } catch (err) {
            if (!(err instanceof ModelGatewayResolutionError)) throw err;
            return { ok: false, category: "engine_error", reason: this.clean(err.message), selection: lastSelection, engineKey: engine.key, attempts, retryable: false, retryAfterMs: null };
          }
        }
        const hasCandidates = this.modelGateway ? gatewayResult!.hadCandidates : this.modelRegistry ? this.modelRegistry.listEnabledForEngine(engine.key).length > 0 : false;
        const selection =
          gatewayResult?.selection ??
          (!this.modelGateway && this.modelRegistry && this.providerHealth
            ? selectModel(this.modelRegistry, this.providerHealth, { operation: "backlog_analysis", engineKey: engine.key, fallbackIndex: triedModelIds.length, now })
            : null);
        const credentialEnv = gatewayResult?.credentialEnv ?? null;

        // A retry within this attempt is only worthwhile against a genuinely different model. Checked BEFORE
        // the "everything is cooling down" case: when the model that just failed is the only one there is,
        // it is now cooling down because of THAT failure — reporting "no model available" would replace the
        // real cause with a derived one. Fall out of the loop and report the failure that actually happened.
        if (attempt > 1 && (selection === null || triedModelIds.includes(selection.modelId))) break;

        if (hasCandidates && selection === null) {
          // Real candidates are configured but every one is cooling down / unavailable — fail fast and
          // truthfully, rather than hammering a provider the platform already knows is struggling.
          return {
            ok: false,
            category: "no_model_available",
            reason: "Every configured model for this project's coding engine is currently unavailable (cooling down after recent failures). Try again shortly.",
            selection: lastSelection,
            engineKey: engine.key,
            attempts,
            retryable: true,
            retryAfterMs: this.untilFirstProviderRecovers(engine.key, now),
          };
        }
        if (selection) triedModelIds.push(selection.modelId);
        lastSelection = selection;

        try {
          const invocation = await engine.run({
            role: "reviewer", // the read-only role; no AgentRun is created, and the prompt is overridden below
            context: emptyContext(scratch),
            workspacePath: scratch,
            timeoutMs: this.options.timeoutMs,
            signal,
            modelSelection: selection,
            credentialEnv,
            promptOverride: prompt,
          });
          if (invocation.result.status === "blocked") {
            throw new Error(`the engine reported it was blocked: ${invocation.result.summary.slice(0, 300)}`);
          }
          if (selection) this.recordSuccess(selection.providerId, new Date().toISOString());
          attempts.push({ modelId: selection?.modelId ?? null, providerId: selection?.providerId ?? null, outcome: "succeeded" });
          return { ok: true, rawOutput: invocation.result.summary, selection, engineKey: engine.key, cost: mergeCostMetadata(failedUsage, invocation.cost), attempts };
        } catch (err) {
          failedUsage = mergeCostMetadata(failedUsage, usageFromError(err));
          if (err instanceof CancellationError || signal.aborted) {
            return { ok: false, category: "cancelled", reason: "The analysis was cancelled.", selection, engineKey: engine.key, attempts, cost: failedUsage, retryable: false, retryAfterMs: null };
          }
          const classification = classifyOrchestratorFailure(err);
          lastClassification = classification;
          if (selection) this.recordFailure(selection.providerId, err, new Date().toISOString());
          const reason = this.clean(classification.reason);
          attempts.push({ modelId: selection?.modelId ?? null, providerId: selection?.providerId ?? null, outcome: "failed", reason });

          const category: AnalysisFailureCategory = err instanceof EngineTimeoutError ? "timeout" : "engine_error";
          lastCategory = category;
          const canFallBack = classification.retryable && attempt < this.maxModelAttempts;
          if (!canFallBack) return { ok: false, category, reason, selection, engineKey: engine.key, attempts, cost: failedUsage, retryable: classification.retryable, retryAfterMs: classification.retryAfterMs };
          // else: loop — the next iteration only proceeds if routing offers a different model.
        }
      }

      // Exited the loop after a retryable failure with no different model left to try.
      const last = attempts[attempts.length - 1];
      return {
        ok: false,
        category: lastCategory,
        reason: last?.reason ?? "The analysis could not be completed.",
        selection: lastSelection,
        engineKey: engine.key,
        attempts,
        cost: failedUsage,
        retryable: lastClassification?.retryable ?? false,
        retryAfterMs: lastClassification?.retryAfterMs ?? null,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Milliseconds until the earliest cooling-down provider of `engineKey`'s candidates is available again (null when that can't be determined). */
  private untilFirstProviderRecovers(engineKey: string, now: string): number | null {
    if (!this.modelRegistry || !this.providerHealth) return null;
    let earliest: number | null = null;
    for (const profile of this.modelRegistry.listEnabledForEngine(engineKey)) {
      const until = this.providerHealth.get(profile.providerId)?.cooldownUntil;
      if (!until) continue;
      const ms = new Date(until).getTime() - new Date(now).getTime();
      if (ms > 0 && (earliest === null || ms < earliest)) earliest = ms;
    }
    return earliest;
  }

  private clean(text: string): string {
    return redactSecrets(text, this.env).slice(0, MAX_REASON_CHARS);
  }

  private recordSuccess(providerId: string, now: string): void {
    if (!this.providerHealth) return;
    this.providerHealth.upsert(deriveHealthOnSuccess(providerId, this.providerHealth.get(providerId), now));
  }

  private recordFailure(providerId: string, err: unknown, now: string): void {
    if (!this.providerHealth) return;
    const c = classifyOrchestratorFailure(err);
    this.providerHealth.upsert(deriveHealthOnFailure(providerId, this.providerHealth.get(providerId), c.category, c.retryAfterMs, now, this.options.cooldown));
  }
}

/** The engine contract requires a ContextBundle; an analysis has no task, so every task-shaped field is empty. The real input is `promptOverride`. */
function emptyContext(repoPath: string): ContextBundle {
  return {
    taskGoal: "(backlog analysis)",
    taskPlan: null,
    priorDecisions: [],
    repoPath,
    projectConventionPointer: "",
    lastFailure: null,
    reviewEvidence: null,
    reviewerFeedback: null,
    humanReviewFeedback: null,
    projectContext: null,
    approvedVerificationChecks: [],
    verificationEvidence: null,
    bugFixEvidence: null,
  };
}
