import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * A mutation Chat has proposed but not yet executed — see migration 024's own doc comment. Never
 * executed on the message that creates it; only an explicit, later confirming reply executes it (see
 * ChatService.sendMessage's pending-action handling). A discriminated union because a bulk proposal and
 * a single-task human-completion proposal need different fields to safely re-verify at confirm time.
 */
export type ChatPendingAction =
  /** The exact `taskIds`/`titles` snapshot shown to the user at proposal time is what a confirmation executes against; re-resolving the set at confirm time could silently act on a different set than what was shown. */
  | { kind: "BULK_CANCEL" | "BULK_START"; status: string; taskIds: string[]; titles: string[]; createdAt: string }
  /**
   * Phase 4D.4 — a single task's human-confirmed REVIEW -> DONE completion. `taskId` (never the title)
   * is what confirmation executes against — the task is re-read FRESH at confirm time, never trusted
   * from `observedStatus`, which exists purely for display/explanation if the user asks what changed.
   */
  | { kind: "HUMAN_MARK_DONE"; taskId: string; taskTitle: string; observedStatus: string; createdAt: string }
  /** Phase 4D.6 — Task creation from uploaded/imported backlog items, filtered by dev-status / query. Requires explicit confirmation before creating Tasks. */
  | { kind: "UPLOAD_TASK_CREATION"; importId: string; itemIds: string[]; filterDescription: string; titles: string[]; createdAt: string };

export interface ChatConversationRecord {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The task a pronoun follow-up ("what happened on it?") should resolve to — see migration 023's own doc comment. */
  lastTaskId: string | null;
  /** A bulk action awaiting an explicit yes/no reply — see migration 024's own doc comment. Null when nothing is pending. */
  pendingAction: ChatPendingAction | null;
  /** The ordered list of task ids the conversation most recently displayed ("Show me Review tasks." -> 3 results) — see migration 025's own doc comment. Null/empty when nothing has been displayed yet. */
  lastTaskIds: string[] | null;
  /** Phase 4D.6 — active uploaded bug sheet / import ID associated with this conversation. */
  activeImportId: string | null;
}

export type ChatMessageRole = "user" | "assistant";

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  content: string;
  attachment: { filename: string; mimeType: string; byteSize: number } | null;
  bulkJobId: string | null;
  createdAt: string;
  /**
   * Assistant replies only (TD-63): tokens this reply used — 0 when answered from CodeForge's own data
   * with no model call; null when a model was called but nothing was reported or estimable. Optional on
   * input so older call sites keep working (stored as null).
   */
  tokens?: number | null;
  tokensEstimated?: boolean;
}

type Row = Record<string, unknown>;

const toConversation = (r: Row): ChatConversationRecord => ({
  id: r.id as string,
  projectId: r.project_id as string,
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  lastTaskId: (r.last_task_id as string | null) ?? null,
  pendingAction: r.pending_action_json ? (JSON.parse(r.pending_action_json as string) as ChatPendingAction) : null,
  lastTaskIds: r.last_task_ids_json ? (JSON.parse(r.last_task_ids_json as string) as string[]) : null,
  activeImportId: (r.active_import_id as string | null) ?? null,
});

const toMessage = (r: Row): ChatMessageRecord => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  role: r.role as ChatMessageRole,
  content: r.content as string,
  attachment:
    r.attachment_filename != null
      ? { filename: r.attachment_filename as string, mimeType: r.attachment_mime_type as string, byteSize: r.attachment_byte_size as number }
      : null,
  bulkJobId: (r.bulk_job_id as string | null) ?? null,
  createdAt: r.created_at as string,
  tokens: (r.tokens as number | null) ?? null,
  tokensEstimated: r.tokens_estimated === 1,
});

/**
 * Project-aware Chat (Phase 4C) — a minimal durable conversation/message store, one conversation per
 * (project, user). Never stores an attachment's raw bytes (see migration 022's own doc comment) — only
 * bounded metadata about it; the real durable result of a file attachment is the ordinary backlog
 * import/analysis rows it produces (see ChatService).
 */
export class ChatRepository {
  constructor(private readonly db: DatabaseSync) {}

  getOrCreateConversation(projectId: string, userId: string, now: string): ChatConversationRecord {
    const existing = this.db
      .prepare("SELECT * FROM chat_conversations WHERE project_id = ? AND created_by = ?")
      .get(projectId, userId) as Row | undefined;
    if (existing) return toConversation(existing);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO chat_conversations (id, project_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, userId, now, now);
    return { id, projectId, createdBy: userId, createdAt: now, updatedAt: now, lastTaskId: null, pendingAction: null, lastTaskIds: null, activeImportId: null };
  }

  findConversationById(id: string): ChatConversationRecord | null {
    const r = this.db.prepare("SELECT * FROM chat_conversations WHERE id = ?").get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  touchConversation(id: string, now: string): void {
    this.db.prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ?").run(now, id);
  }

  /** `taskId: null` explicitly clears it (e.g. once a referenced task no longer resolves). */
  setLastTaskId(id: string, taskId: string | null, now: string): void {
    this.db.prepare("UPDATE chat_conversations SET last_task_id = ?, updated_at = ? WHERE id = ?").run(taskId, now, id);
  }

  /** `pending: null` explicitly clears it (after a confirm/decline reply, or because the conversation moved on to something else). */
  setPendingAction(id: string, pending: ChatPendingAction | null, now: string): void {
    this.db.prepare("UPDATE chat_conversations SET pending_action_json = ?, updated_at = ? WHERE id = ?").run(pending ? JSON.stringify(pending) : null, now, id);
  }

  /** Always overwrites wholesale (never appends) — the NEXT list-producing read replaces whatever was displayed before, so a stale earlier list can never linger past a fresh one. `ids: null` explicitly clears it. */
  setLastTaskIds(id: string, ids: string[] | null, now: string): void {
    this.db.prepare("UPDATE chat_conversations SET last_task_ids_json = ?, updated_at = ? WHERE id = ?").run(ids && ids.length > 0 ? JSON.stringify(ids) : null, now, id);
  }

  /** Phase 4D.6 — `importId: null` explicitly clears the active upload context. */
  setActiveImportId(id: string, importId: string | null, now: string): void {
    this.db.prepare("UPDATE chat_conversations SET active_import_id = ?, updated_at = ? WHERE id = ?").run(importId, now, id);
  }

  appendMessage(input: Omit<ChatMessageRecord, "id">): ChatMessageRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, content, attachment_filename, attachment_mime_type, attachment_byte_size, bulk_job_id, created_at, tokens, tokens_estimated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.content,
        input.attachment?.filename ?? null,
        input.attachment?.mimeType ?? null,
        input.attachment?.byteSize ?? null,
        input.bulkJobId,
        input.createdAt,
        input.tokens ?? null,
        input.tokensEstimated ? 1 : 0,
      );
    return { id, ...input, tokens: input.tokens ?? null, tokensEstimated: input.tokensEstimated ?? false };
  }

  listMessages(conversationId: string): ChatMessageRecord[] {
    return (this.db.prepare("SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC").all(conversationId) as Row[]).map(
      toMessage,
    );
  }
}
