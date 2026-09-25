import { z } from "zod";
import type { AnalysisResult, TaskProposalContent } from "./backlog-types.js";

/**
 * The strict contract a model's analysis must satisfy (see /docs/BACKLOG_INTELLIGENCE.md "AI
 * analysis contract"). `.strict()` on every object is deliberate, not pedantry: an output with an
 * unexpected key — including one that tries to smuggle in `status`, `approved`, `converted`,
 * `taskId`, `retryLimit`, … — is MALFORMED and is rejected whole, never partially accepted with the
 * extra key quietly ignored. AI output is a proposal; nothing in it can express platform state.
 *
 * Confidence is a qualitative level, never a fabricated numeric score (same reasoning as
 * routing's `CapabilityLevel`).
 */

const Confidence = z.enum(["high", "medium", "low"]);
const Text = (max: number) => z.string().trim().min(1).max(max);

const RelationshipCandidate = z
  .object({
    ref: Text(200),
    confidence: Confidence,
    rationale: Text(500),
  })
  .strict();

const SearchTerm = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9_.-]+$/, "search terms are single identifiers/words (letters, digits, . _ -)");

/**
 * A checkable statement about the repository (see backlog-types.ts AnalysisClaim). There is deliberately
 * NO field here for evidence, verification, or a verdict: the model can only ASSERT; whether an assertion
 * is supported is decided later by the platform from evidence it obtains itself (evidence.ts). An output
 * that tries to add such a field (`verified`, `evidence`, `status`, …) is malformed like any other extra key.
 */
const ClaimSchema = z
  .object({
    statement: Text(400),
    kind: z.enum(["FILE_EXISTS", "FILE_ABSENT", "FEATURE_ABSENT", "FEATURE_PRESENT", "BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"]),
    path: Text(400).nullable(),
    searchTerms: z.array(SearchTerm).max(5),
    confidence: Confidence,
  })
  .strict()
  .refine((c) => !(c.kind === "FILE_EXISTS" || c.kind === "FILE_ABSENT") || c.path !== null, {
    message: "a FILE_EXISTS / FILE_ABSENT claim must name the file in `path`",
    path: ["path"],
  });

export const AnalysisResultSchema = z
  .object({
    summary: Text(1500),
    issueType: z.enum(["bug", "feature", "improvement", "chore", "question", "unknown"]),
    affectedApplication: Text(200).nullable(),
    suspectedArea: Text(500).nullable(),
    candidateFiles: z.array(z.object({ path: Text(400), reason: Text(400) }).strict()).max(20),
    duplicateCandidates: z.array(RelationshipCandidate).max(10),
    dependencyCandidates: z.array(RelationshipCandidate).max(10),
    missingInformation: z.array(z.object({ question: Text(500), blocking: z.boolean() }).strict()).max(10),
    suggestedAcceptanceCriteria: z.array(Text(400)).max(15),
    suggestedValidation: z.array(Text(400)).max(10),
    confidence: z.object({ overall: Confidence, uncertainties: z.array(Text(400)).max(10) }).strict(),
    // Optional in the model's output so analyses recorded before Phase 4A.2 (which have none) still validate.
    claims: z.array(ClaimSchema).max(10).default([]),
  })
  .strict();

// Compile-time guarantee the runtime schema and the domain type cannot drift apart.
type _AnalysisSchemaMatchesType = z.infer<typeof AnalysisResultSchema> extends AnalysisResult ? (AnalysisResult extends z.infer<typeof AnalysisResultSchema> ? true : never) : never;
const _analysisSchemaMatchesType: _AnalysisSchemaMatchesType = true;
void _analysisSchemaMatchesType;

const ProposalRelationship = z
  .object({
    backlogItemId: Text(200),
    ref: Text(200).nullable(),
    title: Text(400),
    confidence: Confidence,
    rationale: Text(500),
  })
  .strict();

const ProposalClaimAssessment = z
  .object({
    statement: Text(400),
    kind: z.enum(["FILE_EXISTS", "FILE_ABSENT", "FEATURE_ABSENT", "FEATURE_PRESENT", "BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"]),
    aiConfidence: Confidence,
    status: z.enum(["SUPPORTED", "CONTRADICTED", "UNRESOLVED", "NOT_CHECKED"]),
    establishes: z.enum(["existence", "nothing"]).default("nothing"),
    reason: Text(600),
    /** Bounded, human-readable evidence lines ("FILE_EXISTS backend/…/otpThrottle.ts"). */
    evidence: z.array(Text(300)).max(6),
  })
  .strict();

/** Re-validated immediately before conversion — a corrupted or hand-edited stored proposal can never become a Task. */
export const TaskProposalContentSchema = z
  .object({
    title: Text(300),
    goal: Text(10_000),
    summary: Text(1500),
    issueType: z.enum(["bug", "feature", "improvement", "chore", "question", "unknown"]),
    affectedApplication: Text(200).nullable(),
    suspectedArea: Text(500).nullable(),
    candidateFiles: z.array(z.object({ path: Text(400), reason: Text(400), existsInRepository: z.boolean().nullable() }).strict()).max(20),
    acceptanceCriteria: z.array(Text(400)).max(15),
    validation: z.array(Text(400)).max(10),
    dependencies: z.array(ProposalRelationship).max(10),
    duplicateWarnings: z.array(ProposalRelationship).max(10),
    uncertainty: z
      .object({
        overall: Confidence,
        uncertainties: z.array(Text(400)).max(10),
        missingInformation: z.array(z.object({ question: Text(500), blocking: z.boolean() }).strict()).max(10),
      })
      .strict(),
    // Phase 4A.2 — what the platform's evidence says about each AI claim. Defaults keep proposals stored
    // before it existed valid.
    claimAssessments: z.array(ProposalClaimAssessment).max(10).default([]),
    /** True when platform evidence contradicts a claim the proposal would otherwise rest on: the task is to INVESTIGATE existing behavior, not to build something new. */
    investigateFirst: z.boolean().default(false),
    /** Phase 4A.4 — see backlog-types.ts TaskProposalContent.implementationConflict. */
    implementationConflict: z.enum(["strong", "possible", "none"]).default("none"),
  })
  .strict();

type _ProposalSchemaMatchesType = z.infer<typeof TaskProposalContentSchema> extends TaskProposalContent ? (TaskProposalContent extends z.infer<typeof TaskProposalContentSchema> ? true : never) : never;
const _proposalSchemaMatchesType: _ProposalSchemaMatchesType = true;
void _proposalSchemaMatchesType;

// ---------------------------------------------------------------------------
// Extracting + validating a model's raw text
// ---------------------------------------------------------------------------

/** A model's output is untrusted and unbounded — cap what is even considered for parsing. */
export const MAX_ANALYSIS_OUTPUT_CHARS = 200_000;

export type ParseAnalysisOutcome =
  | { ok: true; value: AnalysisResult }
  | { ok: false; reason: string; /** Which stage rejected it — useful diagnostics without echoing the whole output. */ stage: "empty" | "too_large" | "no_json" | "invalid_json" | "schema"; issues?: string[] };

/**
 * Turns the coding engine's final text into a validated `AnalysisResult`, or a precise reason it
 * could not. Accepts a bare JSON object, a fenced ```json block, or a JSON object embedded in
 * surrounding prose (models routinely add a sentence around it) — but only ever a SINGLE object that
 * then passes the strict schema. Never repairs, guesses at, or "fills in" a field.
 */
export function parseAnalysisOutput(raw: string): ParseAnalysisOutcome {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, stage: "empty", reason: "The model returned no output." };
  if (text.length > MAX_ANALYSIS_OUTPUT_CHARS) {
    return { ok: false, stage: "too_large", reason: `The model's output exceeded ${MAX_ANALYSIS_OUTPUT_CHARS} characters.` };
  }

  const candidate = extractJsonObject(text);
  if (candidate === null) return { ok: false, stage: "no_json", reason: "The model's output did not contain a JSON object." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, stage: "invalid_json", reason: `The model's JSON could not be parsed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const result = AnalysisResultSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, stage: "schema", reason: "The model's JSON did not match the required analysis schema.", issues };
  }
  return { ok: true, value: result.data };
}

function extractJsonObject(text: string): string | null {
  // 1. The whole text is already an object.
  if (text.startsWith("{") && text.endsWith("}") && isBalanced(text)) return text;

  // 2. A fenced block (```json ... ``` or ``` ... ```).
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fence) {
    const inner = fence[1]!.trim();
    if (inner.startsWith("{") && isBalanced(inner)) return inner;
  }

  // 3. The first balanced top-level object embedded in prose.
  const start = text.indexOf("{");
  if (start === -1) return null;
  const end = findMatchingBrace(text, start);
  return end === -1 ? null : text.slice(start, end + 1);
}

function isBalanced(text: string): boolean {
  return findMatchingBrace(text, 0) === text.length - 1;
}

/** Index of the `}` matching the `{` at `start`, honoring JSON string literals and escapes; -1 if none. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
