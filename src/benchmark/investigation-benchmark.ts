import { RepositoryInspector } from "../backlog/repository-inspector.js";
import { buildRepositoryIndex, sourceKeyOf, type RepositoryIndex } from "../backlog/repository-index.js";
import { detectPremise, investigate } from "../backlog/investigation.js";
import type { InvestigationSignal } from "../backlog/backlog-types.js";
import type { GroundTruthSet } from "./retrieval-benchmark.js";
import { openLocalGitSession } from "./local-git-session.js";

/**
 * Measures the platform's premise investigation against history (Phase 4A.5). For each item it runs the investigation at
 * two objectively different revisions of the same repository: BEFORE the fix merged (the reported problem existed, so a
 * confident "implementation present" here is a false alarm risk) and AFTER it merged (for items whose premise names a
 * mechanism the fix added, "present" is expected). No model is involved and no claim is needed.
 */
export interface InvestigationRow {
  id: string;
  premise: { kind: string; mechanism: string } | null;
  before: InvestigationSignal;
  after: InvestigationSignal | null;
  /** What the fix's own text says it added (never used for scoring; shown for a human reading the table). */
  title: string;
}

export interface InvestigationReport {
  items: number;
  withPremise: number;
  rows: InvestigationRow[];
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  /** Items where the signal is PRESENT before the fix — the false-alarm candidates (a human should read each). */
  presentBefore: string[];
  /** Premise items that flip to PRESENT once the fix exists. */
  flippedToPresentAfter: string[];
}

export async function runInvestigationBenchmark(set: GroundTruthSet, repoDir: string): Promise<InvestigationReport> {
  const signal = new AbortController().signal;
  const cache = new Map<string, RepositoryIndex>();
  const at = async (revision: string, text: string): Promise<InvestigationSignal> => {
    const session = await openLocalGitSession(repoDir, revision);
    try {
      if (!cache.has(session.revision!)) cache.set(session.revision!, await buildRepositoryIndex(session, sourceKeyOf({ repoUrl: repoDir, defaultBranch: "main" }), signal));
      const { investigation } = await investigate({ text, session, inspector: new RepositoryInspector(session), index: cache.get(session.revision!)!, startEvidenceNumber: 1, signal });
      return investigation.signal;
    } finally {
      await session.dispose();
    }
  };
  const rows: InvestigationRow[] = [];
  for (const item of set.items) {
    const text = `${item.title}\n${item.description}`;
    const premise = detectPremise(text);
    rows.push({ id: item.id, title: item.title.slice(0, 70), premise: premise && { kind: premise.kind, mechanism: premise.mechanism }, before: await at(item.revision, text), after: item.postFixRevision ? await at(item.postFixRevision, text) : null });
  }
  const count = (xs: Array<InvestigationSignal | null>) => xs.reduce<Record<string, number>>((m, x) => (x ? { ...m, [x]: (m[x] ?? 0) + 1 } : m), {});
  return {
    items: rows.length,
    withPremise: rows.filter((r) => r.premise).length,
    rows,
    countsBefore: count(rows.map((r) => r.before)),
    countsAfter: count(rows.map((r) => r.after)),
    presentBefore: rows.filter((r) => r.before === "IMPLEMENTATION_PRESENT").map((r) => r.id),
    flippedToPresentAfter: rows.filter((r) => r.premise && r.before !== "IMPLEMENTATION_PRESENT" && r.after === "IMPLEMENTATION_PRESENT").map((r) => r.id),
  };
}
