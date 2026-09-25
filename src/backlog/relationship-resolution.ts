import { wouldCreateCycle } from "../application/task-service.js";
import type { AnalysisResult, BacklogItem, BacklogRelationshipKind } from "./backlog-types.js";
import type { RelationshipProposal } from "../persistence/repositories/backlog-relationship-repository.js";

export interface ResolvedRelationships {
  proposals: RelationshipProposal[];
  /** `ref` values that matched no sibling item — dropped (a model may not invent items). */
  unresolved: string[];
  dropped: Array<{ ref: string; kind: BacklogRelationshipKind; reason: string }>;
}

/**
 * Turns a model's duplicate/dependency CANDIDATES into persistable PROPOSALS — deterministically,
 * and only ever against items that really exist in the same project. The model cannot introduce an
 * item (an unmatched ref is dropped and reported), cannot point an item at itself, and cannot create
 * a dependency cycle (a would-be cycle among live DEPENDS_ON proposals is dropped): "Do not allow the
 * AI to create an execution deadlock." Nothing here touches Tasks or execution order — these are
 * rows for a human to look at.
 *
 * `liveDependsOnEdges` is every live DEPENDS_ON edge in the project; edges leaving `item` itself are
 * ignored, because a re-analysis replaces them.
 */
export function resolveRelationshipProposals(
  item: BacklogItem,
  result: Pick<AnalysisResult, "duplicateCandidates" | "dependencyCandidates">,
  siblings: BacklogItem[],
  liveDependsOnEdges: Array<{ fromItemId: string; toItemId: string }>,
): ResolvedRelationships {
  const out: ResolvedRelationships = { proposals: [], unresolved: [], dropped: [] };

  const resolve = (ref: string): BacklogItem | null => {
    const wanted = ref.trim();
    const lower = wanted.toLowerCase();
    return siblings.find((s) => s.id === wanted) ?? siblings.find((s) => s.externalRef !== null && s.externalRef.toLowerCase() === lower) ?? null;
  };
  const isSelf = (ref: string): boolean => {
    const wanted = ref.trim();
    return wanted === item.id || (item.externalRef !== null && item.externalRef.toLowerCase() === wanted.toLowerCase());
  };

  const seen = new Set<string>();
  const consider = (kind: BacklogRelationshipKind, ref: string, confidence: RelationshipProposal["confidence"], rationale: string, extraCheck?: (target: BacklogItem) => string | null): void => {
    if (isSelf(ref)) {
      out.dropped.push({ ref, kind, reason: "self_reference" });
      return;
    }
    const target = resolve(ref);
    if (!target) {
      out.unresolved.push(ref);
      return;
    }
    const key = `${kind}|${target.id}`;
    if (seen.has(key)) return;
    const rejection = extraCheck?.(target);
    if (rejection) {
      out.dropped.push({ ref, kind, reason: rejection });
      return;
    }
    seen.add(key);
    out.proposals.push({ kind, toItemId: target.id, confidence, rationale });
  };

  for (const c of result.duplicateCandidates) consider("POSSIBLE_DUPLICATE", c.ref, c.confidence, c.rationale);

  // Dependencies: walk with a growing edge set so two proposals from ONE analysis can't jointly close a cycle either.
  const edges = liveDependsOnEdges.filter((e) => e.fromItemId !== item.id).map((e) => ({ taskId: e.fromItemId, dependsOnTaskId: e.toItemId }));
  for (const c of result.dependencyCandidates) {
    consider("DEPENDS_ON", c.ref, c.confidence, c.rationale, (target) => {
      if (wouldCreateCycle(item.id, target.id, edges)) return "would_create_cycle";
      edges.push({ taskId: item.id, dependsOnTaskId: target.id });
      return null;
    });
  }
  return out;
}
