import type { DatabaseSync } from "node:sqlite";
import type { CostMetadata } from "../../domain/types.js";

/** Raw usage rows for one project since a point in time — the service turns them into token counts (TD-63). */
export interface ProjectUsageRows {
  agentRuns: Array<{ cost: CostMetadata | null }>;
  analyses: Array<{ cost: CostMetadata | null; promptChars: number | null; outputChars: number | null }>;
  chatReplies: Array<{ tokens: number; estimated: boolean }>;
}

function parseCost(json: unknown): CostMetadata | null {
  return typeof json === "string" && json ? (JSON.parse(json) as CostMetadata) : null;
}

function promptCharsOf(json: unknown): number | null {
  if (typeof json !== "string" || !json) return null;
  const chars = (JSON.parse(json) as { context?: { promptChars?: unknown } }).context?.promptChars;
  return typeof chars === "number" ? chars : null;
}

/** Read-only usage queries plus the two budget columns (projects / users.monthly_token_budget). */
export class TokenUsageRepository {
  constructor(private readonly db: DatabaseSync) {}

  projectUsageSince(projectId: string, since: string): ProjectUsageRows {
    const agentRuns = (
      this.db
        .prepare(
          `SELECT ar.cost_json FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id
           WHERE t.project_id = ? AND ar.started_at >= ?`,
        )
        .all(projectId, since) as Array<{ cost_json: string | null }>
    ).map((r) => ({ cost: parseCost(r.cost_json) }));

    const analyses = (
      this.db
        .prepare(
          `SELECT cost_json, platform_checks_json, diagnostics_json, result_json FROM backlog_analyses
           WHERE project_id = ? AND completed_at >= ?`,
        )
        .all(projectId, since) as Array<{ cost_json: string | null; platform_checks_json: string | null; diagnostics_json: string | null; result_json: string | null }>
    ).map((r) => ({
      cost: parseCost(r.cost_json),
      promptChars: promptCharsOf(r.platform_checks_json) ?? promptCharsOf(r.diagnostics_json),
      outputChars: r.result_json ? r.result_json.length : null,
    }));

    const chatReplies = (
      this.db
        .prepare(
          `SELECT m.tokens, m.tokens_estimated FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
           WHERE c.project_id = ? AND m.role = 'assistant' AND m.tokens IS NOT NULL AND m.created_at >= ?`,
        )
        .all(projectId, since) as Array<{ tokens: number; tokens_estimated: number }>
    ).map((r) => ({ tokens: r.tokens, estimated: r.tokens_estimated === 1 }));

    return { agentRuns, analyses, chatReplies };
  }

  getProjectBudget(projectId: string): number | null {
    const row = this.db.prepare("SELECT monthly_token_budget FROM projects WHERE id = ?").get(projectId) as { monthly_token_budget: number | null } | undefined;
    return row?.monthly_token_budget ?? null;
  }

  setProjectBudget(projectId: string, budget: number | null): void {
    this.db.prepare("UPDATE projects SET monthly_token_budget = ? WHERE id = ?").run(budget, projectId);
  }

  getAccountBudget(userId: string): number | null {
    const row = this.db.prepare("SELECT monthly_token_budget FROM users WHERE id = ?").get(userId) as { monthly_token_budget: number | null } | undefined;
    return row?.monthly_token_budget ?? null;
  }

  setAccountBudget(userId: string, budget: number | null): void {
    this.db.prepare("UPDATE users SET monthly_token_budget = ? WHERE id = ?").run(budget, userId);
  }
}
