import type { DatabaseSync } from "node:sqlite";
import type { HumanAnswer, HumanInputRequest, HumanInputRequestStatus, InputOption } from "../../domain/types.js";

interface HumanInputRow {
  id: string;
  task_id: string;
  status: string;
  discovered: string;
  attempted_json: string;
  blocker: string;
  question: string;
  options_json: string;
  answer_json: string | null;
  asked_at: string;
  answered_at: string | null;
  answered_by: string | null;
}

function rowToRequest(row: HumanInputRow): HumanInputRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status as HumanInputRequestStatus,
    discovered: row.discovered,
    attempted: JSON.parse(row.attempted_json) as string[],
    blocker: row.blocker,
    question: row.question,
    options: JSON.parse(row.options_json) as InputOption[],
    answer: row.answer_json ? (JSON.parse(row.answer_json) as HumanAnswer) : null,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
    answeredBy: row.answered_by,
  };
}

/**
 * One row per NEEDS_INPUT episode (a task may pause more than once over its
 * life). The open row for a task is what the resume flow reads and writes —
 * no chat history is replayed to answer it. See TASK_LIFECYCLE.md.
 */
export class HumanInputRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(request: HumanInputRequest): void {
    this.db
      .prepare(
        `INSERT INTO human_input_requests
          (id, task_id, status, discovered, attempted_json, blocker, question,
           options_json, answer_json, asked_at, answered_at, answered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.taskId,
        request.status,
        request.discovered,
        JSON.stringify(request.attempted),
        request.blocker,
        request.question,
        JSON.stringify(request.options),
        request.answer ? JSON.stringify(request.answer) : null,
        request.askedAt,
        request.answeredAt,
        request.answeredBy,
      );
  }

  findOpenForTask(taskId: string): HumanInputRequest | null {
    const row = this.db
      .prepare("SELECT * FROM human_input_requests WHERE task_id = ? AND status = 'open' ORDER BY asked_at DESC LIMIT 1")
      .get(taskId) as HumanInputRow | undefined;
    return row ? rowToRequest(row) : null;
  }

  answer(id: string, answer: HumanAnswer, answeredBy: string, now: string): void {
    this.db
      .prepare(
        `UPDATE human_input_requests
         SET status = 'answered', answer_json = ?, answered_at = ?, answered_by = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(JSON.stringify(answer), now, answeredBy, id);
  }

  listForTask(taskId: string): HumanInputRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM human_input_requests WHERE task_id = ? ORDER BY asked_at ASC")
      .all(taskId) as unknown as HumanInputRow[];
    return rows.map(rowToRequest);
  }
}
