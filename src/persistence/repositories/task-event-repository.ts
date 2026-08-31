import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TaskEvent, TaskEventType } from "../../domain/types.js";

interface TaskEventRow {
  id: string;
  task_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

function rowToEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type as TaskEventType,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/**
 * Append-only. This is the audit trail (§14 of the platform spec) and the
 * data source for the future dashboard activity view — never mutated or
 * deleted, and never given secret values in its payload.
 */
export class TaskEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(taskId: string, type: TaskEventType, payload: Record<string, unknown>, now: string): TaskEvent {
    const event: TaskEvent = { id: randomUUID(), taskId, type, payload, createdAt: now };
    this.db
      .prepare(
        "INSERT INTO task_events (id, task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(event.id, event.taskId, event.type, JSON.stringify(payload), now);
    return event;
  }

  listForTask(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as unknown as TaskEventRow[];
    return rows.map(rowToEvent);
  }
}
