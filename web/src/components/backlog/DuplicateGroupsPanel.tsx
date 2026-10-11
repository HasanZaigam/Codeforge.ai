import { useCallback, useEffect, useState } from "react";
import { bulkBacklogApi, type BacklogGroupsDTO } from "../../api/index.js";

/** Duplicate groups and dependency proposals across the backlog. A human confirms or dismisses each; nothing is merged, removed, ordered or blocked. */
export function DuplicateGroupsPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [groups, setGroups] = useState<BacklogGroupsDTO>();
  const load = useCallback(() => { bulkBacklogApi.groups(projectId).then(setGroups).catch(() => setGroups(undefined)); }, [projectId]);
  useEffect(load, [load, refreshKey]);
  if (!groups || (groups.duplicateGroups.length === 0 && groups.dependencies.length === 0)) return null;
  const decide = async (id: string, d: "confirm" | "dismiss") => { await bulkBacklogApi.reviewRelationship(id, d); load(); };
  const label = (items: Array<{ id: string; ref: string | null; title: string }>, id: string) => items.find((i) => i.id === id)?.ref ?? id.slice(0, 6);
  return (
    <section aria-label="Duplicate and dependency proposals" className="section">
      <h3>Proposed relationships</h3>
      <p className="field-hint">These are proposals for you to review. Confirming records your decision; it does not merge items, delete anything or change execution order.</p>
      {groups.duplicateGroups.map((g, i) => (
        <div key={i} className="card">
          <strong>Potential duplicate group:</strong> {g.items.map((it) => it.ref ?? it.title).join(" · ")}
          <ul className="backlog-bullets">
            {g.edges.map((e) => (
              <li key={e.id}>
                {label(g.items, e.fromItemId)} ↔ {label(g.items, e.toItemId)} — confidence {e.confidence}, {e.status.toLowerCase()} — {e.rationale}{" "}
                {e.status === "PROPOSED" && (
                  <>
                    <button className="btn btn-secondary" onClick={() => decide(e.id, "confirm")}>Confirm duplicate</button>{" "}
                    <button className="btn btn-secondary" onClick={() => decide(e.id, "dismiss")}>Reject duplicate</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {groups.dependencies.length > 0 && (
        <div className="card">
          <strong>Dependency proposals</strong>
          <ul className="backlog-bullets">
            {groups.dependencies.map((d) => (
              <li key={d.id}>
                {d.from.ref ?? d.from.title} may depend on {d.to.ref ?? d.to.title} — confidence {d.confidence}, {d.status.toLowerCase()} — {d.rationale}{" "}
                {d.status === "PROPOSED" && (
                  <>
                    <button className="btn btn-secondary" onClick={() => decide(d.id, "confirm")}>Confirm dependency</button>{" "}
                    <button className="btn btn-secondary" onClick={() => decide(d.id, "dismiss")}>Reject dependency</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
