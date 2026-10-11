import type { DatabaseSync } from "node:sqlite";
import type { AgentRun, AgentRunStatus, ContextBundle, CostMetadata, StepResult } from "../../domain/types.js";

interface AgentRunRow {
  id: string;
  task_id: string;
  role: string;
  engine: string;
  attempt_number: number;
  status: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  cost_json: string | null;
  started_at: string;
  completed_at: string | null;
  owner_generation: number;
  model_id: string | null;
  provider_id: string | null;
  fallback_index: number;
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role as AgentRun["role"],
    engine: row.engine,
    attemptNumber: row.attempt_number,
    status: row.status as AgentRunStatus,
    input: JSON.parse(row.input_json) as ContextBundle,
    result: row.result_json ? (JSON.parse(row.result_json) as StepResult) : null,
    error: row.error,
    cost: row.cost_json ? (JSON.parse(row.cost_json) as CostMetadata) : null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ownerGeneration: row.owner_generation,
    modelId: row.model_id,
    providerId: row.provider_id,
    fallbackIndex: row.fallback_index,
  };
}

/**
 * One row per CodingEngineAdapter invocation. This is what makes "did we
 * already run this step" answerable after a crash, and what the self-fix
 * loop's attempt counting is derived from independently of in-memory state.
 */
export class AgentRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(run: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs
          (id, task_id, role, engine, attempt_number, status, input_json,
           result_json, error, cost_json, started_at, completed_at, owner_generation,
           model_id, provider_id, fallback_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.role,
        run.engine,
        run.attemptNumber,
        run.status,
        JSON.stringify(run.input),
        run.result ? JSON.stringify(run.result) : null,
        run.error,
        run.cost ? JSON.stringify(run.cost) : null,
        run.startedAt,
        run.completedAt,
        run.ownerGeneration,
        run.modelId,
        run.providerId,
        run.fallbackIndex,
      );
  }

  /**
   * Fenced completion: only takes effect if the task this run belongs to is
   * STILL at the same lock_generation this run was created under (see
   * `owner_generation`, set at insert time from Orchestrator.runAgent's
   * captured execution generation). A stale execution — one that has lost
   * the task's lease to a newer owner since this run started — has its
   * completion silently rejected here rather than overwriting/clobbering an
   * AgentRun a newer generation may already be relying on. Returns true iff
   * this call actually completed the row; the caller (Orchestrator.runAgent)
   * treats false as a symptom of lease loss, which its own generation-fenced
   * task saves immediately afterward will independently detect and raise as
   * LeaseLostError.
   */
  complete(id: string, status: AgentRunStatus, result: StepResult | null, error: string | null, cost: CostMetadata | null, now: string): boolean {
    const outcome = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, result_json = ?, error = ?, cost_json = ?, completed_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM tasks t WHERE t.id = agent_runs.task_id AND t.lock_generation = agent_runs.owner_generation
           )`,
      )
      .run(status, result ? JSON.stringify(result) : null, error, cost ? JSON.stringify(cost) : null, now, id);
    return outcome.changes > 0;
  }

  listForTask(taskId: string): AgentRun[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as unknown as AgentRunRow[];
    return rows.map(rowToAgentRun);
  }

  /** Runs left "running" by a crashed worker — recovery marks these interrupted. */
  findRunning(): AgentRun[] {
    const rows = this.db.prepare("SELECT * FROM agent_runs WHERE status = 'running'").all() as unknown as AgentRunRow[];
    return rows.map(rowToAgentRun);
  }

  /**
   * Model Gateway — Settings "AI Usage" (see docs/MODEL_GATEWAY.md). Every AgentRun across every
   * project this user OWNS (`projects.owner_id`), with only the fields a per-provider usage rollup
   * needs. Scoped by owner, never by provider connection — a run's recorded `provider_id`/`model_id`
   * (migration 012) is the platform's own routing fact, independent of which connection is currently
   * configured.
   */
  listUsageForOwner(ownerId: string): Array<{ providerId: string | null; modelId: string | null; cost: CostMetadata | null }> {
    const rows = this.db
      .prepare(
        `SELECT ar.provider_id, ar.model_id, ar.cost_json
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         JOIN projects p ON p.id = t.project_id
         WHERE p.owner_id = ?`,
      )
      .all(ownerId) as unknown as Array<{ provider_id: string | null; model_id: string | null; cost_json: string | null }>;
    return rows.map((r) => ({ providerId: r.provider_id, modelId: r.model_id, cost: r.cost_json ? (JSON.parse(r.cost_json) as CostMetadata) : null }));
  }
}
