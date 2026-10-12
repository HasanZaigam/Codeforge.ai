import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { TokenUsageRepository } from "../persistence/repositories/token-usage-repository.js";
import { assertProjectAccess } from "./authorization.js";
import { monthStartUtc, tokenCountFor } from "../usage/token-usage.js";

/** Tokens for one kind of operation: the total, and how much of it is estimated rather than reported. */
export interface UsageBucket {
  tokens: number;
  estimatedTokens: number;
  /** Operations that used a model but reported nothing CodeForge could count or estimate. */
  unreported: number;
  operations: number;
}

export interface TokenMeter {
  periodStart: string;
  used: number;
  /** The part of `used` that is a ~4-chars-per-token estimate. */
  estimatedTokens: number;
  /** Model operations that reported no usage and couldn't be estimated — `used` is a lower bound when > 0. */
  unreportedOperations: number;
  budget: number | null;
  /** budget − used, floored at 0; null without a budget. */
  remaining: number | null;
  /** used / budget as a 0–100+ percentage; null without a budget. */
  percentUsed: number | null;
}

export interface ProjectTokenUsage extends TokenMeter {
  projectId: string;
  breakdown: { tasks: UsageBucket; analyses: UsageBucket; chat: UsageBucket };
}

export interface AccountTokenUsage extends TokenMeter {
  projects: Array<{ projectId: string; name: string; used: number; estimatedTokens: number; budget: number | null }>;
}

function emptyBucket(): UsageBucket {
  return { tokens: 0, estimatedTokens: 0, unreported: 0, operations: 0 };
}

function meter(periodStart: string, used: number, estimatedTokens: number, unreportedOperations: number, budget: number | null): TokenMeter {
  return {
    periodStart,
    used,
    estimatedTokens,
    unreportedOperations,
    budget,
    remaining: budget === null ? null : Math.max(0, budget - used),
    percentUsed: budget === null || budget === 0 ? null : Math.round((used / budget) * 1000) / 10,
  };
}

/**
 * Monthly (calendar month, UTC) token usage per project and per account, against optional budgets
 * (TD-63). Counts every model-using operation CodeForge persists: task agent runs, backlog analyses and
 * Chat replies. Budgets only inform — reaching one never blocks work.
 */
export class TokenUsageService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly usage: TokenUsageRepository,
  ) {}

  projectUsage(projectId: string, actorId: string, now = new Date()): ProjectTokenUsage {
    assertProjectAccess(this.projects, projectId, actorId);
    return this.computeProject(projectId, now);
  }

  accountUsage(actorId: string, now = new Date()): AccountTokenUsage {
    const projects = this.projects.listByOwner(actorId).map((p) => ({ project: p, usage: this.computeProject(p.id, now) }));
    const used = projects.reduce((n, p) => n + p.usage.used, 0);
    const estimated = projects.reduce((n, p) => n + p.usage.estimatedTokens, 0);
    const unreported = projects.reduce((n, p) => n + p.usage.unreportedOperations, 0);
    return {
      ...meter(monthStartUtc(now), used, estimated, unreported, this.usage.getAccountBudget(actorId)),
      projects: projects
        .map(({ project, usage }) => ({ projectId: project.id, name: project.name, used: usage.used, estimatedTokens: usage.estimatedTokens, budget: usage.budget }))
        .sort((a, b) => b.used - a.used),
    };
  }

  setProjectBudget(projectId: string, actorId: string, monthlyTokens: number | null): ProjectTokenUsage {
    assertProjectAccess(this.projects, projectId, actorId);
    this.usage.setProjectBudget(projectId, monthlyTokens);
    return this.computeProject(projectId, new Date());
  }

  setAccountBudget(actorId: string, monthlyTokens: number | null): AccountTokenUsage {
    this.usage.setAccountBudget(actorId, monthlyTokens);
    return this.accountUsage(actorId);
  }

  private computeProject(projectId: string, now: Date): ProjectTokenUsage {
    const periodStart = monthStartUtc(now);
    const rows = this.usage.projectUsageSince(projectId, periodStart);
    const tasks = emptyBucket();
    const analyses = emptyBucket();
    const chat = emptyBucket();

    for (const run of rows.agentRuns) {
      tasks.operations++;
      const count = tokenCountFor(run.cost); // agent-run prompts aren't stored: reported or nothing
      if (count) tasks.tokens += count.tokens;
      else tasks.unreported++;
    }
    for (const a of rows.analyses) {
      analyses.operations++;
      const count = tokenCountFor(a.cost, (a.promptChars ?? 0) + (a.outputChars ?? 0));
      if (!count) analyses.unreported++;
      else {
        analyses.tokens += count.tokens;
        if (count.estimated) analyses.estimatedTokens += count.tokens;
      }
    }
    for (const reply of rows.chatReplies) {
      if (reply.tokens === 0) continue; // answered from CodeForge data — no model operation
      chat.operations++;
      chat.tokens += reply.tokens;
      if (reply.estimated) chat.estimatedTokens += reply.tokens;
    }

    const used = tasks.tokens + analyses.tokens + chat.tokens;
    const estimated = tasks.estimatedTokens + analyses.estimatedTokens + chat.estimatedTokens;
    const unreported = tasks.unreported + analyses.unreported + chat.unreported;
    return {
      projectId,
      ...meter(periodStart, used, estimated, unreported, this.usage.getProjectBudget(projectId)),
      breakdown: { tasks, analyses, chat },
    };
  }
}
