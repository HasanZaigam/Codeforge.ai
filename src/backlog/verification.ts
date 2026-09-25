import type { Project, VerificationEvidence } from "../domain/types.js";
import { executeApprovedVerification, resolveApprovedVerificationChecks } from "../review/reviewer-verification.js";
import { getHeadCommit } from "../source-control/git-commit.js";
import type { AnalysisClaim, ClaimAssessment, EvidenceAssessment, PlatformEvidence, VerificationRequirement, VerificationState } from "./backlog-types.js";

/**
 * The platform-owned SEAM for execution-backed evidence during backlog analysis (Phase 4A.3, GAP-033).
 *
 *     AI claim  ->  required verification  ->  platform verification executor  ->  CHECK_RESULT evidence
 *
 * What is built: the shape of that pipeline, a policy gate, and a runner that reuses the EXISTING approved
 * check machinery (`executeApprovedVerification` -> `runCheck`: the project's own configured
 * build/test/lint/typecheck command, the existing timeout and cancellation) — no second execution engine.
 *
 * What is NOT turned on: production analysis runs with `ANALYSIS_VERIFICATION_DISABLED`. It records what
 * verification WOULD bear on a behaviour claim (`planVerification`, state `not_run`) and executes nothing.
 * Nothing here is reachable from model output: the analysis schema is strict and has no verification /
 * command / check field (an output with one is malformed and rejected whole), a requirement's `checkId` is
 * chosen by the platform from the project's own configuration, and the command that would run is looked up
 * from that configuration by name — never read from a claim, a requirement, or the model.
 *
 * WHAT A RESULT MEANS: `CHECK_RESULT` says "the project's configured `test` check returned <outcome> at
 * revision R". That is EXECUTION-level evidence about the CHECK. Checks are not bound to individual claims
 * (the project has one `test` command, not a test-per-behaviour), so a passing check does NOT make a behaviour
 * claim SUPPORTED — the claim stays UNRESOLVED and its reason says exactly that. Closing that gap needs a
 * per-claim check binding, deliberately left for a later phase; GAP-033 therefore stays open.
 */

export type CheckId = VerificationRequirement["checkId"];

export interface VerificationPolicy {
  /** Master switch. When false the runner executes nothing, whatever it is asked. */
  allowExecution: boolean;
  /** Only these approved checks may run (intersected with what the project has configured). */
  allowedChecks: readonly CheckId[];
  /** Upper bound on one check's wall-clock time, enforced by the existing `runCheck` timeout. */
  maxCheckMs: number;
}

/** What production analysis uses today: plan and record, execute nothing. */
export const ANALYSIS_VERIFICATION_DISABLED: VerificationPolicy = { allowExecution: false, allowedChecks: [], maxCheckMs: 0 };

const NOT_RUN_REASON =
  "Backlog analysis is read-only by policy and does not execute the project's checks, so nothing was run. The project's configured '{check}' check is the platform-owned way to establish this; it has not been used.";

/**
 * Which approved check would bear on each behaviour claim. Pure and platform-decided: only BEHAVIOR_* claims
 * (the ones inspection cannot settle) get a requirement, and only for a check the project has actually
 * configured. Existence claims never need execution.
 */
export function planVerification(claims: AnalysisClaim[], project: Pick<Project, "commands">, policy: VerificationPolicy = ANALYSIS_VERIFICATION_DISABLED): VerificationRequirement[] {
  const approved = resolveApprovedVerificationChecks(project as Project) as CheckId[];
  if (!approved.includes("test")) return [];
  const out: VerificationRequirement[] = [];
  claims.forEach((claim, claimIndex) => {
    if (claim.kind !== "BEHAVIOR_CORRECT" && claim.kind !== "BEHAVIOR_INCORRECT") return;
    if (out.length >= 10) return;
    out.push({
      claimIndex,
      checkId: "test",
      state: "not_run",
      reason: policy.allowExecution ? "Verification is permitted by policy but has not been run yet." : NOT_RUN_REASON.replace("{check}", "test"),
      evidenceId: null,
    });
  });
  return out;
}

export interface VerificationRunContext {
  project: Project;
  /** A workspace the CALLER prepared at `revision`. The runner never clones, fetches or checks anything out. */
  workspacePath: string;
  /** The exact commit the evidence must describe. The workspace's HEAD must equal it or nothing runs. */
  revision: string;
  signal: AbortSignal;
  /** Test-only override of the check timeout (mirrors `executeApprovedVerification`). */
  checkTimeoutMsOverride?: number;
}

export interface VerificationRun {
  checkId: CheckId;
  /** The claims this single execution is reported for (one run serves every claim needing the same check). */
  claimIndexes: number[];
  state: VerificationState;
  evidence: VerificationEvidence | null;
  reason: string;
}

const CHECK_STATE: Record<string, VerificationState> = {
  passed: "passed",
  failed: "failed",
  timed_out: "timed_out",
  infrastructure_error: "infrastructure_error",
  rejected: "rejected",
};

/**
 * Decides whether each requirement may run and, if so, runs the project's own configured check ONCE per
 * distinct check, bound to `ctx.revision`. Every refusal (policy off, check not allowed/configured, workspace
 * not at the requested revision) happens BEFORE any process is spawned.
 */
export async function runVerification(requirements: VerificationRequirement[], policy: VerificationPolicy, ctx: VerificationRunContext): Promise<VerificationRun[]> {
  const byCheck = new Map<CheckId, number[]>();
  for (const r of requirements) if (r.state === "not_run") byCheck.set(r.checkId, [...(byCheck.get(r.checkId) ?? []), r.claimIndex]);

  const runs: VerificationRun[] = [];
  const approved = resolveApprovedVerificationChecks(ctx.project);
  for (const [checkId, claimIndexes] of byCheck) {
    const refuse = (reason: string): void => {
      runs.push({ checkId, claimIndexes, state: "rejected", evidence: null, reason });
    };
    if (!policy.allowExecution) {
      runs.push({ checkId, claimIndexes, state: "not_run", evidence: null, reason: NOT_RUN_REASON.replace("{check}", checkId) });
      continue;
    }
    if (!policy.allowedChecks.includes(checkId)) {
      refuse(`The '${checkId}' check is not permitted for analysis by policy.`);
      continue;
    }
    if (!approved.includes(checkId)) {
      refuse(`The project has no '${checkId}' command configured.`);
      continue;
    }
    let head: string;
    try {
      head = await getHeadCommit(ctx.workspacePath, ctx.signal);
    } catch {
      refuse("The workspace's commit could not be read, so the result could not be bound to a revision.");
      continue;
    }
    if (head !== ctx.revision) {
      refuse(`The workspace is at ${head.slice(0, 12)}, not the analysed revision ${ctx.revision.slice(0, 12)}; nothing was run.`);
      continue;
    }
    const evidence = await executeApprovedVerification({
      workspacePath: ctx.workspacePath,
      expectedBranch: "(analysis)",
      project: ctx.project,
      request: { checkId, purpose: "backlog analysis claim verification" },
      signal: ctx.signal,
      checkTimeoutMsOverride: ctx.checkTimeoutMsOverride ?? Math.max(1, policy.maxCheckMs),
    });
    const state = CHECK_STATE[evidence.outcome] ?? "failed";
    // Bound to the revision the check ACTUALLY ran against: HEAD is re-read AFTER the run (a check that commits,
    // or a workspace another process moved, must not leave a result labelled with the old revision).
    let headAfter: string | null = null;
    try {
      headAfter = await getHeadCommit(ctx.workspacePath, ctx.signal);
    } catch {
      headAfter = null;
    }
    const bound = state === "rejected" || (evidence.commitSha === ctx.revision && headAfter === ctx.revision);
    runs.push({
      checkId,
      claimIndexes,
      state: bound ? state : "rejected",
      evidence,
      reason: bound ? `The project's configured '${checkId}' check ${describe(state)}.` : "The workspace moved during verification; the result is not bound to the analysed revision and is discarded.",
    });
  }
  return runs;
}

function describe(state: VerificationState): string {
  return state === "passed" ? "passed" : state === "failed" ? "failed" : state === "timed_out" ? "timed out" : state === "infrastructure_error" ? "could not be started" : "was refused";
}

/**
 * Folds executed verification into an assessment — pure. Adds `CHECK_RESULT` evidence and updates the
 * requirement rows. Deliberately does NOT change any claim's STATUS: a configured check's outcome is not
 * bound to a specific claim, so it cannot support or contradict one. It only annotates the affected claims'
 * reasons with what the check did and did not show, so "the code contains X" and "the configured test
 * passed" stay two different statements.
 */
export function applyVerification(assessment: EvidenceAssessment, runs: VerificationRun[], revision: string): EvidenceAssessment {
  const evidence: PlatformEvidence[] = [...assessment.evidence];
  const requirements = (assessment.verification ?? []).map((r) => ({ ...r }));
  const claims: ClaimAssessment[] = assessment.claims.map((c) => ({ ...c }));

  for (const run of runs) {
    let evidenceId: string | null = null;
    if (run.evidence && (run.state === "passed" || run.state === "failed" || run.state === "timed_out" || run.state === "infrastructure_error")) {
      evidenceId = `E${evidence.length + 1}`;
      evidence.push({
        id: evidenceId,
        type: "CHECK_RESULT",
        source: "platform_check",
        path: null,
        detail: `${run.checkId}: ${run.state}${run.evidence.exitCode !== null ? ` (exit ${run.evidence.exitCode})` : ""} in ${run.evidence.durationMs}ms @ ${revision.slice(0, 12)}`,
        matchedTerms: [],
        revision,
      });
    }
    for (const claimIndex of run.claimIndexes) {
      const req = requirements.find((r) => r.claimIndex === claimIndex && r.checkId === run.checkId);
      if (req) {
        req.state = run.state;
        req.reason = run.reason;
        req.evidenceId = evidenceId;
      }
      const claim = claims.find((c) => c.claimIndex === claimIndex);
      if (claim && evidenceId) {
        claim.evidenceIds = [...claim.evidenceIds, evidenceId];
        claim.reason = `${claim.reason} Separately, the project's configured '${run.checkId}' check ${describe(run.state)} at revision ${revision.slice(0, 12)} — that is the project's whole check, not a test of this claim, so it does not settle it.`;
      }
    }
  }
  return { ...assessment, evidence, claims, verification: requirements };
}
