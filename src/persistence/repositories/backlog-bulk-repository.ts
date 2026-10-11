import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BacklogImportRecord {
  id: string;
  projectId: string;
  sourceName: string;
  sourceType: "csv";
  createdBy: string;
  status: "COMPLETED";
  contentHash: string;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  alreadyImportedRows: number;
  mapping: unknown;
  warnings: string[];
  createdAt: string;
  completedAt: string;
}

export interface BacklogImportRowRecord {
  importId: string;
  rowNumber: number;
  sourceKey: string | null;
  status: "ACCEPTED" | "REJECTED" | "ALREADY_IMPORTED";
  reason: string | null;
  detail: string | null;
  backlogItemId: string | null;
  warnings: string[];
}

export interface BulkJobRecord {
  id: string;
  projectId: string;
  requestedBy: string;
  importId: string | null;
  totalItems: number;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BulkMemberRecord {
  bulkJobId: string;
  backlogItemId: string;
  analysisJobId: string | null;
  disposition: "QUEUED" | "REUSED" | "SKIPPED";
  reason: string | null;
}

export interface OperationEvent {
  id: string;
  projectId: string;
  operationKind: "import" | "bulk_analysis" | "bulk_action";
  operationId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

type Row = Record<string, unknown>;

/** Persistence for imports, bulk-analysis groupings and operation-level audit events (migration 018). Dumb about authorization — BacklogBulkService owns that. */
export class BacklogBulkRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertImport(i: BacklogImportRecord): void {
    this.db
      .prepare(
        `INSERT INTO backlog_imports (id, project_id, source_name, source_type, created_by, status, content_hash, total_rows, accepted_rows, rejected_rows, already_imported_rows, mapping_json, warnings_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.id, i.projectId, i.sourceName, i.sourceType, i.createdBy, i.status, i.contentHash, i.totalRows, i.acceptedRows, i.rejectedRows, i.alreadyImportedRows, JSON.stringify(i.mapping), JSON.stringify(i.warnings), i.createdAt, i.completedAt);
  }

  insertImportRow(r: BacklogImportRowRecord): void {
    this.db
      .prepare(`INSERT INTO backlog_import_rows (import_id, row_number, source_key, status, reason, detail, backlog_item_id, warnings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.importId, r.rowNumber, r.sourceKey, r.status, r.reason, r.detail, r.backlogItemId, JSON.stringify(r.warnings));
  }

  private toImport(r: Row): BacklogImportRecord {
    return {
      id: r.id as string, projectId: r.project_id as string, sourceName: r.source_name as string, sourceType: "csv", createdBy: r.created_by as string, status: "COMPLETED",
      contentHash: r.content_hash as string, totalRows: r.total_rows as number, acceptedRows: r.accepted_rows as number, rejectedRows: r.rejected_rows as number,
      alreadyImportedRows: r.already_imported_rows as number, mapping: JSON.parse(r.mapping_json as string), warnings: JSON.parse(r.warnings_json as string),
      createdAt: r.created_at as string, completedAt: r.completed_at as string,
    };
  }

  findImport(id: string): BacklogImportRecord | null {
    const r = this.db.prepare("SELECT * FROM backlog_imports WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toImport(r) : null;
  }

  listImports(projectId: string): BacklogImportRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_imports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(projectId) as Row[]).map((r) => this.toImport(r));
  }

  listImportRows(importId: string): BacklogImportRowRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_import_rows WHERE import_id = ? ORDER BY row_number ASC").all(importId) as Row[]).map((r) => ({
      importId, rowNumber: r.row_number as number, sourceKey: r.source_key as string | null, status: r.status as BacklogImportRowRecord["status"], reason: r.reason as string | null,
      detail: r.detail as string | null, backlogItemId: r.backlog_item_id as string | null, warnings: JSON.parse(r.warnings_json as string),
    }));
  }

  itemIdsForImport(importId: string): string[] {
    return (this.db.prepare("SELECT id FROM backlog_items WHERE import_id = ? ORDER BY source_row ASC, rowid ASC").all(importId) as Array<{ id: string }>).map((r) => r.id);
  }

  // ---- bulk analysis ----------------------------------------------------------------------------------------------------------------

  insertBulkJob(j: BulkJobRecord): void {
    this.db
      .prepare("INSERT INTO backlog_bulk_jobs (id, project_id, requested_by, import_id, total_items, cancel_requested_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(j.id, j.projectId, j.requestedBy, j.importId, j.totalItems, j.cancelRequestedAt, j.createdAt, j.updatedAt);
  }

  insertMember(m: BulkMemberRecord): void {
    this.db
      .prepare("INSERT INTO backlog_bulk_job_items (bulk_job_id, backlog_item_id, analysis_job_id, disposition, reason) VALUES (?, ?, ?, ?, ?)")
      .run(m.bulkJobId, m.backlogItemId, m.analysisJobId, m.disposition, m.reason);
  }

  private toBulk(r: Row): BulkJobRecord {
    return { id: r.id as string, projectId: r.project_id as string, requestedBy: r.requested_by as string, importId: r.import_id as string | null, totalItems: r.total_items as number, cancelRequestedAt: r.cancel_requested_at as string | null, createdAt: r.created_at as string, updatedAt: r.updated_at as string };
  }

  findBulk(id: string): BulkJobRecord | null {
    const r = this.db.prepare("SELECT * FROM backlog_bulk_jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toBulk(r) : null;
  }

  listBulk(projectId: string): BulkJobRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_bulk_jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(projectId) as Row[]).map((r) => this.toBulk(r));
  }

  members(bulkId: string): BulkMemberRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_bulk_job_items WHERE bulk_job_id = ? ORDER BY rowid ASC").all(bulkId) as Row[]).map((r) => ({
      bulkJobId: bulkId, backlogItemId: r.backlog_item_id as string, analysisJobId: r.analysis_job_id as string | null, disposition: r.disposition as BulkMemberRecord["disposition"], reason: r.reason as string | null,
    }));
  }

  requestCancel(bulkId: string, now: string): boolean {
    return this.db.prepare("UPDATE backlog_bulk_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ?").run(now, now, bulkId).changes > 0;
  }

  // ---- operation audit --------------------------------------------------------------------------------------------------------------

  appendOp(projectId: string, kind: OperationEvent["operationKind"], operationId: string, type: string, payload: Record<string, unknown>, now: string): void {
    this.db
      .prepare("INSERT INTO backlog_operation_events (id, project_id, operation_kind, operation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), projectId, kind, operationId, type, JSON.stringify(payload), now);
  }

  listOps(kind: OperationEvent["operationKind"], operationId: string): OperationEvent[] {
    return (this.db.prepare("SELECT * FROM backlog_operation_events WHERE operation_kind = ? AND operation_id = ? ORDER BY created_at ASC, rowid ASC").all(kind, operationId) as Row[]).map((r) => ({
      id: r.id as string, projectId: r.project_id as string, operationKind: kind, operationId, type: r.type as string, payload: JSON.parse(r.payload_json as string), createdAt: r.created_at as string,
    }));
  }
}
