import type { BacklogItem } from "../backlog/backlog-types.js";
import type { Task, TaskStatus } from "../domain/types.js";
import type { BacklogBulkRepository } from "../persistence/repositories/backlog-bulk-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import { assertProjectAccess } from "./authorization.js";
import { InvalidRequestError, NotFoundError } from "./errors.js";
import {
  StructuredQuerySchema,
  type FilterClause,
  type FilterOperator,
  type StructuredQuery,
} from "./query-schema.js";
import {
  extractVocabularyFromItems,
  normalizeValueForMatching,
  type DatasetVocabulary,
  type InferredFieldType,
} from "./dataset-vocabulary.js";
import { ALL_TASK_STATUSES } from "./context-layer.js";

/**
 * Phase 3 — Deterministic Query Execution Layer
 *
 * Responsibilities:
 * 1. Strict read-only query execution against authoritative SQLite repositories.
 * 2. Absolute project and actor authorization enforcement.
 * 3. Zero model hallucination: executes only validated queries against real records.
 * 4. Zero SQL injection: parameterizes repository reads with strict allowlists.
 * 5. Full operator and AST evaluation for COUNT, GROUP_BY, LIST, GET_DETAILS, and DISTINCT_VALUES.
 */

export const EXECUTOR_LIMITS = {
  maxListLimit: 100,
  defaultListLimit: 20,
  maxDistinctLimit: 50,
} as const;

export interface QueryExecutionContext {
  actorId: string;
  projectId: string;
  importId?: string;
}

export type QueryExecutionResult =
  | {
      operation: "COUNT";
      count: number;
    }
  | {
      operation: "GROUP_BY";
      groupByField: string;
      groups: Array<{ key: string; count: number }>;
      totalGroups: number;
    }
  | {
      operation: "LIST";
      items: Array<Record<string, unknown>>;
      totalCount: number;
      limit: number;
      offset: number;
    }
  | {
      operation: "GET_DETAILS";
      item: Record<string, unknown> | null;
      matched: boolean;
      ambiguous?: boolean;
    }
  | {
      operation: "DISTINCT_VALUES";
      field: string;
      values: string[];
      totalDistinct: number;
      hasMore: boolean;
    };

/**
 * Normalizes field value extraction across Task or BacklogItem records.
 */
export function extractRecordFieldValue(
  record: Record<string, unknown>,
  fieldName: string,
  source: "CODEFORGE_TASKS" | "IMPORTED_DATASET",
): unknown {
  const normName = fieldName.trim();
  const lowerName = normName.toLowerCase();

  if (source === "CODEFORGE_TASKS") {
    if (lowerName === "status") return record.status;
    if (lowerName === "title") return record.title;
    if (lowerName === "goal" || lowerName === "description") return record.goal;
    if (lowerName === "createdat" || lowerName === "created_at") return record.createdAt;
    if (lowerName === "updatedat" || lowerName === "updated_at") return record.updatedAt;
    if (lowerName === "id") return record.id;
    return record[fieldName];
  }

  // IMPORTED_DATASET
  if (lowerName === "externalref" || lowerName === "bugid" || lowerName === "id" || lowerName === "key") {
    return record.externalRef ?? record.id;
  }
  if (lowerName === "title" || lowerName === "summary") return record.title;
  if (lowerName === "description") return record.description;
  if (lowerName === "status") {
    const meta = record.metadata as Record<string, string> | undefined;
    return meta?.status ?? record.status;
  }

  // Check metadata dictionary first for imported columns
  const meta = record.metadata as Record<string, string> | undefined;
  if (meta && Object.prototype.hasOwnProperty.call(meta, fieldName)) {
    return meta[fieldName];
  }
  // Case-insensitive metadata search
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (k.toLowerCase() === lowerName) return v;
    }
  }

  return record[fieldName];
}

/**
 * Coerces value for comparison based on inferred type.
 */
function parseComparableValue(val: unknown, type: InferredFieldType): number | string | boolean | null {
  if (val === undefined || val === null) return null;
  const str = String(val).trim();
  if (str === "") return null;

  if (type === "number") {
    const num = Number(str);
    return Number.isNaN(num) ? null : num;
  }

  if (type === "date") {
    const time = Date.parse(str);
    return Number.isNaN(time) ? null : time;
  }

  if (type === "boolean") {
    const l = str.toLowerCase();
    if (l === "true" || l === "yes" || l === "1") return true;
    if (l === "false" || l === "no" || l === "0") return false;
    return null;
  }

  return str;
}

/**
 * Evaluates a single filter clause against a record.
 */
export function evaluateFilterClause(
  record: Record<string, unknown>,
  filter: FilterClause,
  source: "CODEFORGE_TASKS" | "IMPORTED_DATASET",
  fieldTypes: Map<string, InferredFieldType>,
): boolean {
  if ("and" in filter) {
    return filter.and.every((child) => evaluateFilterClause(record, child, source, fieldTypes));
  }

  if ("or" in filter) {
    return filter.or.some((child) => evaluateFilterClause(record, child, source, fieldTypes));
  }

  if ("not" in filter) {
    return !evaluateFilterClause(record, filter.not, source, fieldTypes);
  }

  // Leaf FieldFilter
  const rawRecordVal = extractRecordFieldValue(record, filter.field, source);
  const fieldType = fieldTypes.get(filter.field.toLowerCase()) ?? "string";

  return evaluateOperator(rawRecordVal, filter.operator, filter.value, fieldType);
}

/**
 * Evaluates typed operator against extracted field value.
 */
export function evaluateOperator(
  recordVal: unknown,
  operator: FilterOperator,
  targetVal: unknown,
  fieldType: InferredFieldType,
): boolean {
  const isRecordEmpty =
    recordVal === undefined ||
    recordVal === null ||
    (typeof recordVal === "string" && recordVal.trim() === "");

  if (operator === "IS_EMPTY") {
    return isRecordEmpty;
  }

  if (operator === "IS_NOT_EMPTY") {
    return !isRecordEmpty;
  }

  if (isRecordEmpty) {
    // Non-empty operators evaluate to false on empty/missing values
    return false;
  }

  const strRecordVal = String(recordVal).trim();
  const normRecordVal = normalizeValueForMatching(strRecordVal);

  switch (operator) {
    case "EQUALS": {
      if (fieldType === "number" || fieldType === "date") {
        const compRecord = parseComparableValue(recordVal, fieldType);
        const compTarget = parseComparableValue(targetVal, fieldType);
        return compRecord !== null && compTarget !== null && compRecord === compTarget;
      }
      const normTarget = normalizeValueForMatching(String(targetVal));
      return strRecordVal === String(targetVal) || normRecordVal === normTarget;
    }

    case "NOT_EQUALS": {
      if (fieldType === "number" || fieldType === "date") {
        const compRecord = parseComparableValue(recordVal, fieldType);
        const compTarget = parseComparableValue(targetVal, fieldType);
        return compRecord !== null && compTarget !== null && compRecord !== compTarget;
      }
      const normTarget = normalizeValueForMatching(String(targetVal));
      return strRecordVal !== String(targetVal) && normRecordVal !== normTarget;
    }

    case "IN": {
      if (!Array.isArray(targetVal)) return false;
      if (fieldType === "number" || fieldType === "date") {
        const compRecord = parseComparableValue(recordVal, fieldType);
        if (compRecord === null) return false;
        return targetVal.some((v) => parseComparableValue(v, fieldType) === compRecord);
      }
      return targetVal.some((v) => {
        const s = String(v);
        return strRecordVal === s || normRecordVal === normalizeValueForMatching(s);
      });
    }

    case "NOT_IN": {
      if (!Array.isArray(targetVal)) return true;
      if (fieldType === "number" || fieldType === "date") {
        const compRecord = parseComparableValue(recordVal, fieldType);
        if (compRecord === null) return true;
        return !targetVal.some((v) => parseComparableValue(v, fieldType) === compRecord);
      }
      return !targetVal.some((v) => {
        const s = String(v);
        return strRecordVal === s || normRecordVal === normalizeValueForMatching(s);
      });
    }

    case "CONTAINS": {
      const normTarget = normalizeValueForMatching(String(targetVal));
      return normRecordVal.includes(normTarget);
    }

    case "STARTS_WITH": {
      const normTarget = normalizeValueForMatching(String(targetVal));
      return normRecordVal.startsWith(normTarget);
    }

    case "GREATER_THAN": {
      if (fieldType === "number" || fieldType === "date") {
        const compRecord = parseComparableValue(recordVal, fieldType);
        const compTarget = parseComparableValue(targetVal, fieldType);
        return compRecord !== null && compTarget !== null && compRecord > compTarget;
      }
      return strRecordVal > String(targetVal);
    }

    case "LESS_THAN": {
      if (fieldType === "number" || fieldType === "date") {
        const compRecord = parseComparableValue(recordVal, fieldType);
        const compTarget = parseComparableValue(targetVal, fieldType);
        return compRecord !== null && compTarget !== null && compRecord < compTarget;
      }
      return strRecordVal < String(targetVal);
    }

    default:
      return false;
  }
}

export class QueryExecutor {
  constructor(
    private readonly d: {
      projects: ProjectRepository;
      tasks: TaskRepository;
      items: BacklogItemRepository;
      bulk: BacklogBulkRepository;
    },
  ) {}

  /**
   * Executes a validated StructuredQuery deterministically against authoritative data.
   */
  async execute(
    rawQuery: unknown,
    context: QueryExecutionContext,
  ): Promise<QueryExecutionResult> {
    const { actorId, projectId, importId } = context;

    // 1. Authorize actor against project
    assertProjectAccess(this.d.projects, projectId, actorId);

    // 2. Validate query schema strictly
    const query = StructuredQuerySchema.parse(rawQuery);

    // 3. Load authoritative records and build field metadata
    const { records, fieldTypes } = this.loadScopedRecords(query.source, projectId, importId);

    // 4. Validate query fields exist in authoritative source
    this.validateQueryFields(query, fieldTypes);

    // 5. Execute operation
    switch (query.operation) {
      case "COUNT":
        return this.executeCount(query, records, fieldTypes);
      case "GROUP_BY":
        return this.executeGroupBy(query, records, fieldTypes);
      case "LIST":
        return this.executeList(query, records, fieldTypes);
      case "GET_DETAILS":
        return this.executeGetDetails(query, records, fieldTypes);
      case "DISTINCT_VALUES":
        return this.executeDistinctValues(query, records);
    }
  }

  /**
   * Loads records strictly scoped by project and (if imported) import ID.
   */
  private loadScopedRecords(
    source: "CODEFORGE_TASKS" | "IMPORTED_DATASET",
    projectId: string,
    importId?: string,
  ): {
    records: Array<Record<string, unknown>>;
    fieldTypes: Map<string, InferredFieldType>;
  } {
    const fieldTypes = new Map<string, InferredFieldType>();

    if (source === "CODEFORGE_TASKS") {
      const taskList = this.d.tasks.listByProject(projectId);
      fieldTypes.set("status", "categorical");
      fieldTypes.set("title", "string");
      fieldTypes.set("goal", "string");
      fieldTypes.set("description", "string");
      fieldTypes.set("createdat", "date");
      fieldTypes.set("updatedat", "date");
      fieldTypes.set("id", "string");

      const records = taskList.map((t) => ({
        id: t.id,
        title: t.title,
        goal: t.goal,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        tenantId: t.tenantId,
        projectId: t.projectId,
      }));

      return { records, fieldTypes };
    }

    // IMPORTED_DATASET
    if (!importId) {
      throw new InvalidRequestError("importId is required to query IMPORTED_DATASET");
    }

    const imp = this.d.bulk.findImport(importId);
    if (!imp || imp.projectId !== projectId) {
      throw new NotFoundError("Project", `Import not found or does not belong to project: ${importId}`);
    }

    const items = this.d.items.listByImport(importId);
    const vocab: DatasetVocabulary = extractVocabularyFromItems(imp, items);

    for (const f of vocab.fields) {
      fieldTypes.set(f.name.toLowerCase(), f.type);
      fieldTypes.set(f.displayName.toLowerCase(), f.type);
    }

    // Standard fallback fields
    fieldTypes.set("id", "string");
    fieldTypes.set("externalref", "string");
    fieldTypes.set("title", "string");
    fieldTypes.set("description", "string");
    fieldTypes.set("status", "categorical");

    const records = items.map((item) => ({
      id: item.id,
      projectId: item.projectId,
      externalRef: item.externalRef,
      title: item.title,
      description: item.description,
      status: item.status,
      source: item.source,
      sourceRow: item.sourceRow,
      metadata: item.metadata ?? {},
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    return { records, fieldTypes };
  }

  /**
   * Validates that all fields mentioned in the query exist on the data source.
   */
  private validateQueryFields(
    query: StructuredQuery,
    fieldTypes: Map<string, InferredFieldType>,
  ): void {
    if (query.groupByField && !fieldTypes.has(query.groupByField.toLowerCase())) {
      throw new InvalidRequestError(`Field "${query.groupByField}" does not exist on ${query.source}`);
    }
    if (query.distinctField && !fieldTypes.has(query.distinctField.toLowerCase())) {
      throw new InvalidRequestError(`Field "${query.distinctField}" does not exist on ${query.source}`);
    }

    const validateClauseFields = (clause?: FilterClause) => {
      if (!clause) return;
      if ("field" in clause) {
        if (!fieldTypes.has(clause.field.toLowerCase())) {
          throw new InvalidRequestError(`Filter field "${clause.field}" does not exist on ${query.source}`);
        }
      } else if ("and" in clause) {
        clause.and.forEach(validateClauseFields);
      } else if ("or" in clause) {
        clause.or.forEach(validateClauseFields);
      } else if ("not" in clause) {
        validateClauseFields(clause.not);
      }
    };

    validateClauseFields(query.filter);
  }

  private executeCount(
    query: StructuredQuery,
    records: Array<Record<string, unknown>>,
    fieldTypes: Map<string, InferredFieldType>,
  ): QueryExecutionResult {
    const filtered = query.filter
      ? records.filter((r) => evaluateFilterClause(r, query.filter!, query.source, fieldTypes))
      : records;

    return {
      operation: "COUNT",
      count: filtered.length,
    };
  }

  private executeGroupBy(
    query: StructuredQuery,
    records: Array<Record<string, unknown>>,
    fieldTypes: Map<string, InferredFieldType>,
  ): QueryExecutionResult {
    const groupByField = query.groupByField!;
    const filtered = query.filter
      ? records.filter((r) => evaluateFilterClause(r, query.filter!, query.source, fieldTypes))
      : records;

    // Tally counts per group key
    const counts = new Map<string, number>();

    for (const r of filtered) {
      const val = extractRecordFieldValue(r, groupByField, query.source);
      const strKey =
        val === undefined || val === null
          ? "(empty)"
          : String(val).trim() || "(empty)";

      counts.set(strKey, (counts.get(strKey) ?? 0) + 1);
    }

    // Sort groups descending by count, then alphabetically
    const groups = Array.from(counts.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
      operation: "GROUP_BY",
      groupByField,
      groups,
      totalGroups: groups.length,
    };
  }

  private executeList(
    query: StructuredQuery,
    records: Array<Record<string, unknown>>,
    fieldTypes: Map<string, InferredFieldType>,
  ): QueryExecutionResult {
    const filtered = query.filter
      ? records.filter((r) => evaluateFilterClause(r, query.filter!, query.source, fieldTypes))
      : records;

    // Stable ordering: by specified orderBy or default id ASC
    const sorted = [...filtered].sort((a, b) => {
      if (query.orderBy) {
        const valA = extractRecordFieldValue(a, query.orderBy.field, query.source);
        const valB = extractRecordFieldValue(b, query.orderBy.field, query.source);
        const comp = String(valA ?? "").localeCompare(String(valB ?? ""));
        return query.orderBy.direction === "DESC" ? -comp : comp;
      }
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });

    const limit = Math.min(query.limit ?? EXECUTOR_LIMITS.defaultListLimit, EXECUTOR_LIMITS.maxListLimit);
    const offset = query.offset ?? 0;
    const paginated = sorted.slice(offset, offset + limit);

    return {
      operation: "LIST",
      items: paginated,
      totalCount: filtered.length,
      limit,
      offset,
    };
  }

  private executeGetDetails(
    query: StructuredQuery,
    records: Array<Record<string, unknown>>,
    fieldTypes: Map<string, InferredFieldType>,
  ): QueryExecutionResult {
    let candidateMatches: Array<Record<string, unknown>> = [];

    if (query.targetId) {
      const target = query.targetId.trim();
      candidateMatches = records.filter((r) => {
        const id = String(r.id ?? "");
        const externalRef = String(r.externalRef ?? "");
        return (
          id === target ||
          externalRef === target ||
          id.toLowerCase() === target.toLowerCase() ||
          externalRef.toLowerCase() === target.toLowerCase()
        );
      });
    } else if (query.filter) {
      candidateMatches = records.filter((r) =>
        evaluateFilterClause(r, query.filter!, query.source, fieldTypes),
      );
    }

    if (candidateMatches.length === 1) {
      return {
        operation: "GET_DETAILS",
        item: candidateMatches[0]!,
        matched: true,
      };
    }

    if (candidateMatches.length > 1) {
      return {
        operation: "GET_DETAILS",
        item: null,
        matched: false,
        ambiguous: true,
      };
    }

    return {
      operation: "GET_DETAILS",
      item: null,
      matched: false,
    };
  }

  private executeDistinctValues(
    query: StructuredQuery,
    records: Array<Record<string, unknown>>,
  ): QueryExecutionResult {
    const distinctField = query.distinctField!;
    const valuesSet = new Set<string>();

    for (const r of records) {
      const val = extractRecordFieldValue(r, distinctField, query.source);
      if (val !== undefined && val !== null) {
        const trimmed = String(val).trim();
        if (trimmed) valuesSet.add(trimmed);
      }
    }

    const allValues = Array.from(valuesSet).sort();
    const limit = Math.min(query.limit ?? EXECUTOR_LIMITS.maxDistinctLimit, EXECUTOR_LIMITS.maxDistinctLimit);
    const bounded = allValues.slice(0, limit);

    return {
      operation: "DISTINCT_VALUES",
      field: distinctField,
      values: bounded,
      totalDistinct: allValues.length,
      hasMore: allValues.length > bounded.length,
    };
  }
}
