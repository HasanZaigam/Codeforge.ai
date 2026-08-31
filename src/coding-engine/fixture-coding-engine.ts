import type { CodingEngine, EngineInvocationRequest, EngineInvocationResult } from "./coding-engine.js";
import type { AgentRole } from "../domain/types.js";

export type FixtureHandler = (request: EngineInvocationRequest) => Promise<EngineInvocationResult> | EngineInvocationResult;

/**
 * Deterministic, scripted CodingEngine implementation used by the automated
 * test suite and the bundled demo harness. It satisfies the exact same
 * `CodingEngine` interface as ClaudeCodeAdapter, so the Orchestrator, self-fix
 * loop, and state machine are exercised end-to-end without requiring a real
 * Claude Code CLI installation or API credentials in this environment — see
 * the security-boundary note in claude-code-adapter.ts and /docs/MVP_SCOPE.md.
 */
export class FixtureCodingEngine implements CodingEngine {
  constructor(
    private readonly handlers: Partial<Record<AgentRole, FixtureHandler>>,
    readonly key: string = "fixture",
  ) {}

  async run(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
    const handler = this.handlers[request.role];
    if (!handler) {
      throw new Error(`FixtureCodingEngine has no handler registered for role "${request.role}"`);
    }
    return handler(request);
  }
}
