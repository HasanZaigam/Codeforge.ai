import type { DatabaseSync } from "node:sqlite";
import type { CostMetadata } from "../../domain/types.js";
import type { AnalysisFailureCategory, AnalysisStatus, BacklogAnalysis, PlatformChecks } from "../../backlog/backlog-types.js";
import { AnalysisResultSchema } from "../../backlog/analysis-schema.js";

interface BacklogAnalysisRow {
  id: string;
  backlog_item_id: string;
  project_id: string;
  status: string;
  failure_category: string | null;
  failure_reason: string | null;
  result_json: string | null;
  platform_checks_json: string | null;
  diagnostics_json: string | null;
  model_id: string | null;
  provider_id: string | null;
  engine_key: string | null;
  fallback_index: number;
  routing_reason: string | null;
  cost_json: string | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function rowToAnalysis(row: BacklogAnalysisRow): BacklogAnalysis {
  const base = {
    id: row.id,
    backlogItemId: row.backlog_item_id,
    projectId: row.project_id,
    platformChecks: parseJson<PlatformChecks>(row.platform_checks_json),
    diagnostics: parseJson<Record<string, unknown>>(row.diagnostics_json),
    modelId: row.model_id,
    providerId: row.provider_id,
    engineKey: row.engine_key,
    fallbackIndex: row.fallback_index,
    routingReason: row.routing_reason,
    cost: parseJson<CostMetadata>(row.cost_json),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  };

  if (row.status === "succeeded") {
    // Re-validate on the way OUT too: a stored result that no longer satisfies the schema (a manual
    // edit, a future schema tightening) is reported as a failed analysis — never silently trusted.
    const parsed = AnalysisResultSchema.safeParse(parseJson<unknown>(row.result_json));
    if (parsed.success) {
      return { ...base, status: "succeeded", failureCategory: null, failureReason: null, result: parsed.data };
    }
    return {
      ...base,
      status: "failed",
      failureCategory: "malformed_output",
      failureReason: "The stored analysis no longer satisfies the analysis schema and was not trusted.",
      result: null,
    };
  }

  return {
    ...base,
    status: "failed",
    failureCategory: (row.failure_category as AnalysisFailureCategory | null) ?? "engine_error",
    failureReason: row.failure_reason,
    result: null,
  };
}

/** Append-only history of analysis attempts; the newest by `completed_at` is the item's current analysis. */
export class BacklogAnalysisRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(a: BacklogAnalysis): void {
    const status: AnalysisStatus = a.status;
    this.db
      .prepare(
        `INSERT INTO backlog_analyses
           (id, backlog_item_id, project_id, status, failure_category, failure_reason, result_json, platform_checks_json, diagnostics_json,
            model_id, provider_id, engine_key, fallback_index, routing_reason, cost_json, started_at, completed_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.backlogItemId,
        a.projectId,
        status,
        a.failureCategory,
        a.failureReason,
        a.result ? JSON.stringify(a.result) : null,
        a.platformChecks ? JSON.stringify(a.platformChecks) : null,
        a.diagnostics ? JSON.stringify(a.diagnostics) : null,
        a.modelId,
        a.providerId,
        a.engineKey,
        a.fallbackIndex,
        a.routingReason,
        a.cost ? JSON.stringify(a.cost) : null,
        a.startedAt,
        a.completedAt,
        a.durationMs,
      );
  }

  findById(id: string): BacklogAnalysis | null {
    const row = this.db.prepare("SELECT * FROM backlog_analyses WHERE id = ?").get(id) as BacklogAnalysisRow | undefined;
    return row ? rowToAnalysis(row) : null;
  }

  findLatestForItem(backlogItemId: string): BacklogAnalysis | null {
    const row = this.db
      .prepare("SELECT * FROM backlog_analyses WHERE backlog_item_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1")
      .get(backlogItemId) as BacklogAnalysisRow | undefined;
    return row ? rowToAnalysis(row) : null;
  }

  /** The most recent SUCCEEDED analysis — what a task proposal is built from, even if a later re-analysis failed. */
  findLatestSucceededForItem(backlogItemId: string): BacklogAnalysis | null {
    const row = this.db
      .prepare("SELECT * FROM backlog_analyses WHERE backlog_item_id = ? AND status = 'succeeded' ORDER BY completed_at DESC, rowid DESC LIMIT 1")
      .get(backlogItemId) as BacklogAnalysisRow | undefined;
    return row ? rowToAnalysis(row) : null;
  }

  countForItem(backlogItemId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM backlog_analyses WHERE backlog_item_id = ?").get(backlogItemId) as { n: number }).n;
  }
}
