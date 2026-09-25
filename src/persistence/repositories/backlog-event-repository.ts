import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { BacklogEvent, BacklogEventType } from "../../backlog/backlog-types.js";

interface BacklogEventRow {
  id: string;
  project_id: string;
  backlog_item_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

function rowToEvent(row: BacklogEventRow): BacklogEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    // A corrupt payload must not make the audit trail unreadable — surface an empty one.
  }
  return { id: row.id, projectId: row.project_id, backlogItemId: row.backlog_item_id, type: row.type as BacklogEventType, payload, createdAt: row.created_at };
}

/**
 * Append-only audit trail / observability for the backlog domain (the counterpart of
 * TaskEventRepository). Never mutated or deleted (except as part of deleting the whole project),
 * and never given secrets or raw model output in a payload.
 */
export class BacklogEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(projectId: string, backlogItemId: string, type: BacklogEventType, payload: Record<string, unknown>, now: string): BacklogEvent {
    const event: BacklogEvent = { id: randomUUID(), projectId, backlogItemId, type, payload, createdAt: now };
    this.db
      .prepare("INSERT INTO backlog_events (id, project_id, backlog_item_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, projectId, backlogItemId, type, JSON.stringify(payload), now);
    return event;
  }

  /**
   * Oldest first; `limit` keeps the newest N (so a long-lived item's detail response stays bounded).
   * Ties on `created_at` (several events in one millisecond — routine) break on `rowid`, i.e. true
   * insertion order; breaking on the random UUID would scramble the audit trail.
   */
  listForItem(backlogItemId: string, limit = 100): BacklogEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS seq FROM backlog_events WHERE backlog_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, seq ASC`,
      )
      .all(backlogItemId, limit) as unknown as BacklogEventRow[];
    return rows.map(rowToEvent);
  }
}
