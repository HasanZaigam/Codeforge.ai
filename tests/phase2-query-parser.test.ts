import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NaturalLanguageQueryParser,
  buildParserPrompt,
  groundQueryAgainstVocabulary,
  type LLMQueryModelClient,
  type LLMQueryCompletionRequest,
  type LLMQueryCompletionResponse,
  type ParserVocabularyContext,
} from "../src/application/natural-language-query-parser.js";
import type { DatasetVocabulary, TaskDatasetVocabulary } from "../src/application/dataset-vocabulary.js";
import type { StructuredQuery } from "../src/application/query-schema.js";

/**
 * Mock Model Client for deterministic, model-agnostic parser testing.
 */
class MockLLMQueryModelClient implements LLMQueryModelClient {
  constructor(
    private readonly responder: (req: LLMQueryCompletionRequest) => Promise<string> | string,
    public readonly modelId: string = "mock-model-v1",
  ) {}

  async complete(request: LLMQueryCompletionRequest): Promise<LLMQueryCompletionResponse> {
    if (request.signal?.aborted) {
      throw new Error("Request aborted");
    }
    const text = await this.responder(request);
    return {
      rawText: text,
      modelId: this.modelId,
    };
  }
}

describe("Phase 2: Natural Language Query Parsing", () => {
  // Shared test fixture vocabulary
  const mockTasks: TaskDatasetVocabulary = {
    source: "CODEFORGE_TASKS",
    projectId: "proj-1",
    totalTasks: 42,
    fields: [
      {
        name: "status",
        displayName: "Task Status",
        type: "categorical",
        isCategorical: true,
        nonEmptyCount: 42,
        emptyCount: 0,
        distinctValues: [
          { rawValue: "TODO", normalizedValue: "todo", count: 10 },
          { rawValue: "IN_PROGRESS", normalizedValue: "in_progress", count: 8 },
          { rawValue: "REVIEW", normalizedValue: "review", count: 12 },
          { rawValue: "DONE", normalizedValue: "done", count: 10 },
          { rawValue: "FAILED", normalizedValue: "failed", count: 2 },
        ],
        hasMoreDistinctValues: false,
        totalDistinctCount: 5,
      },
      {
        name: "title",
        displayName: "Title",
        type: "string",
        isCategorical: false,
        nonEmptyCount: 42,
        emptyCount: 0,
        distinctValues: [],
        hasMoreDistinctValues: false,
        totalDistinctCount: 0,
      },
      {
        name: "createdAt",
        displayName: "Created At",
        type: "date",
        isCategorical: false,
        nonEmptyCount: 42,
        emptyCount: 0,
        distinctValues: [],
        hasMoreDistinctValues: false,
        totalDistinctCount: 0,
      },
    ],
  };

  const mockActiveImport: DatasetVocabulary = {
    source: "IMPORTED_DATASET",
    projectId: "proj-1",
    importId: "imp-999",
    sourceName: "qa_bugs.csv",
    contentHash: "hash-999",
    totalRows: 150,
    canonicalFields: {
      statusField: "status",
      priorityField: "priority",
      moduleField: "module",
    },
    fields: [
      {
        name: "status",
        displayName: "Dev Status",
        type: "categorical",
        isCategorical: true,
        nonEmptyCount: 150,
        emptyCount: 0,
        distinctValues: [
          { rawValue: "Add-on – not built", normalizedValue: "add-on - not built", count: 25 },
          { rawValue: "DONE – Merged", normalizedValue: "done - merged", count: 80 },
          { rawValue: "In Progress", normalizedValue: "in progress", count: 35 },
          { rawValue: "Won't Fix", normalizedValue: "won't fix", count: 10 },
        ],
        hasMoreDistinctValues: false,
        totalDistinctCount: 4,
      },
      {
        name: "priority",
        displayName: "Priority",
        type: "categorical",
        isCategorical: true,
        nonEmptyCount: 150,
        emptyCount: 0,
        distinctValues: [
          { rawValue: "Critical", normalizedValue: "critical", count: 15 },
          { rawValue: "High", normalizedValue: "high", count: 45 },
          { rawValue: "Medium", normalizedValue: "medium", count: 70 },
          { rawValue: "Low", normalizedValue: "low", count: 20 },
        ],
        hasMoreDistinctValues: false,
        totalDistinctCount: 4,
      },
      {
        name: "module",
        displayName: "Component",
        type: "string",
        isCategorical: false,
        nonEmptyCount: 150,
        emptyCount: 0,
        distinctValues: [],
        hasMoreDistinctValues: false,
        totalDistinctCount: 0,
      },
    ],
  };

  const standardContext: ParserVocabularyContext = {
    projectId: "proj-1",
    tasks: mockTasks,
    activeImport: mockActiveImport,
  };

  // 1. Exact field and distinct-value grounding
  test("exact field and distinct-value grounding with raw Unicode", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "Add-on – not built",
          },
        },
        explanation: "Count bugs with status Add-on – not built",
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("How many bugs have dev-status Add-on – not built?", standardContext);

    assert.equal(res.outcome.outcome, "QUERY");
    if (res.outcome.outcome === "QUERY") {
      assert.equal(res.outcome.query.source, "IMPORTED_DATASET");
      assert.equal(res.outcome.query.operation, "COUNT");
      assert.deepEqual(res.outcome.query.filter, {
        field: "status",
        operator: "EQUALS",
        value: "Add-on – not built",
      });
    }
    assert.equal(res.diagnostics.outcome, "QUERY");
    assert.ok(res.diagnostics.durationMs >= 0);
  });

  // 2. Alternate phrasing with equivalent structured intent
  test("alternate natural-language phrasing for tasks LIST query", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "CODEFORGE_TASKS",
          operation: "LIST",
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "FAILED",
          },
        },
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    // User asking "Show me failed tasks" or "which tasks broke"
    const res = await parser.parseQuestion("Show me failed tasks", standardContext);

    assert.equal(res.outcome.outcome, "QUERY");
    if (res.outcome.outcome === "QUERY") {
      assert.equal(res.outcome.query.source, "CODEFORGE_TASKS");
      assert.equal(res.outcome.query.operation, "LIST");
      assert.deepEqual(res.outcome.query.filter, {
        field: "status",
        operator: "EQUALS",
        value: "FAILED",
      });
    }
  });

  // 3. Ambiguous status/value -> clarification
  test("ambiguous value returns CLARIFICATION_REQUIRED with candidates", async () => {
    // Model returns a value "Done" that doesn't exactly match any single distinct value in IMPORTED_DATASET
    // but fuzzy matches "DONE – Merged"
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "Done", // ambiguous in IMPORTED_DATASET where actual value is "DONE – Merged"
          },
        },
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("How many bugs are done?", standardContext);

    assert.equal(res.outcome.outcome, "CLARIFICATION_REQUIRED");
    if (res.outcome.outcome === "CLARIFICATION_REQUIRED") {
      assert.equal(res.outcome.field, "status");
      assert.ok(res.outcome.candidates && res.outcome.candidates.length > 0);
      assert.equal(res.outcome.candidates[0]?.value, "DONE – Merged");
    }
  });

  // 4. Unknown field/value -> no invented query
  test("unknown invented field triggers clarification without executing an invented query", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "invented_column_xyz",
            operator: "EQUALS",
            value: "something",
          },
        },
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("Count by invented_column_xyz", standardContext);

    assert.equal(res.outcome.outcome, "CLARIFICATION_REQUIRED");
    if (res.outcome.outcome === "CLARIFICATION_REQUIRED") {
      assert.equal(res.outcome.field, "invented_column_xyz");
      assert.match(res.outcome.message, /not recognized/i);
    }
  });

  // 5. Multiple requested counts without silently losing a clause
  test("multiple requested counts maps to GROUP_BY preserving both requests", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "CODEFORGE_TASKS",
          operation: "GROUP_BY",
          groupByField: "status",
          filter: {
            field: "status",
            operator: "IN",
            value: ["DONE", "REVIEW"],
          },
        },
        explanation: "Group by status for Done and Review tasks to show both counts",
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("How many are Done and how many are in Review?", standardContext);

    assert.equal(res.outcome.outcome, "QUERY");
    if (res.outcome.outcome === "QUERY") {
      assert.equal(res.outcome.query.source, "CODEFORGE_TASKS");
      assert.equal(res.outcome.query.operation, "GROUP_BY");
      assert.equal(res.outcome.query.groupByField, "status");
      assert.deepEqual(res.outcome.query.filter, {
        field: "status",
        operator: "IN",
        value: ["DONE", "REVIEW"],
      });
    }
  });

  // 6. Malformed model output and extra keys
  test("malformed model output with extra/illegal keys is rejected by strict schema", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "Add-on – not built",
          },
          arbitrarySqlPayload: "SELECT * FROM users", // strict violation
        },
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("Count add-on bugs", standardContext);

    assert.equal(res.outcome.outcome, "UNSUPPORTED");
    if (res.outcome.outcome === "UNSUPPORTED") {
      assert.match(res.outcome.reason, /schema validation/i);
    }
  });

  test("non-JSON model output returns UNSUPPORTED", async () => {
    const client = new MockLLMQueryModelClient(() => "I am an AI and I cannot query this data for you.");

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("Count add-on bugs", standardContext);

    assert.equal(res.outcome.outcome, "UNSUPPORTED");
    if (res.outcome.outcome === "UNSUPPORTED") {
      assert.match(res.outcome.reason, /JSON/i);
    }
  });

  // 7. Provider error and timeout
  test("provider error surfaces UNSUPPORTED without throwing or leaking raw secrets", async () => {
    const client = new MockLLMQueryModelClient(() => {
      throw new Error("HTTP 429 Rate limit exceeded with key sk-secret12345678");
    });

    const envWithSecret = { ...process.env, TEST_API_KEY: "sk-secret12345678" };
    const parser = new NaturalLanguageQueryParser(client, envWithSecret);
    const res = await parser.parseQuestion("Show bugs", standardContext);

    assert.equal(res.outcome.outcome, "UNSUPPORTED");
    if (res.outcome.outcome === "UNSUPPORTED") {
      assert.match(res.outcome.reason, /Model provider error/i);
      // Ensure secret is redacted
      assert.ok(!res.outcome.reason.includes("sk-secret12345678"));
    }
  });

  test("provider timeout surfaces cleanly as UNSUPPORTED", async () => {
    const client = new MockLLMQueryModelClient(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Request timed out")), 50);
        }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("Show bugs", standardContext, { timeoutMs: 10 });

    assert.equal(res.outcome.outcome, "UNSUPPORTED");
    if (res.outcome.outcome === "UNSUPPORTED") {
      assert.match(res.outcome.reason, /timed out/i);
    }
  });

  // 8. Depth / filter-count limits enforced through the main schema
  test("model output exceeding filter depth limit is rejected via main schema", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            and: [
              {
                and: [
                  {
                    and: [
                      {
                        and: [
                          {
                            field: "status",
                            operator: "EQUALS",
                            value: "Add-on – not built",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("Count deeply nested", standardContext);

    assert.equal(res.outcome.outcome, "UNSUPPORTED");
    if (res.outcome.outcome === "UNSUPPORTED") {
      assert.match(res.outcome.reason, /Filter nesting depth/i);
    }
  });

  // 9. Prior result-set context used only when provided
  test("follow-up 'List them' reuses prior result-set filter and source", async () => {
    let capturedRequest: LLMQueryCompletionRequest | null = null;
    const client = new MockLLMQueryModelClient((req) => {
      capturedRequest = req;
      return JSON.stringify({
        outcome: "QUERY",
        query: {
          source: "IMPORTED_DATASET",
          operation: "LIST",
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "Add-on – not built",
          },
        },
        explanation: "Listing the items from the previous count query",
      });
    });

    const contextWithPrior: ParserVocabularyContext = {
      ...standardContext,
      priorResult: {
        previousQuestion: "How many bugs have dev-status Add-on – not built?",
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        totalCount: 25,
        filter: {
          field: "status",
          operator: "EQUALS",
          value: "Add-on – not built",
        },
      },
    };

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("List them", contextWithPrior);

    assert.equal(res.outcome.outcome, "QUERY");
    if (res.outcome.outcome === "QUERY") {
      assert.equal(res.outcome.query.source, "IMPORTED_DATASET");
      assert.equal(res.outcome.query.operation, "LIST");
      assert.deepEqual(res.outcome.query.filter, {
        field: "status",
        operator: "EQUALS",
        value: "Add-on – not built",
      });
    }

    // Verify prior context was included in the user prompt
    assert.ok(capturedRequest);
    assert.match((capturedRequest as LLMQueryCompletionRequest).userPrompt, /PRIOR CONTEXT/);
    assert.match((capturedRequest as LLMQueryCompletionRequest).userPrompt, /Add-on – not built/);
  });

  test("prior context is NOT included when omitted", async () => {
    let capturedRequest: LLMQueryCompletionRequest | null = null;
    const client = new MockLLMQueryModelClient((req) => {
      capturedRequest = req;
      return JSON.stringify({
        outcome: "NOT_A_DATA_QUERY",
        reason: "General conversation",
      });
    });

    const parser = new NaturalLanguageQueryParser(client);
    await parser.parseQuestion("Hello there", standardContext); // standardContext has no priorResult

    assert.ok(capturedRequest);
    const req = capturedRequest as LLMQueryCompletionRequest;
    assert.ok(!req.userPrompt.includes("PRIOR CONTEXT"));
  });

  // 10. NOT_A_DATA_QUERY outcome
  test("non-data general question returns NOT_A_DATA_QUERY", async () => {
    const client = new MockLLMQueryModelClient(() =>
      JSON.stringify({
        outcome: "NOT_A_DATA_QUERY",
        reason: "User is asking general programming advice",
      }),
    );

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("How do I write a binary search in TypeScript?", standardContext);

    assert.equal(res.outcome.outcome, "NOT_A_DATA_QUERY");
  });

  // 11. Bounded inputs: empty or oversized
  test("empty or whitespace question returns NOT_A_DATA_QUERY without model call", async () => {
    let called = false;
    const client = new MockLLMQueryModelClient(() => {
      called = true;
      return "{}";
    });

    const parser = new NaturalLanguageQueryParser(client);
    const res = await parser.parseQuestion("   ", standardContext);

    assert.equal(called, false);
    assert.equal(res.outcome.outcome, "NOT_A_DATA_QUERY");
  });

  test("oversized question returns UNSUPPORTED without model call", async () => {
    let called = false;
    const client = new MockLLMQueryModelClient(() => {
      called = true;
      return "{}";
    });

    const parser = new NaturalLanguageQueryParser(client);
    const hugeQuestion = "a".repeat(1500);
    const res = await parser.parseQuestion(hugeQuestion, standardContext);

    assert.equal(called, false);
    assert.equal(res.outcome.outcome, "UNSUPPORTED");
  });

  // -------------------------------------------------------------------------
  // AUDIT 1: Compound Query Tests
  // -------------------------------------------------------------------------
  describe("Audit 1: Compound Query Correctness", () => {
    test("Count bugs that are Done or In Progress -> single COUNT with IN operator", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "status",
              operator: "IN",
              value: ["DONE – Merged", "In Progress"],
            },
          },
          explanation: "Count bugs that are either Done or In Progress",
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Count bugs that are Done or In Progress", standardContext);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        assert.equal(res.outcome.query.operation, "COUNT");
        assert.deepEqual(res.outcome.query.filter, {
          field: "status",
          operator: "IN",
          value: ["DONE – Merged", "In Progress"],
        });
      }
    });

    test("Show bugs that are Done but not Cancelled -> LIST with boolean AND/NOT_EQUALS", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "LIST",
            filter: {
              and: [
                { field: "status", operator: "EQUALS", value: "DONE – Merged" },
                { field: "status", operator: "NOT_EQUALS", value: "Won't Fix" },
              ],
            },
          },
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Show bugs that are Done but not Won't Fix", standardContext);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        assert.equal(res.outcome.query.operation, "LIST");
        assert.ok(res.outcome.query.filter && "and" in res.outcome.query.filter);
      }
    });

    test("Mixed multi-operation request ('How many are Done, and list the Review bugs?') -> UNSUPPORTED", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "UNSUPPORTED",
          reason: "Executing multiple distinct operations (COUNT and LIST) in a single query is not supported by the query engine.",
          missingCapability: "MULTI_OPERATION_QUERY",
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("How many are Done, and list the Review bugs?", standardContext);

      assert.equal(res.outcome.outcome, "UNSUPPORTED");
      if (res.outcome.outcome === "UNSUPPORTED") {
        assert.match(res.outcome.reason, /multiple distinct operations/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AUDIT 2: Value Grounding & Normalization Tests
  // -------------------------------------------------------------------------
  describe("Audit 2: Value Grounding and Normalization", () => {
    test("Unicode dash variation in filter is grounded to canonical raw Unicode value", async () => {
      // Model returned ASCII hyphen "Add-on - not built" instead of en-dash "Add-on – not built"
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "status",
              operator: "EQUALS",
              value: "Add-on - not built", // ASCII hyphen
            },
          },
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("How many bugs are Add-on - not built?", standardContext);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        // Must be canonicalized to exact raw Unicode stored in dataset
        assert.equal((res.outcome.query.filter as any).value, "Add-on – not built");
      }
    });

    test("Case and whitespace variation grounds to authoritative raw value", async () => {
      // Model returned "in   progress" with multiple spaces and lower case
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "status",
              operator: "EQUALS",
              value: "in   progress",
            },
          },
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Count in progress", standardContext);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        assert.equal((res.outcome.query.filter as any).value, "In Progress");
      }
    });

    test("Multiple possible matches sharing normalized key triggers CLARIFICATION_REQUIRED", async () => {
      // Context where two values normalize to the same key
      const contextWithCollidingValues: ParserVocabularyContext = {
        projectId: "proj-1",
        activeImport: {
          ...mockActiveImport,
          fields: [
            {
              name: "tag",
              displayName: "Tag",
              type: "categorical",
              isCategorical: true,
              nonEmptyCount: 20,
              emptyCount: 0,
              distinctValues: [
                { rawValue: "ALPHA-1", normalizedValue: "alpha-1", count: 10 },
                { rawValue: "Alpha–1", normalizedValue: "alpha-1", count: 10 }, // en-dash
              ],
              hasMoreDistinctValues: false,
              totalDistinctCount: 2,
            },
          ],
        },
      };

      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "tag",
              operator: "EQUALS",
              value: "alpha-1",
            },
          },
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Count tag alpha-1", contextWithCollidingValues);

      assert.equal(res.outcome.outcome, "CLARIFICATION_REQUIRED");
      if (res.outcome.outcome === "CLARIFICATION_REQUIRED") {
        assert.equal(res.outcome.field, "tag");
        assert.equal(res.outcome.candidates?.length, 2);
        assert.match(res.outcome.message, /Multiple matches found/i);
      }
    });

    test("Completely unknown value triggers CLARIFICATION_REQUIRED with candidates", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "priority",
              operator: "EQUALS",
              value: "SuperUrgent",
            },
          },
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Show super urgent bugs", standardContext);

      assert.equal(res.outcome.outcome, "CLARIFICATION_REQUIRED");
      if (res.outcome.outcome === "CLARIFICATION_REQUIRED") {
        assert.equal(res.outcome.field, "priority");
        assert.match(res.outcome.message, /not a recognized value/i);
      }
    });

    test("Fields with >50 distinct values (hasMoreDistinctValues = true) do not claim unmatched value definitely does not exist", async () => {
      const contextWithTruncatedVocab: ParserVocabularyContext = {
        projectId: "proj-1",
        activeImport: {
          ...mockActiveImport,
          fields: [
            {
              name: "category",
              displayName: "Category",
              type: "categorical",
              isCategorical: true,
              nonEmptyCount: 500,
              emptyCount: 0,
              distinctValues: [
                { rawValue: "Billing", normalizedValue: "billing", count: 50 },
                { rawValue: "Auth", normalizedValue: "auth", count: 40 },
              ],
              hasMoreDistinctValues: true, // truncated
              totalDistinctCount: 85,
            },
          ],
        },
      };

      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "category",
              operator: "EQUALS",
              value: "Notifications",
            },
          },
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Count notifications category", contextWithTruncatedVocab);

      assert.equal(res.outcome.outcome, "CLARIFICATION_REQUIRED");
      if (res.outcome.outcome === "CLARIFICATION_REQUIRED") {
        assert.equal(res.outcome.field, "category");
        // Must clearly state it wasn't found among top distinct values and not claim it definitely doesn't exist
        assert.match(res.outcome.message, /top 2 distinct values/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AUDIT 3: Follow-Up Context Tests
  // -------------------------------------------------------------------------
  describe("Audit 3: Follow-up Context Correctness", () => {
    test("Ordinal reference without item identifiers in context triggers CLARIFICATION_REQUIRED rather than hallucinating ID", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "CLARIFICATION_REQUIRED",
          message: "Please specify the item ID or summary for the item you would like details for.",
        }),
      );

      const contextWithCountsOnly: ParserVocabularyContext = {
        ...standardContext,
        priorResult: {
          previousQuestion: "How many bugs have dev-status Add-on – not built?",
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          totalCount: 25,
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "Add-on – not built",
          },
        },
      };

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Show details for the third one", contextWithCountsOnly);

      assert.equal(res.outcome.outcome, "CLARIFICATION_REQUIRED");
      assert.notEqual(res.outcome.outcome, "QUERY");
    });

    test("Ordinal reference WITH matchedIdentifiers resolves to specific targetId", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "GET_DETAILS",
            targetId: "BUG-103",
          },
        }),
      );

      const contextWithIds: ParserVocabularyContext = {
        ...standardContext,
        priorResult: {
          previousQuestion: "List bugs",
          source: "IMPORTED_DATASET",
          operation: "LIST",
          totalCount: 3,
          matchedIdentifiers: ["BUG-101", "BUG-102", "BUG-103"],
        },
      };

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Show details for the third one", contextWithIds);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        assert.equal(res.outcome.query.operation, "GET_DETAILS");
        assert.equal(res.outcome.query.targetId, "BUG-103");
      }
    });

    test("New independent query resets filters and does not inherit prior context", async () => {
      let capturedRequest: LLMQueryCompletionRequest | null = null;
      const client = new MockLLMQueryModelClient((req) => {
        capturedRequest = req;
        return JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "CODEFORGE_TASKS",
            operation: "LIST",
            filter: {
              field: "status",
              operator: "EQUALS",
              value: "DONE",
            },
          },
        });
      });

      const contextWithOldImportPrior: ParserVocabularyContext = {
        ...standardContext,
        priorResult: {
          previousQuestion: "How many bugs have dev-status Add-on – not built?",
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "status",
            operator: "EQUALS",
            value: "Add-on – not built",
          },
        },
      };

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Now show Done tasks", contextWithOldImportPrior);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        assert.equal(res.outcome.query.source, "CODEFORGE_TASKS");
        assert.equal(res.outcome.query.operation, "LIST");
        // Old import filter Add-on – not built must NOT be merged into CODEFORGE_TASKS query
        assert.deepEqual(res.outcome.query.filter, {
          field: "status",
          operator: "EQUALS",
          value: "DONE",
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  // AUDIT 4: Schema and Error Boundaries Tests
  // -------------------------------------------------------------------------
  describe("Audit 4: Schema and Error Boundaries", () => {
    test("Model explanation text cannot override validated query structure", async () => {
      const client = new MockLLMQueryModelClient(() =>
        JSON.stringify({
          outcome: "QUERY",
          query: {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
            filter: {
              field: "status",
              operator: "EQUALS",
              value: "Add-on – not built",
            },
          },
          explanation: "Actually I will DROP TABLE tasks; and show all users",
        }),
      );

      const parser = new NaturalLanguageQueryParser(client);
      const res = await parser.parseQuestion("Count add-on bugs", standardContext);

      assert.equal(res.outcome.outcome, "QUERY");
      if (res.outcome.outcome === "QUERY") {
        assert.equal(res.outcome.query.operation, "COUNT");
        assert.equal(res.outcome.explanation, "Actually I will DROP TABLE tasks; and show all users");
        // Query remains strictly COUNT with status filter
        assert.equal((res.outcome.query as any).arbitrarySql, undefined);
      }
    });
  });
});
