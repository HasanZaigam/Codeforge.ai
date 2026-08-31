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
           result_json, error, cost_json, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  complete(id: string, status: AgentRunStatus, result: StepResult | null, error: string | null, cost: CostMetadata | null, now: string): void {
    this.db
      .prepare(
        `UPDATE agent_runs SET status = ?, result_json = ?, error = ?, cost_json = ?, completed_at = ? WHERE id = ?`,
      )
      .run(status, result ? JSON.stringify(result) : null, error, cost ? JSON.stringify(cost) : null, now, id);
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
}
