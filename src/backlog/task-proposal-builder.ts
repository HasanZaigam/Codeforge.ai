import type { BacklogAnalysis, BacklogItem, BacklogRelationship, ClaimAssessment, PlatformEvidence, TaskProposalContent, TaskProposalDependency } from "./backlog-types.js";
import { TaskProposalContentSchema } from "./analysis-schema.js";
import { itemRef, truncate } from "./analysis-prompt.js";

export interface ProposalBuildInput {
  item: BacklogItem;
  /** Must be a SUCCEEDED analysis (has a result). */
  analysis: BacklogAnalysis;
  outgoing: BacklogRelationship[];
  incoming: BacklogRelationship[];
  /** Looks up the OTHER item on a relationship (same project) for its title/ref. */
  findItem: (id: string) => BacklogItem | null;
}

const MAX_GOAL_CHARS = 10_000;

/**
 * Deterministically builds a TaskProposal's content from a validated analysis — no model call, no
 * randomness. The analysis is the AI's proposal; THIS is what CodeForge shows a human and, only
 * after explicit approval, turns into `Task.goal`. Because the goal embeds AI-suggested hints, it
 * labels them as unverified suggestions (and marks each candidate file with the PLATFORM's own
 * existence check), so a downstream Implementer treats them as leads, not facts.
 *
 * Dependencies and duplicate warnings are informational: this phase never converts them into
 * executable task dependencies (that is Phase 4C's explicit decision).
 */
export function buildTaskProposalContent(input: ProposalBuildInput): TaskProposalContent {
  const { item, analysis } = input;
  const result = analysis.result;
  if (!result) throw new Error("buildTaskProposalContent requires a succeeded analysis");
  const checks = analysis.platformChecks?.candidateFiles ?? [];

  const candidateFiles = result.candidateFiles.map((f) => ({
    path: f.path,
    reason: f.reason,
    existsInRepository: checks.find((c) => c.path === f.path)?.existsInRepository ?? null,
  }));

  const toDependency = (rel: BacklogRelationship, otherId: string): TaskProposalDependency | null => {
    const other = input.findItem(otherId);
    if (!other) return null;
    return { backlogItemId: other.id, ref: other.externalRef, title: truncate(other.title, 400), confidence: rel.confidence, rationale: truncate(rel.rationale, 500) };
  };

  const dependencies = input.outgoing
    .filter((r) => r.kind === "DEPENDS_ON" && r.status !== "DISMISSED")
    .map((r) => toDependency(r, r.toItemId))
    .filter((d): d is TaskProposalDependency => d !== null)
    .slice(0, 10);

  const seenDuplicates = new Set<string>();
  const duplicateWarnings: TaskProposalDependency[] = [];
  for (const r of [...input.outgoing.filter((x) => x.kind === "POSSIBLE_DUPLICATE").map((x) => ({ rel: x, other: x.toItemId })), ...input.incoming.filter((x) => x.kind === "POSSIBLE_DUPLICATE").map((x) => ({ rel: x, other: x.fromItemId }))]) {
    if (r.rel.status === "DISMISSED" || seenDuplicates.has(r.other)) continue;
    const d = toDependency(r.rel, r.other);
    if (d) {
      seenDuplicates.add(r.other);
      duplicateWarnings.push(d);
    }
  }

  // Phase 4A.2 — what the platform's OWN evidence says about the model's claims. A CONTRADICTED claim is
  // never carried into the proposal as fact: the task becomes an investigation of what already exists.
  const assessment = analysis.platformChecks?.assessment;
  const claimAssessments = (assessment?.claims ?? []).slice(0, 10).map((c) => ({
    statement: truncate(c.statement, 400),
    kind: c.kind,
    aiConfidence: c.aiConfidence,
    status: c.status,
    establishes: c.establishes ?? "nothing",
    reason: truncate(c.reason, 600),
    evidence: evidenceLines(c, assessment?.evidence ?? []),
  }));
  const investigateFirst = claimAssessments.some((c) => c.status === "CONTRADICTED" && (c.kind === "FEATURE_ABSENT" || c.kind === "FILE_EXISTS" || c.kind === "FEATURE_PRESENT" || c.kind === "BEHAVIOR_CORRECT" || c.kind === "BEHAVIOR_INCORRECT"));
  const anyContradicted = claimAssessments.some((c) => c.status === "CONTRADICTED");
  // Phase 4A.4 — the reconciliation signal. It never says "fixed": it says implementation evidence conflicts with a
  // reported absence and behaviour is unverified, and it turns the task into an investigation.
  const reconciliation = assessment?.reconciliation;
  const implementationConflict = reconciliation?.alreadyImplemented ?? "none";

  const content: TaskProposalContent = {
    title: truncate(item.title, 300),
    goal: "", // filled below, once the rest is known
    summary: anyContradicted ? truncate(`${result.summary} [AI-stated — part of this is contradicted by the platform's repository evidence; see the claim assessments.]`, 1500) : result.summary,
    issueType: result.issueType,
    affectedApplication: result.affectedApplication,
    suspectedArea: result.suspectedArea,
    candidateFiles,
    acceptanceCriteria: result.suggestedAcceptanceCriteria,
    validation: result.suggestedValidation,
    dependencies,
    duplicateWarnings: duplicateWarnings.slice(0, 10),
    uncertainty: { overall: result.confidence.overall, uncertainties: result.confidence.uncertainties, missingInformation: result.missingInformation },
    claimAssessments,
    investigateFirst: investigateFirst || implementationConflict !== "none",
    implementationConflict,
  };
  const conflicts = (reconciliation?.findings ?? [])
    .filter((f) => f.outcome === "IMPLEMENTATION_PRESENT" || f.outcome === "IMPLEMENTATION_POSSIBLE")
    .map((f) => `"${truncate(f.statement, 300)}" — ${f.explanation}${f.evidenceIds.length ? ` Evidence: ${evidenceLinesFor(f.evidenceIds, assessment?.evidence ?? []).join("; ")}` : ""}`);
  content.goal = renderGoal(item, content, conflicts);
  return TaskProposalContentSchema.parse(content);
}

/** Bounded, human-readable evidence lines for a claim ("FILE_EXISTS backend/…/otpThrottle.ts"). */
function evidenceLines(claim: ClaimAssessment, evidence: PlatformEvidence[]): string[] {
  return claim.evidenceIds
    .map((id) => evidence.find((e) => e.id === id))
    .filter((e): e is PlatformEvidence => e !== undefined)
    .slice(0, 6)
    .map((e) => truncate(`${e.type}${e.path ? ` ${e.path}` : ""}${e.detail ? ` — ${e.detail}` : ""}`, 300));
}

function evidenceLinesFor(ids: string[], evidence: PlatformEvidence[]): string[] {
  return ids
    .map((id) => evidence.find((e) => e.id === id))
    .filter((e): e is PlatformEvidence => e !== undefined)
    .slice(0, 5)
    .map((e) => truncate(`${e.type}${e.path ? ` ${e.path}` : ""}${e.detail ? ` — ${e.detail}` : ""}`, 300));
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

function renderGoal(item: BacklogItem, c: TaskProposalContent, conflicts: string[] = []): string {
  const sections: string[] = [truncate(item.description, 5000)];
  const analysis: string[] = [
    `Backlog reference: ${itemRef(item)}`,
    `Issue type: ${c.issueType}`,
    c.affectedApplication ? `Affected application: ${c.affectedApplication}` : "",
    c.suspectedArea ? `Suspected area: ${c.suspectedArea}` : "",
  ].filter(Boolean);
  if (c.candidateFiles.length > 0) {
    analysis.push(
      "Likely files (suggestions — verify before relying on them):\n" +
        bullets(
          c.candidateFiles.map((f) => {
            const check = f.existsInRepository === true ? "exists in the repository" : f.existsInRepository === false ? "NOT found in the repository listing" : "not checked";
            return `${f.path} — ${f.reason} [${check}]`;
          }),
        ),
    );
  }
  if (c.acceptanceCriteria.length > 0) analysis.push("Acceptance criteria:\n" + bullets(c.acceptanceCriteria));
  if (c.validation.length > 0) analysis.push("Suggested validation:\n" + bullets(c.validation));
  if (c.uncertainty.uncertainties.length > 0) analysis.push("Open uncertainties:\n" + bullets(c.uncertainty.uncertainties));
  if (c.investigateFirst) {
    const contradicted = c.claimAssessments.filter((a) => a.status === "CONTRADICTED");
    analysis.unshift(
      "INVESTIGATE FIRST — the automated analysis stated the following, but the platform's own repository evidence CONTRADICTS it, so do not treat it as fact:\n" +
        bullets(contradicted.map((a) => `"${a.statement}" (AI confidence: ${a.aiConfidence}) — ${a.reason}${a.evidence.length ? ` Evidence: ${a.evidence.join("; ")}` : ""}`)) +
        "\nWhat exists is not necessarily correct or complete: nothing above establishes whether it behaves as this item requires. Begin by investigating the existing behavior; only then decide what, if anything, must change.",
    );
  }
  if (c.implementationConflict !== "none" && conflicts.length > 0) {
    analysis.unshift(
      `IMPLEMENTATION EVIDENCE CONFLICTS WITH THE REPORTED ABSENCE (${c.implementationConflict}) — the platform's own repository evidence shows code related to what this item says is missing. This does NOT mean the item is fixed or that the code behaves correctly: behaviour was not verified.\n` +
        bullets(conflicts) +
        "\nBegin by verifying the existing behaviour (run the project's checks, reproduce the report). Change code only if that shows the reported problem is real; otherwise report back that it appears to be already implemented.",
    );
  }
  const unsettled = c.claimAssessments.filter((a) => a.status === "UNRESOLVED" || a.status === "NOT_CHECKED");
  if (unsettled.length > 0) {
    analysis.push("Claims the platform could not confirm or refute (treat as unverified):\n" + bullets(unsettled.map((a) => `[${a.status}] "${a.statement}" — ${a.reason}`)));
  }
  const related = [
    ...c.dependencies.map((d) => `Depends on ${d.ref ?? d.backlogItemId}: ${d.title}`),
    ...c.duplicateWarnings.map((d) => `Possible duplicate of ${d.ref ?? d.backlogItemId}: ${d.title}`),
  ];
  if (related.length > 0) analysis.push("Related backlog items (informational — not enforced):\n" + bullets(related));

  sections.push(
    "---\nAnalysis notes (generated by an automated backlog analysis and approved by a person; treat file and area hints as unverified suggestions, not facts):\n" +
      analysis.join("\n"),
  );
  return truncate(sections.join("\n\n"), MAX_GOAL_CHARS);
}
