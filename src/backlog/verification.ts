import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedClaimCheck, Project } from "../domain/types.js";
import { gitCredentialEnv } from "../source-control/git-credential-env.js";
import type { SourceControlProviderRegistry } from "../source-control/source-control-provider.js";
import { getHeadCommit } from "../source-control/git-commit.js";
import { evaluateCompatibility, type Compatibility } from "./claim-semantics.js";
import { runCheck } from "../validation/validation-runner.js";
import type { AnalysisClaim, ClaimAssessment, ClaimVerificationRecord, EvidenceAssessment, PlatformEvidence, VerificationRequirement, VerificationState } from "./backlog-types.js";

const execFileAsync = promisify(execFile);

/**
 * Claim-BOUND verification (Phase 4A.5, GAP-033):
 *
 *   AI claim ─► bound approved check ─► platform executor ─► claim-verification record ─► CHECK_RESULT evidence
 *
 * The chain, and what each link means:
 *  1. CLAIM ID       `claimIdOf`: a content hash of the claim. A verification is about THIS claim.
 *  2. APPROVED CHECK `ApprovedClaimCheck`, declared by the project owner (same trust level as the project's own build/test
 *                    commands) with a stable id, an exact command, a timeout, prerequisite files, and what a PASS
 *                    establishes. There is nowhere for a model to supply a check, a command or an argument: the analysis
 *                    schema is strict and has no such field.
 *  3. BINDING        `bindClaimsToChecks`: the platform matches a claim to a check ONLY when the claim is a behaviour claim
 *                    of a kind the check speaks to and the claim's own words contain every binding group the check
 *                    declares. No match ⇒ no requirement ⇒ the claim's behaviour stays BEHAVIOR_UNVERIFIED.
 *  4. EXECUTION      `runClaimVerification`: one run per distinct check, in a workspace proven — via git, before AND after
 *                    the run — to be at the analysed revision, under the existing check runner's timeout/cancellation.
 *  5. RECORD         a `ClaimVerificationRecord` bound to (claimId, checkId, checkFingerprint, revision).
 *  6. STATUS         reconciliation (reconciliation.ts) turns a record into CHECK_VERIFIED / CHECK_CONTRADICTED only if every
 *                    binding still matches. A failure is recorded but establishes nothing.
 *
 * Production ANALYSIS still executes nothing (`ANALYSIS_VERIFICATION_DISABLED`): running a project's code is an explicit,
 * human-requested step (`ClaimVerifier`), never a side effect of analysing an item.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stable identity of a claim: the same statement/kind/path/terms always give the same id, so a verification stays attached to it. */
export function claimIdOf(claim: AnalysisClaim): string {
  return createHash("sha256").update(JSON.stringify([claim.kind, claim.statement.trim().toLowerCase(), claim.path ?? null, [...claim.searchTerms].map((t) => t.toLowerCase()).sort()])).digest("hex").slice(0, 16);
}

/** Identity of a check DEFINITION. Any change to what it runs or claims to establish makes it a different check, invalidating old results. */
export function checkFingerprint(check: ApprovedClaimCheck): string {
  return createHash("sha256")
    .update(JSON.stringify([check.id, check.command, check.application ?? null, check.timeoutMs ?? null, [...(check.requiresFiles ?? [])].sort(), check.establishes.behavior, check.establishes.claimTerms, check.establishes.scope ?? null, [...(check.establishes.claimKinds ?? ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"])].sort(), check.passMeans]))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Binding (deterministic, conservative)
// ---------------------------------------------------------------------------

const wordsOf = (text: string): Set<string> => new Set(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const groupMatches = (group: string[], words: Set<string>): boolean => group.some((t) => words.has(t) || [...words].some((w) => w.length > t.length && t.length >= 4 && w.startsWith(t)));

/**
 * Applications a claim can be about, by the words it uses (statement, search terms and the file path it names). A check
 * declares the application it exercises; a claim that talks ONLY about another application is never bound to it — a backend
 * throttle test says nothing about a mobile client that "does not check the cooldown". (Found by the first real validation
 * run, which bound exactly that claim; see docs/BACKLOG_INTELLIGENCE.md §4c.)
 */
const APPLICATION_WORDS: Record<string, string[]> = {
  backend: ["backend", "server", "api", "endpoint", "controller", "middleware", "express", "mongoose"],
  mobile: ["mobile", "flutter", "android", "ios", "dart", "widget"],
  web: ["web", "react", "browser", "nextjs", "tsx"],
  frontend: ["frontend", "client", "ui"],
};
const APPLICATION_ALIASES: Record<string, string> = { server: "backend", api: "backend", app: "mobile", admin: "web" };

function applicationGroups(claimText: string): Set<string> {
  const words = wordsOf(claimText);
  const out = new Set<string>();
  for (const [group, list] of Object.entries(APPLICATION_WORDS)) if (list.some((w) => words.has(w))) out.add(group);
  return out;
}

/** True unless the check names a known application and the claim talks only about OTHER applications. Unknown application names never filter. */
export function applicationCompatible(checkApplication: string | undefined, claim: Pick<AnalysisClaim, "statement" | "searchTerms" | "path">): boolean {
  if (!checkApplication) return true;
  const raw = checkApplication.toLowerCase();
  const group = APPLICATION_ALIASES[raw] ?? (raw in APPLICATION_WORDS ? raw : null);
  if (!group) return true;
  const mentioned = applicationGroups(`${claim.statement} ${claim.searchTerms.join(" ")} ${(claim.path ?? "").replace(/[/._-]/g, " ")}`);
  if (mentioned.size === 0 || mentioned.has(group)) return true;
  // "frontend" is the umbrella for mobile and web clients.
  return group === "frontend" && (mentioned.has("mobile") || mentioned.has("web"));
}

export interface ClaimBinding {
  claimIndex: number;
  claimId: string;
  check: ApprovedClaimCheck;
  fingerprint: string;
}

/** A relevant check for a behaviour claim together with the platform's verdict on whether it is SUFFICIENT (Phase 4A.7). */
export interface VerificationCandidate extends Compatibility {
  claimIndex: number;
  claimId: string;
  checkId: string;
}

/** Every (claim, check) pair the platform considered, with relevance and sufficiency. Discovery + explanation; `bindClaimsToChecks` is the authorization. Pure. */
export function verificationCandidates(claims: AnalysisClaim[], checks: ApprovedClaimCheck[] | undefined): VerificationCandidate[] {
  const out: VerificationCandidate[] = [];
  claims.forEach((claim, claimIndex) => {
    if (claim.kind !== "BEHAVIOR_CORRECT" && claim.kind !== "BEHAVIOR_INCORRECT") return;
    for (const check of checks ?? []) {
      const c = evaluateCompatibility(check, claim, applicationCompatible(check.application ?? check.establishes.scope?.application, claim));
      if (c.relevance === "relevant") out.push({ ...c, claimIndex, claimId: claimIdOf(claim), checkId: check.id });
    }
  });
  return out;
}

/** Which approved checks may VERIFY which claims: only SUFFICIENT ones. Topic overlap alone never authorizes anything. Pure. */
export function bindClaimsToChecks(claims: AnalysisClaim[], checks: ApprovedClaimCheck[] | undefined): ClaimBinding[] {
  const byId = new Map((checks ?? []).map((c) => [c.id, c]));
  return verificationCandidates(claims, checks)
    .filter((c) => c.sufficiency === "sufficient")
    .map((c) => ({ claimIndex: c.claimIndex, claimId: c.claimId, check: byId.get(c.checkId)!, fingerprint: checkFingerprint(byId.get(c.checkId)!) }));
}

// ---------------------------------------------------------------------------
// Policy + planning
// ---------------------------------------------------------------------------

export interface VerificationPolicy {
  /** Master switch. When false the runner executes nothing, whatever it is asked. */
  allowExecution: boolean;
}

/** What production backlog ANALYSIS uses: plan and record, execute nothing. */
export const ANALYSIS_VERIFICATION_DISABLED: VerificationPolicy = { allowExecution: false };
/** An explicit, human-requested verification (ClaimVerifier / `validate:claim-verification`). */
export const HUMAN_REQUESTED_VERIFICATION: VerificationPolicy = { allowExecution: true };

const NOT_RUN = "Backlog analysis is read-only by policy: it planned this verification but ran nothing. A person can request it explicitly.";

/** One requirement per (claim, bound approved check), all `not_run`. Claims with no approved check get none — their behaviour stays unverified. */
export function planVerification(claims: AnalysisClaim[], project: Pick<Project, "commands">): VerificationRequirement[] {
  return bindClaimsToChecks(claims, project.commands?.claimChecks)
    .slice(0, 20)
    .map((b) => ({ claimIndex: b.claimIndex, claimId: b.claimId, checkId: b.check.id, state: "not_run" as const, reason: NOT_RUN, evidenceId: null }));
}

// ---------------------------------------------------------------------------
// Workspace at an exact revision
// ---------------------------------------------------------------------------

export interface RevisionWorkspace {
  dir: string;
  /** The commit the workspace is at, read from git itself. */
  head: string;
  dispose(): Promise<void>;
}

/**
 * A throwaway checkout of the project's repository at EXACTLY `revision` (a full 40-hex commit id), fetched by SHA with the
 * project's own clone credential (env-only, never on a command line). Never touches a task workspace and never pushes.
 */
export async function prepareRevisionWorkspace(project: Project, revision: string, providers: SourceControlProviderRegistry, signal: AbortSignal, timeoutMs = 300_000): Promise<RevisionWorkspace> {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("revision must be a full commit id");
  const credential = await providers.resolve(project.sourceControlProvider).resolveCloneCredential(project, signal);
  const dir = await mkdtemp(join(tmpdir(), "codeforge-verify-"));
  const env = { ...process.env, ...gitCredentialEnv(credential), GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir, signal, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  try {
    await git(["init", "-q"]);
    await git(["remote", "add", "origin", project.repoUrl]);
    await git(["fetch", "-q", "--depth", "1", "origin", revision]);
    await git(["checkout", "-q", "--detach", revision]);
    const { stdout } = await git(["rev-parse", "HEAD"]);
    return { dir, head: stdout.trim(), dispose: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunClaimVerificationInput {
  analysisId: string;
  project: Pick<Project, "commands">;
  requirements: VerificationRequirement[];
  claims: AnalysisClaim[];
  /** The analysed revision. The workspace's HEAD must equal it before AND after the run, or nothing counts. */
  revision: string;
  workspacePath: string;
  policy: VerificationPolicy;
  signal: AbortSignal;
  requestedBy: string;
  /** Files present at `revision` (for `requiresFiles`); defaults to checking the workspace on disk. */
  fileExists?: (repoRelativePath: string) => boolean | Promise<boolean>;
  /** Test-only override of a check's timeout. */
  checkTimeoutMsOverride?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const STATE: Record<string, VerificationState> = { passed: "passed", failed: "failed", timed_out: "timed_out", infrastructure_error: "infrastructure_error" };

/**
 * Runs each distinct APPROVED check once and returns one record per requirement. The command is looked up BY ID in the
 * project's own approved checks — a requirement (or claim, or model) can only select among what already exists. Every refusal
 * (policy off, unknown/changed check, missing prerequisite, wrong revision) happens BEFORE a process is spawned.
 */
export async function runClaimVerification(input: RunClaimVerificationInput): Promise<ClaimVerificationRecord[]> {
  const checks = new Map((input.project.commands?.claimChecks ?? []).map((c) => [c.id, c]));
  const bindings = bindClaimsToChecks(input.claims, [...checks.values()]);
  const records: ClaimVerificationRecord[] = [];
  const executed = new Map<string, { state: VerificationState; exitCode: number | null; durationMs: number; log: string | null; headBefore: string | null; headAfter: string | null }>();

  for (const req of input.requirements) {
    const base = (check: ApprovedClaimCheck | null, fingerprint: string): Omit<ClaimVerificationRecord, "state" | "exitCode" | "durationMs" | "logExcerpt" | "headBefore" | "headAfter"> => ({
      id: randomUUID(),
      analysisId: input.analysisId,
      claimId: req.claimId ?? "",
      claimIndex: req.claimIndex,
      checkId: req.checkId,
      checkFingerprint: fingerprint,
      revision: input.revision,
      command: check?.command ?? "",
      requestedBy: input.requestedBy,
      createdAt: new Date().toISOString(),
    });
    const refuse = (check: ApprovedClaimCheck | null, fingerprint: string, why: string, heads: { before: string | null; after: string | null } = { before: null, after: null }) =>
      records.push({ ...base(check, fingerprint), state: "rejected", exitCode: null, durationMs: 0, logExcerpt: why, headBefore: heads.before, headAfter: heads.after });

    const check = checks.get(req.checkId) ?? null;
    if (!check) {
      refuse(null, "", `"${req.checkId}" is not an approved check of this project; nothing was run.`);
      continue;
    }
    const fingerprint = checkFingerprint(check);
    const claim = input.claims[req.claimIndex];
    const bound = claim !== undefined && req.claimId === claimIdOf(claim) && bindings.some((b) => b.claimIndex === req.claimIndex && b.check.id === check.id);
    if (!bound) {
      refuse(check, fingerprint, "This check is not bound to this claim by the project's declared binding; nothing was run.");
      continue;
    }
    if (!input.policy.allowExecution) {
      refuse(check, fingerprint, NOT_RUN);
      continue;
    }

    let run = executed.get(check.id);
    if (!run) {
      // Prerequisite state: every required file exists at the analysed revision.
      let missing: string | null = null;
      for (const f of check.requiresFiles ?? []) if (!(await (input.fileExists ?? (async () => true))(f))) missing = f;
      if (missing) {
        run = { state: "rejected", exitCode: null, durationMs: 0, log: `Prerequisite file ${missing} does not exist at revision ${input.revision.slice(0, 12)}; nothing was run.`, headBefore: null, headAfter: null };
      } else {
        let before: string | null = null;
        try {
          before = await getHeadCommit(input.workspacePath, input.signal);
        } catch {
          before = null;
        }
        if (before !== input.revision) {
          run = { state: "rejected", exitCode: null, durationMs: 0, log: `The workspace is at ${before ? before.slice(0, 12) : "an unknown commit"}, not the analysed revision ${input.revision.slice(0, 12)}; nothing was run.`, headBefore: before, headAfter: null };
        } else {
          const result = await runCheck(input.workspacePath, "test", check.command, input.signal, input.checkTimeoutMsOverride ?? check.timeoutMs ?? DEFAULT_TIMEOUT_MS);
          let after: string | null = null;
          try {
            after = await getHeadCommit(input.workspacePath, input.signal);
          } catch {
            after = null;
          }
          const state: VerificationState = after === input.revision ? (STATE[result.outcome] ?? "failed") : "rejected";
          run = { state, exitCode: result.exitCode, durationMs: result.durationMs, log: after === input.revision ? result.logExcerpt : "The workspace moved during verification; the result is not bound to the analysed revision and is discarded.", headBefore: before, headAfter: after };
        }
      }
      executed.set(check.id, run);
    }
    records.push({ ...base(check, fingerprint), state: run.state, exitCode: run.exitCode, durationMs: run.durationMs, logExcerpt: run.log, headBefore: run.headBefore, headAfter: run.headAfter });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Folding records into an assessment (evidence + requirement rows) — pure
// ---------------------------------------------------------------------------

/** Adds `CHECK_RESULT` evidence and updates the requirement rows. Does NOT decide any claim's status — reconciliation does, and only for records that still bind. */
export function applyVerificationRecords(assessment: EvidenceAssessment, records: ClaimVerificationRecord[], revision: string): EvidenceAssessment {
  const evidence: PlatformEvidence[] = [...assessment.evidence];
  const requirements: VerificationRequirement[] = (assessment.verification ?? []).map((r) => ({ ...r }));
  const claims: ClaimAssessment[] = assessment.claims.map((c) => ({ ...c }));
  for (const rec of records) {
    let evidenceId: string | null = null;
    if (rec.state !== "rejected") {
      evidenceId = `E${evidence.length + 1}`;
      evidence.push({
        id: evidenceId,
        type: "CHECK_RESULT",
        source: "platform_check",
        path: null,
        detail: `${rec.checkId}: ${rec.state}${rec.exitCode !== null ? ` (exit ${rec.exitCode})` : ""} in ${rec.durationMs}ms @ ${rec.revision.slice(0, 12)} — bound to claim ${rec.claimId}`,
        matchedTerms: [],
        revision: rec.revision,
      });
    }
    const req = requirements.find((r) => r.claimIndex === rec.claimIndex && r.checkId === rec.checkId);
    if (req) {
      req.state = rec.state;
      req.reason = rec.state === "rejected" ? (rec.logExcerpt ?? "refused") : `The approved '${rec.checkId}' check ${rec.state === "passed" ? "passed" : rec.state === "failed" ? "failed" : rec.state === "timed_out" ? "timed out" : "could not start"} at ${rec.revision.slice(0, 12)}.`;
      req.evidenceId = evidenceId;
    }
    const claim = claims.find((c) => c.claimIndex === rec.claimIndex);
    if (claim && evidenceId) claim.evidenceIds = [...claim.evidenceIds, evidenceId];
  }
  void revision;
  return { ...assessment, evidence, claims, verification: requirements };
}
