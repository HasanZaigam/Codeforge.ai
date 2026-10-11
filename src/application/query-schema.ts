import { z } from "zod";

/**
 * Natural Language Query Understanding Engine — Phase 1 Schema
 * 
 * Strict, versioned StructuredQuery schema and QueryPlanOutcome definitions.
 * Designed to be model-agnostic, strictly validated, and rejecting any arbitrary
 * SQL, executable expressions, or mutations.
 */

// ---------------------------------------------------------------------------
// 1. Data Sources & Operations
// ---------------------------------------------------------------------------

export const DataSourceSchema = z.enum([
  "CODEFORGE_TASKS",
  "IMPORTED_DATASET",
]);
export type DataSource = z.infer<typeof DataSourceSchema>;

export const QueryOperationSchema = z.enum([
  "COUNT",
  "LIST",
  "GET_DETAILS",
  "GROUP_BY",
  "DISTINCT_VALUES",
]);
export type QueryOperation = z.infer<typeof QueryOperationSchema>;

// ---------------------------------------------------------------------------
// 2. Filter Operators & Field Filters
// ---------------------------------------------------------------------------

export const FilterOperatorSchema = z.enum([
  "EQUALS",
  "NOT_EQUALS",
  "IN",
  "NOT_IN",
  "CONTAINS",
  "STARTS_WITH",
  "GREATER_THAN",
  "LESS_THAN",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

const ScalarValueSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
]);

export const FieldFilterSchema = z
  .object({
    field: z
      .string()
      .trim()
      .min(1, "Field name cannot be empty")
      .max(100, "Field name exceeds 100 characters")
      .regex(/^[A-Za-z0-9_.\- ]+$/, "Field name contains invalid characters"),
    operator: FilterOperatorSchema,
    value: z
      .union([
        ScalarValueSchema,
        z.array(ScalarValueSchema).max(50, "At most 50 values permitted in array filter"),
      ])
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Value presence and typing rules based on operator
    switch (data.operator) {
      case "IS_EMPTY":
      case "IS_NOT_EMPTY":
        if (data.value !== undefined && data.value !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Operator ${data.operator} must not have a value`,
            path: ["value"],
          });
        }
        break;
      case "IN":
      case "NOT_IN":
        if (!Array.isArray(data.value) || data.value.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Operator ${data.operator} requires a non-empty array value`,
            path: ["value"],
          });
        }
        break;
      case "EQUALS":
      case "NOT_EQUALS":
      case "CONTAINS":
      case "STARTS_WITH":
      case "GREATER_THAN":
      case "LESS_THAN":
        if (data.value === undefined || Array.isArray(data.value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Operator ${data.operator} requires a scalar (string/number/boolean) value`,
            path: ["value"],
          });
        }
        break;
    }
  });

export type FieldFilter = z.infer<typeof FieldFilterSchema>;

// ---------------------------------------------------------------------------
// 3. Boolean Composition (AND / OR / NOT)
// ---------------------------------------------------------------------------

export type FilterClause =
  | { field: string; operator: FilterOperator; value?: z.infer<typeof ScalarValueSchema> | Array<z.infer<typeof ScalarValueSchema>> }
  | { and: FilterClause[] }
  | { or: FilterClause[] }
  | { not: FilterClause };

export const FilterClauseSchema: z.ZodType<FilterClause> = z.lazy(() =>
  z.union([
    FieldFilterSchema,
    z
      .object({
        and: z
          .array(FilterClauseSchema)
          .min(1, "AND clause must contain at least 1 filter")
          .max(10, "AND clause cannot exceed 10 filters"),
      })
      .strict(),
    z
      .object({
        or: z
          .array(FilterClauseSchema)
          .min(1, "OR clause must contain at least 1 filter")
          .max(10, "OR clause cannot exceed 10 filters"),
      })
      .strict(),
    z
      .object({
        not: FilterClauseSchema,
      })
      .strict(),
  ]),
);

// ---------------------------------------------------------------------------
// 4. Complexity and Depth Validation Helpers
// ---------------------------------------------------------------------------

export const QueryLimits = {
  maxLimit: 100,
  defaultLimit: 20,
  maxFilterDepth: 4,
  maxTotalFilters: 10,
} as const;

export interface ComplexityMetrics {
  totalFilters: number;
  maxDepth: number;
}

export function measureFilterComplexity(filter?: FilterClause, currentDepth = 1): ComplexityMetrics {
  if (!filter) return { totalFilters: 0, maxDepth: 0 };

  if ("field" in filter) {
    return { totalFilters: 1, maxDepth: currentDepth };
  }

  if ("and" in filter) {
    let total = 0;
    let maxSubDepth = currentDepth;
    for (const child of filter.and) {
      const childMetrics = measureFilterComplexity(child, currentDepth + 1);
      total += childMetrics.totalFilters;
      maxSubDepth = Math.max(maxSubDepth, childMetrics.maxDepth);
    }
    return { totalFilters: total, maxDepth: maxSubDepth };
  }

  if ("or" in filter) {
    let total = 0;
    let maxSubDepth = currentDepth;
    for (const child of filter.or) {
      const childMetrics = measureFilterComplexity(child, currentDepth + 1);
      total += childMetrics.totalFilters;
      maxSubDepth = Math.max(maxSubDepth, childMetrics.maxDepth);
    }
    return { totalFilters: total, maxDepth: maxSubDepth };
  }

  if ("not" in filter) {
    const childMetrics = measureFilterComplexity(filter.not, currentDepth + 1);
    return { totalFilters: childMetrics.totalFilters, maxDepth: childMetrics.maxDepth };
  }

  return { totalFilters: 0, maxDepth: currentDepth };
}

export function validateQueryComplexity(query: { filter?: FilterClause }): { valid: boolean; error?: string } {
  if (!query.filter) return { valid: true };
  const metrics = measureFilterComplexity(query.filter);
  if (metrics.maxDepth > QueryLimits.maxFilterDepth) {
    return {
      valid: false,
      error: `Filter nesting depth (${metrics.maxDepth}) exceeds maximum allowed depth (${QueryLimits.maxFilterDepth})`,
    };
  }
  if (metrics.totalFilters > QueryLimits.maxTotalFilters) {
    return {
      valid: false,
      error: `Total number of filters (${metrics.totalFilters}) exceeds maximum allowed count (${QueryLimits.maxTotalFilters})`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// 5. StructuredQuery Plan
// ---------------------------------------------------------------------------

export const OrderBySchema = z
  .object({
    field: z.string().trim().min(1).max(100),
    direction: z.enum(["ASC", "DESC"]),
  })
  .strict();
export type OrderBy = z.infer<typeof OrderBySchema>;

export const StructuredQuerySchema = z
  .object({
    source: DataSourceSchema,
    operation: QueryOperationSchema,
    filter: FilterClauseSchema.optional(),
    targetId: z.string().trim().min(1).max(200).optional(),
    groupByField: z.string().trim().min(1).max(100).optional(),
    distinctField: z.string().trim().min(1).max(100).optional(),
    limit: z.number().int().positive().max(QueryLimits.maxLimit).optional(),
    offset: z.number().int().nonnegative().optional(),
    orderBy: OrderBySchema.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.operation === "GET_DETAILS" && !q.targetId && !q.filter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GET_DETAILS operation requires targetId or a filter identifying the item",
        path: ["targetId"],
      });
    }
    if (q.operation === "GROUP_BY" && !q.groupByField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GROUP_BY operation requires groupByField",
        path: ["groupByField"],
      });
    }
    if (q.operation === "DISTINCT_VALUES" && !q.distinctField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DISTINCT_VALUES operation requires distinctField",
        path: ["distinctField"],
      });
    }
    if (q.filter) {
      const complexity = validateQueryComplexity(q);
      if (!complexity.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: complexity.error ?? "Query filter complexity limit exceeded",
          path: ["filter"],
        });
      }
    }
  });

export type StructuredQuery = z.infer<typeof StructuredQuerySchema>;

// ---------------------------------------------------------------------------
// 6. Query Understanding Outcomes
// ---------------------------------------------------------------------------

export const ClarificationCandidateSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().min(1),
    count: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ClarificationCandidate = z.infer<typeof ClarificationCandidateSchema>;

export const QueryPlanOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("QUERY"),
      query: StructuredQuerySchema,
      explanation: z.string().max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("CLARIFICATION_REQUIRED"),
      message: z.string().min(1).max(1_000),
      field: z.string().max(100).optional(),
      candidates: z.array(ClarificationCandidateSchema).max(20).optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("UNSUPPORTED"),
      reason: z.string().min(1).max(1_000),
      missingCapability: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("NOT_A_DATA_QUERY"),
      reason: z.string().max(500).optional(),
    })
    .strict(),
]);

export type QueryPlanOutcome = z.infer<typeof QueryPlanOutcomeSchema>;
