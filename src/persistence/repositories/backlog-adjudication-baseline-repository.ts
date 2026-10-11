import type { DatabaseSync } from "node:sqlite";

export interface BaselineRecord {
  id: string;
  projectId: string;
  version: number;
  seed: string;
  sourceName: string | null;
  repositoryRevisions: string[];
  models: string[];
  sample: unknown;
  metrics: unknown;
  established: boolean;
  createdBy: string;
  createdAt: string;
}

type Row = Record<string, unknown>;

const toBaseline = (r: Row): BaselineRecord => ({
  id: r.id as string, projectId: r.project_id as string, version: r.version as number, seed: r.seed as string, sourceName: r.source_name as string | null,
  repositoryRevisions: JSON.parse(r.repository_revisions_json as string), models: JSON.parse(r.models_json as string), sample: JSON.parse(r.sample_json as string),
  metrics: JSON.parse(r.metrics_json as string), established: r.established === 1, createdBy: r.created_by as string, createdAt: r.created_at as string,
});

/** Immutable baseline snapshots (migration 020). Insert-only — nothing here ever updates a row. */
export class BacklogAdjudicationBaselineRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** The next version number for a project (1 for its first baseline), computed inside the same transaction as the insert to avoid a race. */
  nextVersion(projectId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM backlog_adjudication_baselines WHERE project_id = ?").get(projectId) as { v: number };
    return r.v + 1;
  }

  insert(b: BaselineRecord): void {
    this.db
      .prepare(
        `INSERT INTO backlog_adjudication_baselines (id, project_id, version, seed, source_name, repository_revisions_json, models_json, sample_json, metrics_json, established, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.projectId, b.version, b.seed, b.sourceName, JSON.stringify(b.repositoryRevisions), JSON.stringify(b.models), JSON.stringify(b.sample), JSON.stringify(b.metrics), b.established ? 1 : 0, b.createdBy, b.createdAt);
  }

  findById(id: string): BaselineRecord | null {
    const r = this.db.prepare("SELECT * FROM backlog_adjudication_baselines WHERE id = ?").get(id) as Row | undefined;
    return r ? toBaseline(r) : null;
  }

  listForProject(projectId: string): BaselineRecord[] {
    return (this.db.prepare("SELECT * FROM backlog_adjudication_baselines WHERE project_id = ? ORDER BY version DESC").all(projectId) as Row[]).map(toBaseline);
  }
}
