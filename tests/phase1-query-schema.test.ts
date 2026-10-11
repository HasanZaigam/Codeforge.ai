import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  StructuredQuerySchema,
  QueryPlanOutcomeSchema,
  validateQueryComplexity,
  type StructuredQuery,
  type QueryPlanOutcome,
} from "../src/application/query-schema.js";
import {
  extractVocabularyFromItems,
  normalizeValueForMatching,
} from "../src/application/dataset-vocabulary.js";
import type { BacklogItem } from "../src/backlog/backlog-types.js";

describe("Phase 1: Schema & Metadata Discovery", () => {
  describe("1. StructuredQuery Validation", () => {
    test("validates a standard count query with field filter", () => {
      const validQuery = {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          field: "status",
          operator: "EQUALS",
          value: "DONE – Merged",
        },
      };

      const parsed = StructuredQuerySchema.parse(validQuery);
      assert.equal(parsed.source, "IMPORTED_DATASET");
      assert.equal(parsed.operation, "COUNT");
      assert.equal(parsed.limit, undefined);
    });

    test("validates composite boolean logic (AND, OR, NOT)", () => {
      const complexQuery = {
        source: "CODEFORGE_TASKS",
        operation: "LIST",
        filter: {
          and: [
            {
              or: [
                { field: "status", operator: "EQUALS", value: "FAILED" },
                { field: "status", operator: "EQUALS", value: "CANCELLED" },
              ],
            },
            {
              not: {
                field: "priority",
                operator: "EQUALS",
                value: "Low",
              },
            },
          ],
        },
        limit: 10,
        orderBy: {
          field: "createdAt",
          direction: "DESC",
        },
      };

      const parsed = StructuredQuerySchema.parse(complexQuery);
      assert.equal(parsed.operation, "LIST");
      const complexity = validateQueryComplexity(parsed);
      assert.equal(complexity.valid, true);
    });

    test("rejects unknown properties strictly", () => {
      const badQuery = {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          field: "status",
          operator: "EQUALS",
          value: "open",
        },
        arbitrarySql: "DROP TABLE users;", // illegal
      };

      assert.throws(() => {
        StructuredQuerySchema.parse(badQuery);
      });
    });

    test("rejects invalid operator or missing required values", () => {
      // IN requires an array
      assert.throws(() => {
        StructuredQuerySchema.parse({
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "status",
            operator: "IN",
            value: "open", // should be array
          },
        });
      });

      // IS_EMPTY must not have a value
      assert.throws(() => {
        StructuredQuerySchema.parse({
          source: "IMPORTED_DATASET",
          operation: "COUNT",
          filter: {
            field: "status",
            operator: "IS_EMPTY",
            value: "something",
          },
        });
      });
    });

    test("rejects GROUP_BY without groupByField", () => {
      assert.throws(() => {
        StructuredQuerySchema.parse({
          source: "IMPORTED_DATASET",
          operation: "GROUP_BY",
        });
      });
    });

    test("validates query at maximum allowed filter depth (depth = 4)", () => {
      // Depth: 1 (and) -> 2 (or) -> 3 (not) -> 4 (leaf field)
      const atMaxDepth = {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          and: [
            {
              or: [
                {
                  not: {
                    field: "status",
                    operator: "EQUALS",
                    value: "open",
                  },
                },
              ],
            },
          ],
        },
      };

      const parsed = StructuredQuerySchema.parse(atMaxDepth);
      assert.ok(parsed);
      const safe = StructuredQuerySchema.safeParse(atMaxDepth);
      assert.equal(safe.success, true);
    });

    test("rejects query exceeding max filter depth via parse() and safeParse()", () => {
      // Depth: 1 (and) -> 2 (or) -> 3 (not) -> 4 (and) -> 5 (leaf field) = depth 5 (limit is 4)
      const deeplyNested = {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          and: [
            {
              or: [
                {
                  not: {
                    and: [
                      {
                        field: "status",
                        operator: "EQUALS",
                        value: "open",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

      // 1. Throws via parse()
      assert.throws(
        () => {
          StructuredQuerySchema.parse(deeplyNested);
        },
        (err: any) => {
          assert.match(err.message, /Filter nesting depth \(5\) exceeds maximum allowed depth \(4\)/);
          assert.equal(err.issues[0].path[0], "filter");
          return true;
        },
      );

      // 2. Returns failure via safeParse()
      const safeResult = StructuredQuerySchema.safeParse(deeplyNested);
      assert.equal(safeResult.success, false);
      if (!safeResult.success) {
        const issue = safeResult.error.issues[0];
        assert.ok(issue);
        assert.match(issue.message, /Filter nesting depth/i);
        assert.deepEqual(issue.path, ["filter"]);
      }
    });

    test("validates query at maximum allowed filter count (10 total leaf filters)", () => {
      const atMaxCount = {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          and: [
            {
              or: [
                { field: "col1", operator: "EQUALS", value: "v1" },
                { field: "col2", operator: "EQUALS", value: "v2" },
                { field: "col3", operator: "EQUALS", value: "v3" },
                { field: "col4", operator: "EQUALS", value: "v4" },
                { field: "col5", operator: "EQUALS", value: "v5" },
              ],
            },
            {
              or: [
                { field: "col6", operator: "EQUALS", value: "v6" },
                { field: "col7", operator: "EQUALS", value: "v7" },
                { field: "col8", operator: "EQUALS", value: "v8" },
                { field: "col9", operator: "EQUALS", value: "v9" },
                { field: "col10", operator: "EQUALS", value: "v10" },
              ],
            },
          ],
        },
      };

      const parsed = StructuredQuerySchema.parse(atMaxCount);
      assert.ok(parsed);
      const safe = StructuredQuerySchema.safeParse(atMaxCount);
      assert.equal(safe.success, true);
    });

    test("rejects query exceeding maximum allowed filter count via parse() and safeParse()", () => {
      // 11 leaf filters across 2 or-clauses inside an and-clause
      const overCount = {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          and: [
            {
              or: [
                { field: "col1", operator: "EQUALS", value: "v1" },
                { field: "col2", operator: "EQUALS", value: "v2" },
                { field: "col3", operator: "EQUALS", value: "v3" },
                { field: "col4", operator: "EQUALS", value: "v4" },
                { field: "col5", operator: "EQUALS", value: "v5" },
                { field: "col6", operator: "EQUALS", value: "v6" },
              ],
            },
            {
              or: [
                { field: "col7", operator: "EQUALS", value: "v7" },
                { field: "col8", operator: "EQUALS", value: "v8" },
                { field: "col9", operator: "EQUALS", value: "v9" },
                { field: "col10", operator: "EQUALS", value: "v10" },
                { field: "col11", operator: "EQUALS", value: "v11" },
              ],
            },
          ],
        },
      };

      // 1. Throws via parse()
      assert.throws(
        () => {
          StructuredQuerySchema.parse(overCount);
        },
        (err: any) => {
          assert.match(err.message, /Total number of filters \(11\) exceeds maximum allowed count \(10\)/);
          assert.equal(err.issues[0].path[0], "filter");
          return true;
        },
      );

      // 2. Returns failure via safeParse()
      const safeResult = StructuredQuerySchema.safeParse(overCount);
      assert.equal(safeResult.success, false);
      if (!safeResult.success) {
        const issue = safeResult.error.issues[0];
        assert.ok(issue);
        assert.match(issue.message, /Total number of filters/i);
        assert.deepEqual(issue.path, ["filter"]);
      }
    });

    test("validates valid nested AND / OR / NOT expressions", () => {
      const validNested = {
        source: "CODEFORGE_TASKS",
        operation: "LIST",
        filter: {
          and: [
            {
              or: [
                { field: "status", operator: "EQUALS", value: "IN_PROGRESS" },
                { field: "status", operator: "EQUALS", value: "REVIEW" },
              ],
            },
            {
              not: {
                field: "priority",
                operator: "EQUALS",
                value: "LOW",
              },
            },
          ],
        },
      };

      const parsed = StructuredQuerySchema.parse(validNested);
      assert.equal(parsed.operation, "LIST");
      const safe = StructuredQuerySchema.safeParse(validNested);
      assert.equal(safe.success, true);
    });
  });

  describe("2. QueryPlanOutcome Validation", () => {
    test("validates explicit QUERY outcome", () => {
      const outcome: QueryPlanOutcome = {
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
        explanation: "User requested count of add-on bugs",
      };

      const parsed = QueryPlanOutcomeSchema.parse(outcome);
      assert.equal(parsed.outcome, "QUERY");
    });

    test("validates CLARIFICATION_REQUIRED outcome with candidates", () => {
      const outcome: QueryPlanOutcome = {
        outcome: "CLARIFICATION_REQUIRED",
        message: "Did you mean 'DONE – Merged' or 'In Progress'?",
        field: "status",
        candidates: [
          { label: "DONE – Merged", value: "DONE – Merged", count: 12 },
          { label: "In Progress", value: "In Progress", count: 4 },
        ],
      };

      const parsed = QueryPlanOutcomeSchema.parse(outcome);
      assert.equal(parsed.outcome, "CLARIFICATION_REQUIRED");
    });

    test("validates UNSUPPORTED outcome", () => {
      const outcome: QueryPlanOutcome = {
        outcome: "UNSUPPORTED",
        reason: "Cross-dataset joins are not currently supported",
        missingCapability: "CROSS_JOIN",
      };

      const parsed = QueryPlanOutcomeSchema.parse(outcome);
      assert.equal(parsed.outcome, "UNSUPPORTED");
    });

    test("validates NOT_A_DATA_QUERY outcome", () => {
      const outcome: QueryPlanOutcome = {
        outcome: "NOT_A_DATA_QUERY",
        reason: "User is asking general programming advice",
      };

      const parsed = QueryPlanOutcomeSchema.parse(outcome);
      assert.equal(parsed.outcome, "NOT_A_DATA_QUERY");
    });
  });

  describe("3. Dataset Vocabulary Discovery", () => {
    test("normalizes matching keys without altering raw Unicode values", () => {
      const raw = "DONE – Merged"; // en-dash U+2013
      const norm = normalizeValueForMatching(raw);
      assert.equal(norm, "done - merged"); // ASCII hyphen

      const rawEmDash = "Critical — Blocker"; // em-dash U+2014
      assert.equal(normalizeValueForMatching(rawEmDash), "critical - blocker");
    });

    test("extracts distinct values, counts, and inferred types from items", () => {
      const mockImport = {
        id: "imp-123",
        projectId: "proj-1",
        sourceName: "qa_tracker.csv",
        contentHash: "hashabc123",
        totalRows: 4,
        mapping: {
          fields: {
            title: "Summary",
            status: "Dev Status",
            priority: "Priority",
          },
        },
      };

      const mockItems: BacklogItem[] = [
        {
          id: "item-1",
          projectId: "proj-1",
          externalRef: "qa:BUG-101",
          title: "Fix login button",
          description: "Button doesn't respond on click",
          source: "import",
          status: "NEW",
          createdBy: "user-1",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          metadata: {
            status: "Add-on – not built",
            priority: "High",
            module: "Auth",
            estimatedHours: "4",
          },
        },
        {
          id: "item-2",
          projectId: "proj-1",
          externalRef: "qa:BUG-102",
          title: "Dark mode toggle fails",
          description: "Theme doesn't switch",
          source: "import",
          status: "NEW",
          createdBy: "user-1",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          metadata: {
            status: "Add-on – not built",
            priority: "Low",
            module: "UI",
            estimatedHours: "2",
          },
        },
        {
          id: "item-3",
          projectId: "proj-1",
          externalRef: "qa:BUG-103",
          title: "Memory leak in video player",
          description: "Buffer is not cleared",
          source: "import",
          status: "NEW",
          createdBy: "user-1",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          metadata: {
            status: "DONE – Merged",
            priority: "High",
            module: "Video",
            estimatedHours: "10",
          },
        },
      ];

      const vocab = extractVocabularyFromItems(mockImport, mockItems);

      assert.equal(vocab.importId, "imp-123");
      assert.equal(vocab.sourceName, "qa_tracker.csv");
      assert.equal(vocab.contentHash, "hashabc123");

      // Verify canonical fields
      assert.equal(vocab.canonicalFields.statusField, "status");
      assert.equal(vocab.canonicalFields.priorityField, "priority");

      // Verify status field vocabulary
      const statusField = vocab.fields.find((f) => f.name === "status");
      assert.ok(statusField);
      assert.equal(statusField.isCategorical, true);
      assert.equal(statusField.totalDistinctCount, 2);

      const addOnVal = statusField.distinctValues.find((v) => v.normalizedValue === "add-on - not built");
      assert.ok(addOnVal);
      assert.equal(addOnVal.rawValue, "Add-on – not built"); // exact raw unicode preserved
      assert.equal(addOnVal.count, 2);

      const mergedVal = statusField.distinctValues.find((v) => v.normalizedValue === "done - merged");
      assert.ok(mergedVal);
      assert.equal(mergedVal.rawValue, "DONE – Merged");
      assert.equal(mergedVal.count, 1);

      // Verify numeric inference on estimatedHours
      const hoursField = vocab.fields.find((f) => f.name === "estimatedHours");
      assert.ok(hoursField);
      assert.equal(hoursField.type, "number");
    });
  });
});
