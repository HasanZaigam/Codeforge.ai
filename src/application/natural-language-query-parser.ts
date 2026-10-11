import { z } from "zod";
import type { DatasetVocabulary, TaskDatasetVocabulary } from "./dataset-vocabulary.js";
import { normalizeValueForMatching } from "./dataset-vocabulary.js";
import {
  QueryPlanOutcomeSchema,
  StructuredQuerySchema,
  type QueryPlanOutcome,
  type StructuredQuery,
  type ClarificationCandidate,
} from "./query-schema.js";
import { redactSecrets } from "../security/redact.js";

/**
 * Natural Language Query Parser — Phase 2
 *
 * Translates natural-language questions into the strict Phase 1 StructuredQuery
 * representation using project and active-import vocabularies.
 *
 * Core architectural tenets:
 * 1. Model-Agnostic: Communicates through LLMQueryModelClient interface; testable
 *    with deterministic mocks without live provider or network calls.
 * 2. Untrusted LLM Output: Strict Zod parsing, bounds validation, and AST checks.
 * 3. Never Invent Data: Verifies every field and categorical value against supplied vocabulary.
 *    If an ambiguous or unknown categorical value is referenced, requests clarification.
 * 4. Zero Mutation / Execution: Pure semantic translation. Does not run queries,
 *    mutate tasks, or alter database state.
 * 5. Bounded: Strict input limits, output limits, and timeouts.
 */

export const PARSER_LIMITS = {
  maxQuestionLength: 1_000,
  maxOutputChars: 15_000,
  defaultTimeoutMs: 30_000,
  maxHistoryItems: 5,
} as const;

/**
 * Prior result-set context supplied explicitly by the caller (e.g. for follow-ups like "List them").
 */
export interface PriorResultSetContext {
  previousQuestion?: string;
  source: "CODEFORGE_TASKS" | "IMPORTED_DATASET";
  operation: "COUNT" | "LIST" | "GET_DETAILS" | "GROUP_BY" | "DISTINCT_VALUES";
  filter?: StructuredQuery["filter"];
  totalCount?: number;
  matchedIdentifiers?: string[];
}

/**
 * Bounded vocabulary context provided to the parser.
 */
export interface ParserVocabularyContext {
  projectId: string;
  tasks?: TaskDatasetVocabulary;
  activeImport?: DatasetVocabulary;
  priorResult?: PriorResultSetContext;
}

/**
 * Minimal model completion request contract.
 */
export interface LLMQueryCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}

/**
 * Minimal model completion response contract.
 */
export interface LLMQueryCompletionResponse {
  rawText: string;
  modelId?: string;
}

/**
 * Pluggable, model-agnostic client adapter for the natural language parser.
 */
export interface LLMQueryModelClient {
  complete(request: LLMQueryCompletionRequest): Promise<LLMQueryCompletionResponse>;
}

/**
 * Diagnostic record preserved for audit and logging without leaking secrets.
 */
export interface ParserDiagnosticRecord {
  originalQuestion: string;
  sanitizedQuestion: string;
  outcome: QueryPlanOutcome["outcome"];
  durationMs: number;
  modelId?: string;
  error?: string;
}

/**
 * Parser result including outcome and diagnostics.
 */
export interface ParseNaturalLanguageQueryResult {
  outcome: QueryPlanOutcome;
  diagnostics: ParserDiagnosticRecord;
}

/**
 * Extracts a JSON object from text that may contain markdown code fences or conversational prose.
 */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  // Case 1: Plain balanced JSON object
  if (trimmed.startsWith("{") && trimmed.endsWith("}") && isBalancedJson(trimmed)) {
    return trimmed;
  }

  // Case 2: Markdown fence (```json ... ``` or ``` ... ```)
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch) {
    const inner = fenceMatch[1]!.trim();
    if (inner.startsWith("{") && isBalancedJson(inner)) {
      return inner;
    }
  }

  // Case 3: Embedded JSON between first { and last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    if (isBalancedJson(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isBalancedJson(s: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth < 0) return false;
      }
    }
  }
  return depth === 0 && !inString;
}

/**
 * Builds the comprehensive prompt ground truth from discovered vocabulary.
 */
export function buildParserPrompt(question: string, context: ParserVocabularyContext): { systemPrompt: string; userPrompt: string } {
  const sources: string[] = [];

  if (context.tasks) {
    const fieldSummaries = context.tasks.fields.map((f) => {
      const distinct = f.distinctValues.map((v) => `"${v.rawValue}" (count: ${v.count})`).join(", ");
      return `- ${f.name} (${f.type}${f.isCategorical ? ", categorical" : ""}): ${distinct || "unbounded values"}`;
    });
    sources.push(
      `DATA SOURCE: CODEFORGE_TASKS\n` +
      `Description: Tasks being implemented or tracked in CodeForge.\n` +
      `Total Tasks: ${context.tasks.totalTasks}\n` +
      `Available Fields:\n${fieldSummaries.join("\n")}`
    );
  }

  if (context.activeImport) {
    const fieldSummaries = context.activeImport.fields.map((f) => {
      const distinct = f.distinctValues.map((v) => `"${v.rawValue}" (count: ${v.count})`).join(", ");
      return `- ${f.name} (display: "${f.displayName}", ${f.type}${f.isCategorical ? ", categorical" : ""}): ${distinct || "unbounded values"}`;
    });
    sources.push(
      `DATA SOURCE: IMPORTED_DATASET\n` +
      `Source File: ${context.activeImport.sourceName} (Import ID: ${context.activeImport.importId})\n` +
      `Total Rows: ${context.activeImport.totalRows}\n` +
      `Available Fields:\n${fieldSummaries.join("\n")}`
    );
  }

  let priorText = "";
  if (context.priorResult) {
    priorText =
      `PRIOR CONTEXT (Follow-up Reference):\n` +
      `Previous Source: ${context.priorResult.source}\n` +
      `Previous Operation: ${context.priorResult.operation}\n` +
      (context.priorResult.previousQuestion ? `Previous Question: "${context.priorResult.previousQuestion}"\n` : "") +
      (context.priorResult.totalCount !== undefined ? `Previous Match Count: ${context.priorResult.totalCount}\n` : "") +
      (context.priorResult.filter ? `Previous Filter: ${JSON.stringify(context.priorResult.filter)}\n` : "");
  }

  const systemPrompt = `You are the CodeForge Natural Language Query Understanding Engine.
Your job is to translate user natural language questions into a strict structured query plan adhering to the CodeForge Query Plan Schema.

STRICT RULES:
1. ONLY return a single valid JSON object. No explanations before or after the JSON.
2. Valid outcomes are: "QUERY", "CLARIFICATION_REQUIRED", "UNSUPPORTED", "NOT_A_DATA_QUERY".
3. For "QUERY", supported operations: "COUNT", "LIST", "GET_DETAILS", "GROUP_BY", "DISTINCT_VALUES".
   Supported sources: "CODEFORGE_TASKS", "IMPORTED_DATASET".
   Supported filter operators: "EQUALS", "NOT_EQUALS", "IN", "NOT_IN", "CONTAINS", "STARTS_WITH", "GREATER_THAN", "LESS_THAN", "IS_EMPTY", "IS_NOT_EMPTY".
4. NEVER invent fields, column names, task statuses, or categorical values.
   Every field and categorical value MUST match the available vocabulary below.
   Preserve exact raw casing and Unicode of categorical values in filters.
5. If a user asks about an ambiguous categorical value (e.g., "done" when there are both "Done" and "DONE – Merged", or multiple similar values), return outcome "CLARIFICATION_REQUIRED" with candidates.
6. If a user asks a general question not related to querying tasks or imported data, return "NOT_A_DATA_QUERY".
7. If a user asks for unsupported capabilities (mutations, SQL joins across multiple tables, arbitrary calculations), return "UNSUPPORTED".
8. If the user refers to prior results (e.g. "List them", "Show them", "Which ones?"):
   - If prior context is available with a previous filter, inherit that filter with operation "LIST".
   - If the user refers to an ordinal or relative item (e.g. "Show details for the third one", "Show the first item"):
     * If prior context provides specific matchedIdentifiers with enough items, set targetId to that specific identifier with operation "GET_DETAILS".
     * If specific item identifiers are NOT available in prior context, do NOT fabricate or guess an ID. Instead return "CLARIFICATION_REQUIRED" asking the user to specify the item ID or title.
9. Compound queries:
   - "Count bugs that are X or Y": Represent as a single COUNT query with an "IN" operator (or an "or" boolean filter).
   - "Show bugs that are X but not Y": Represent as a LIST query with boolean logic: and: [ { field, operator: "EQUALS", value: X }, { field, operator: "NOT_EQUALS", value: Y } ].
   - "How many are X and how many are Y?": When asking for separate breakdown counts across values of the same categorical field, use operation "GROUP_BY" with groupByField set to that field and an "IN" filter matching [X, Y].
   - Mixed multi-operation requests across different operations or data sources (e.g. "How many are Done, and list the Review bugs?"): The current single-query schema CANNOT execute two distinct operations simultaneously without dropping one. You MUST return outcome "UNSUPPORTED" with reason stating that executing multiple distinct operations in a single query is not supported. NEVER silently drop one of the operations!
10. Respect query complexity limits: max filter depth 4, max total leaf filters 10.

Output JSON schemas:
- For QUERY:
  {
    "outcome": "QUERY",
    "query": {
      "source": "CODEFORGE_TASKS" | "IMPORTED_DATASET",
      "operation": "COUNT" | "LIST" | "GET_DETAILS" | "GROUP_BY" | "DISTINCT_VALUES",
      "filter": <filter clause>,
      "targetId": string (optional),
      "groupByField": string (optional),
      "distinctField": string (optional),
      "limit": number (optional),
      "orderBy": { "field": string, "direction": "ASC" | "DESC" } (optional)
    },
    "explanation": string (optional)
  }
- For CLARIFICATION_REQUIRED:
  {
    "outcome": "CLARIFICATION_REQUIRED",
    "message": string,
    "field": string (optional),
    "candidates": [ { "label": string, "value": string, "count": number (optional) } ]
  }
- For UNSUPPORTED:
  {
    "outcome": "UNSUPPORTED",
    "reason": string,
    "missingCapability": string (optional)
  }
- For NOT_A_DATA_QUERY:
  {
    "outcome": "NOT_A_DATA_QUERY",
    "reason": string (optional)
  }`;

  const userPrompt = `${sources.join("\n\n")}\n\n${priorText ? priorText + "\n" : ""}User Question: "${question}"`;

  return { systemPrompt, userPrompt };
}

/**
 * Validates that fields and categorical values in a parsed query exist in the context vocabulary.
 * Returns null if valid, or a CLARIFICATION_REQUIRED outcome if an ungrounded or ambiguous value is detected.
 */
export function groundQueryAgainstVocabulary(
  query: StructuredQuery,
  context: ParserVocabularyContext,
): QueryPlanOutcome | null {
  const vocab = query.source === "CODEFORGE_TASKS" ? context.tasks : context.activeImport;
  if (!vocab) {
    return {
      outcome: "UNSUPPORTED",
      reason: `Data source ${query.source} is not available in the current context`,
    };
  }

  const fieldsByName = new Map<string, (typeof vocab.fields)[number]>();
  for (const f of vocab.fields) {
    fieldsByName.set(f.name.toLowerCase(), f);
    fieldsByName.set(f.displayName.toLowerCase(), f);
  }

  // Check target field for GROUP_BY or DISTINCT_VALUES
  if (query.groupByField) {
    const f = fieldsByName.get(query.groupByField.toLowerCase());
    if (!f) {
      return {
        outcome: "CLARIFICATION_REQUIRED",
        message: `Field "${query.groupByField}" was not found in ${query.source}. Available fields: ${vocab.fields.map((x) => x.name).join(", ")}`,
        field: query.groupByField,
      };
    }
  }

  if (query.distinctField) {
    const f = fieldsByName.get(query.distinctField.toLowerCase());
    if (!f) {
      return {
        outcome: "CLARIFICATION_REQUIRED",
        message: `Field "${query.distinctField}" was not found in ${query.source}. Available fields: ${vocab.fields.map((x) => x.name).join(", ")}`,
        field: query.distinctField,
      };
    }
  }

  // Recursively inspect filter clauses
  function checkFilter(filter: StructuredQuery["filter"]): QueryPlanOutcome | null {
    if (!filter) return null;

    if ("field" in filter) {
      const fieldDef = fieldsByName.get(filter.field.toLowerCase());
      if (!fieldDef) {
        return {
          outcome: "CLARIFICATION_REQUIRED",
          message: `Field "${filter.field}" was not recognized in ${query.source}.`,
          field: filter.field,
          candidates: vocab?.fields.slice(0, 10).map((f) => ({ label: f.displayName, value: f.name })),
        };
      }

      // If the field is categorical and has known distinct values, ground scalar and array values
      if (fieldDef.isCategorical && fieldDef.distinctValues.length > 0) {
        const valuesToCheck: string[] = [];
        if (typeof filter.value === "string") {
          valuesToCheck.push(filter.value);
        } else if (Array.isArray(filter.value)) {
          for (const v of filter.value) {
            if (typeof v === "string") valuesToCheck.push(v);
          }
        }

        for (let i = 0; i < valuesToCheck.length; i++) {
          const val = valuesToCheck[i]!;
          const normVal = normalizeValueForMatching(val);

          // Check if there are exact or unique normalized matches in known distinct values
          // 1. Exact raw match
          const exactRawMatches = fieldDef.distinctValues.filter((dv) => dv.rawValue === val);
          // 2. Exact normalized matches
          const exactNormMatches = fieldDef.distinctValues.filter((dv) => dv.normalizedValue === normVal);

          if (exactRawMatches.length === 1) {
            // Exactly grounded to 1 raw value
            const matched = exactRawMatches[0]!;
            if (typeof filter.value === "string") {
              filter.value = matched.rawValue;
            } else if (Array.isArray(filter.value)) {
              filter.value[i] = matched.rawValue;
            }
            continue;
          }

          if (exactNormMatches.length === 1) {
            // Unique legitimate normalized match -> ground filter to authoritative rawValue
            const matched = exactNormMatches[0]!;
            if (typeof filter.value === "string") {
              filter.value = matched.rawValue;
            } else if (Array.isArray(filter.value)) {
              filter.value[i] = matched.rawValue;
            }
            continue;
          }

          if (exactNormMatches.length > 1) {
            // Multiple possible matches share this normalized key (e.g. differs only in Unicode dashes or case)
            const candidates: ClarificationCandidate[] = exactNormMatches.map((m) => ({
              label: m.rawValue,
              value: m.rawValue,
              count: m.count,
            }));
            return {
              outcome: "CLARIFICATION_REQUIRED",
              message: `Multiple matches found for "${val}" in field "${fieldDef.name}". Please specify which one you mean:`,
              field: fieldDef.name,
              candidates,
            };
          }

          // No exact normalized match found among the known distinct values
          // Check for substring / fuzzy partial matches
          const partialMatches = fieldDef.distinctValues.filter((dv) => {
            return (
              dv.normalizedValue.includes(normVal) ||
              normVal.includes(dv.normalizedValue)
            );
          });

          if (partialMatches.length > 0) {
            const candidates: ClarificationCandidate[] = partialMatches.slice(0, 5).map((m) => ({
              label: m.rawValue,
              value: m.rawValue,
              count: m.count,
            }));
            return {
              outcome: "CLARIFICATION_REQUIRED",
              message: `Value "${val}" was not found for field "${fieldDef.name}". Did you mean one of these?`,
              field: fieldDef.name,
              candidates,
            };
          }

          // If the field has truncated distinct values (>50 distinct values in dataset),
          // do NOT claim the value definitely does not exist in the whole dataset.
          if (fieldDef.hasMoreDistinctValues) {
            return {
              outcome: "CLARIFICATION_REQUIRED",
              message: `Value "${val}" was not found among the top ${fieldDef.distinctValues.length} distinct values for "${fieldDef.name}". Because this field has more than ${fieldDef.distinctValues.length} distinct values, please confirm the exact value or choose from top values.`,
              field: fieldDef.name,
              candidates: fieldDef.distinctValues.slice(0, 5).map((m) => ({
                label: m.rawValue,
                value: m.rawValue,
                count: m.count,
              })),
            };
          }

          // Fully known vocabulary and no match
          return {
            outcome: "CLARIFICATION_REQUIRED",
            message: `Value "${val}" is not a recognized value for field "${fieldDef.name}".`,
            field: fieldDef.name,
            candidates: fieldDef.distinctValues.slice(0, 5).map((m) => ({
              label: m.rawValue,
              value: m.rawValue,
              count: m.count,
            })),
          };
        }
      }
      return null;
    }

    if ("and" in filter) {
      for (const child of filter.and) {
        const issue = checkFilter(child);
        if (issue) return issue;
      }
    }

    if ("or" in filter) {
      for (const child of filter.or) {
        const issue = checkFilter(child);
        if (issue) return issue;
      }
    }

    if ("not" in filter) {
      return checkFilter(filter.not);
    }

    return null;
  }

  return checkFilter(query.filter);
}

/**
 * Natural Language Query Parser.
 */
export class NaturalLanguageQueryParser {
  constructor(
    private readonly modelClient: LLMQueryModelClient,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Translates a user natural language question into a validated QueryPlanOutcome.
   */
  async parseQuestion(
    question: string,
    context: ParserVocabularyContext,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ParseNaturalLanguageQueryResult> {
    const startTime = Date.now();
    const trimmed = (question ?? "").trim();
    const sanitizedQuestion = redactSecrets(trimmed, this.env).slice(0, PARSER_LIMITS.maxQuestionLength);

    // 1. Guard against empty questions
    if (!trimmed) {
      const outcome: QueryPlanOutcome = {
        outcome: "NOT_A_DATA_QUERY",
        reason: "Question was empty",
      };
      return {
        outcome,
        diagnostics: {
          originalQuestion: question,
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
        },
      };
    }

    // 2. Guard against oversized input questions
    if (trimmed.length > PARSER_LIMITS.maxQuestionLength) {
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: `Question length (${trimmed.length}) exceeds maximum limit (${PARSER_LIMITS.maxQuestionLength} characters)`,
      };
      return {
        outcome,
        diagnostics: {
          originalQuestion: trimmed.slice(0, 100) + "…",
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
        },
      };
    }

    // 3. Build model prompts with bounded vocabulary
    const { systemPrompt, userPrompt } = buildParserPrompt(trimmed, context);

    // 4. Set up abort signal and timeout
    const timeoutMs = options.timeoutMs ?? PARSER_LIMITS.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const effectiveSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let completionResponse: LLMQueryCompletionResponse;
    try {
      completionResponse = await this.modelClient.complete({
        systemPrompt,
        userPrompt,
        signal: effectiveSignal,
      });
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        effectiveSignal.aborted ||
        rawMsg.toLowerCase().includes("timeout") ||
        rawMsg.toLowerCase().includes("aborted");

      const sanitizedError = redactSecrets(rawMsg, this.env).slice(0, 300);
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: isTimeout
          ? `Query understanding timed out after ${timeoutMs}ms`
          : `Model provider error during query parsing: ${sanitizedError}`,
      };

      return {
        outcome,
        diagnostics: {
          originalQuestion: trimmed,
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
          error: sanitizedError,
        },
      };
    }

    const rawOutput = completionResponse.rawText ?? "";
    if (rawOutput.length > PARSER_LIMITS.maxOutputChars) {
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: `Model output length (${rawOutput.length}) exceeded maximum limit (${PARSER_LIMITS.maxOutputChars} characters)`,
      };
      return {
        outcome,
        diagnostics: {
          originalQuestion: trimmed,
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
          modelId: completionResponse.modelId,
          error: "Output too large",
        },
      };
    }

    // 5. Extract JSON
    const jsonStr = extractJsonObject(rawOutput);
    if (!jsonStr) {
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: "Model output did not contain a valid JSON query plan",
      };
      return {
        outcome,
        diagnostics: {
          originalQuestion: trimmed,
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
          modelId: completionResponse.modelId,
          error: "Malformed non-JSON output",
        },
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonStr);
    } catch (err) {
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: `Model output contained invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
      return {
        outcome,
        diagnostics: {
          originalQuestion: trimmed,
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
          modelId: completionResponse.modelId,
          error: "Invalid JSON syntax",
        },
      };
    }

    // 6. Validate with Phase 1 QueryPlanOutcomeSchema (Zod strict validation)
    const schemaValidation = QueryPlanOutcomeSchema.safeParse(parsedJson);
    if (!schemaValidation.success) {
      const issueSummary = schemaValidation.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ");
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: `Model output failed schema validation: ${issueSummary}`,
      };
      return {
        outcome,
        diagnostics: {
          originalQuestion: trimmed,
          sanitizedQuestion,
          outcome: outcome.outcome,
          durationMs: Date.now() - startTime,
          modelId: completionResponse.modelId,
          error: issueSummary,
        },
      };
    }

    const validatedOutcome = schemaValidation.data;

    // 7. Ground against vocabulary if outcome is QUERY
    if (validatedOutcome.outcome === "QUERY") {
      const groundingIssue = groundQueryAgainstVocabulary(validatedOutcome.query, context);
      if (groundingIssue) {
        return {
          outcome: groundingIssue,
          diagnostics: {
            originalQuestion: trimmed,
            sanitizedQuestion,
            outcome: groundingIssue.outcome,
            durationMs: Date.now() - startTime,
            modelId: completionResponse.modelId,
          },
        };
      }
    }

    return {
      outcome: validatedOutcome,
      diagnostics: {
        originalQuestion: trimmed,
        sanitizedQuestion,
        outcome: validatedOutcome.outcome,
        durationMs: Date.now() - startTime,
        modelId: completionResponse.modelId,
      },
    };
  }
}
