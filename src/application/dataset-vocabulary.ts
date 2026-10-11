import type { BacklogItem } from "../backlog/backlog-types.js";
import type { BacklogBulkRepository, BacklogImportRecord } from "../persistence/repositories/backlog-bulk-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import { assertProjectAccess } from "./authorization.js";
import { InvalidRequestError, NotFoundError } from "./errors.js";
import type { ContextLayerService } from "./context-layer.js";
import { ALL_TASK_STATUSES } from "./context-layer.js";

/**
 * Phase 1 — Dataset Metadata and Vocabulary Discovery
 *
 * Discovers actual column names, types, and categorical distinct values
 * from authoritative data sources (active CSV imports and CodeForge tasks).
 *
 * Strict Rules:
 * 1. Preserves original values exactly for display (including Unicode hyphens, emojis, case).
 * 2. Uses deterministic normalized representations only for matching.
 * 3. Bounded metadata, field counts, and distinct value sizes.
 * 4. Never invents enum values.
 */

export const VOCABULARY_LIMITS = {
  maxDistinctValuesPerField: 50,
  maxFields: 40,
  maxValueDisplayLength: 200,
  categoricalCardinalityThreshold: 30,
} as const;

export type InferredFieldType = "string" | "number" | "date" | "boolean" | "categorical";

export interface DistinctValueCount {
  /** Exact original string as stored in the dataset, preserving Unicode and casing */
  rawValue: string;
  /** Normalized representation for matching (lowercase, standardized whitespace and hyphens) */
  normalizedValue: string;
  /** Number of occurrences */
  count: number;
}

export interface FieldVocabulary {
  name: string;
  displayName: string;
  type: InferredFieldType;
  isCategorical: boolean;
  nonEmptyCount: number;
  emptyCount: number;
  distinctValues: DistinctValueCount[];
  hasMoreDistinctValues: boolean;
  totalDistinctCount: number;
}

export interface DatasetVocabulary {
  source: "IMPORTED_DATASET";
  projectId: string;
  importId: string;
  sourceName: string;
  /** Content hash serves as the immutable revision/identity of this dataset */
  contentHash: string;
  totalRows: number;
  fields: FieldVocabulary[];
  canonicalFields: {
    statusField?: string;
    priorityField?: string;
    moduleField?: string;
    severityField?: string;
    titleField?: string;
    idField?: string;
  };
}

export interface TaskDatasetVocabulary {
  source: "CODEFORGE_TASKS";
  projectId: string;
  totalTasks: number;
  fields: FieldVocabulary[];
}

/**
 * Deterministic value normalization for matching.
 * Safe against Unicode dash variations, multiple whitespace, and case differences.
 * Never mutates or replaces the canonical rawValue.
 */
export function normalizeValueForMatching(val: string): string {
  return val
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-") // Unicode hyphens/dashes
    .replace(/\s+/g, " ");
}

/**
 * Detects if a series of non-empty sample strings conform to a specific scalar type.
 */
function inferType(samples: string[], fieldName: string, cardinality: number): InferredFieldType {
  if (samples.length === 0) return "string";

  const lowerName = fieldName.toLowerCase();
  const isExplicitCategoricalName =
    lowerName.includes("status") ||
    lowerName.includes("priority") ||
    lowerName.includes("severity") ||
    lowerName.includes("module") ||
    lowerName.includes("state") ||
    lowerName.includes("platform") ||
    lowerName.includes("environment");

  // Check boolean first
  const isBool = samples.every((s) => {
    const l = s.toLowerCase();
    return l === "true" || l === "false" || l === "yes" || l === "no";
  });
  if (isBool && cardinality <= 2) return "boolean";

  // Check numeric
  const isNumeric = samples.every((s) => /^-?\d+(\.\d+)?$/.test(s.trim()));
  if (isNumeric && !isExplicitCategoricalName) return "number";

  // Check date
  const isDate = samples.every((s) => {
    if (s.length < 8) return false;
    const t = Date.parse(s);
    return !Number.isNaN(t);
  });
  if (isDate && !isExplicitCategoricalName) return "date";

  if (isExplicitCategoricalName || cardinality <= VOCABULARY_LIMITS.categoricalCardinalityThreshold) {
    return "categorical";
  }

  return "string";
}

export class DatasetVocabularyService {
  constructor(
    private readonly d: {
      bulk: BacklogBulkRepository;
      items: BacklogItemRepository;
      projects: ProjectRepository;
      contextLayer?: ContextLayerService;
    },
  ) {}

  /**
   * Discovers the schema, field vocabulary, and distinct values for an active imported CSV dataset.
   */
  discoverImportVocabulary(projectId: string, importId: string, actorId: string): DatasetVocabulary {
    assertProjectAccess(this.d.projects, projectId, actorId);

    const imp = this.d.bulk.findImport(importId);
    if (!imp || imp.projectId !== projectId) {
      throw new InvalidRequestError(`Import not found: ${importId}`);
    }

    const items = this.d.items.listByImport(importId);
    return extractVocabularyFromItems(imp, items);
  }

  /**
   * Discovers the schema and vocabulary for CodeForge Tasks in the specified project.
   */
  discoverTaskVocabulary(projectId: string, actorId: string): TaskDatasetVocabulary {
    assertProjectAccess(this.d.projects, projectId, actorId);

    let counts: Record<string, number> = {};
    let totalTasks = 0;

    if (this.d.contextLayer) {
      const summary = this.d.contextLayer.getTaskSummary(projectId, actorId);
      counts = summary.counts;
      totalTasks = summary.total;
    }

    const statusDistinct: DistinctValueCount[] = ALL_TASK_STATUSES.map((status) => ({
      rawValue: status,
      normalizedValue: normalizeValueForMatching(status),
      count: counts[status] ?? 0,
    }));

    const fields: FieldVocabulary[] = [
      {
        name: "status",
        displayName: "Task Status",
        type: "categorical",
        isCategorical: true,
        nonEmptyCount: totalTasks,
        emptyCount: 0,
        distinctValues: statusDistinct,
        hasMoreDistinctValues: false,
        totalDistinctCount: statusDistinct.length,
      },
      {
        name: "title",
        displayName: "Title",
        type: "string",
        isCategorical: false,
        nonEmptyCount: totalTasks,
        emptyCount: 0,
        distinctValues: [],
        hasMoreDistinctValues: false,
        totalDistinctCount: 0,
      },
      {
        name: "goal",
        displayName: "Goal / Description",
        type: "string",
        isCategorical: false,
        nonEmptyCount: totalTasks,
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
        nonEmptyCount: totalTasks,
        emptyCount: 0,
        distinctValues: [],
        hasMoreDistinctValues: false,
        totalDistinctCount: 0,
      },
    ];

    return {
      source: "CODEFORGE_TASKS",
      projectId,
      totalTasks,
      fields,
    };
  }
}

/**
 * Pure extractor function to enable isolated unit testing without SQLite repositories.
 */
export function extractVocabularyFromItems(
  imp: Pick<BacklogImportRecord, "id" | "projectId" | "sourceName" | "contentHash" | "totalRows" | "mapping">,
  items: BacklogItem[],
): DatasetVocabulary {
  // Collect all field names across the items
  const fieldValuesMap = new Map<string, string[]>();
  const addValue = (fieldName: string, value: string | undefined | null) => {
    let list = fieldValuesMap.get(fieldName);
    if (!list) {
      list = [];
      fieldValuesMap.set(fieldName, list);
    }
    list.push(value ?? "");
  };

  // Inspect standard fields and metadata columns
  for (const item of items) {
    if (item.externalRef) addValue("externalRef", item.externalRef);
    if (item.title) addValue("title", item.title);
    if (item.description) addValue("description", item.description);

    const meta = item.metadata ?? {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === "sourceName") continue; // internal provenance
      addValue(k, v);
    }
  }

  // Derive canonical field mappings
  const rawMapping = (imp.mapping as { fields?: Record<string, string> } | undefined)?.fields ?? {};
  const canonicalFields: DatasetVocabulary["canonicalFields"] = {};

  if (rawMapping.status || fieldValuesMap.has("status")) canonicalFields.statusField = "status";
  if (rawMapping.priority || fieldValuesMap.has("priority")) canonicalFields.priorityField = "priority";
  if (rawMapping.module || fieldValuesMap.has("module")) canonicalFields.moduleField = "module";
  if (rawMapping.severity || fieldValuesMap.has("severity")) canonicalFields.severityField = "severity";
  if (rawMapping.title || fieldValuesMap.has("title")) canonicalFields.titleField = "title";
  if (rawMapping.bugId || fieldValuesMap.has("bugId") || fieldValuesMap.has("externalRef")) canonicalFields.idField = "bugId";

  // Build FieldVocabulary for each field, up to limit
  const allFieldNames = Array.from(fieldValuesMap.keys()).slice(0, VOCABULARY_LIMITS.maxFields);
  const fields: FieldVocabulary[] = [];

  for (const name of allFieldNames) {
    const values = fieldValuesMap.get(name) ?? [];
    let emptyCount = 0;
    const valueCounts = new Map<string, { rawValue: string; count: number }>();
    const nonEmpties: string[] = [];

    for (const raw of values) {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) {
        emptyCount++;
        continue;
      }
      nonEmpties.push(trimmed);

      // Truncate display representation if overly long
      const displayVal = trimmed.length > VOCABULARY_LIMITS.maxValueDisplayLength
        ? `${trimmed.slice(0, VOCABULARY_LIMITS.maxValueDisplayLength)}…`
        : trimmed;

      const norm = normalizeValueForMatching(displayVal);
      const existing = valueCounts.get(norm);
      if (existing) {
        existing.count++;
      } else {
        valueCounts.set(norm, { rawValue: displayVal, count: 1 });
      }
    }

    const totalDistinctCount = valueCounts.size;
    const inferredType = inferType(nonEmpties, name, totalDistinctCount);
    const isCategorical = inferredType === "categorical" || inferredType === "boolean";

    // Sort distinct values by frequency descending, then alphabetical
    const sortedEntries = Array.from(valueCounts.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.rawValue.localeCompare(b.rawValue);
    });

    const hasMore = sortedEntries.length > VOCABULARY_LIMITS.maxDistinctValuesPerField;
    const boundedValues: DistinctValueCount[] = sortedEntries
      .slice(0, VOCABULARY_LIMITS.maxDistinctValuesPerField)
      .map((entry) => ({
        rawValue: entry.rawValue,
        normalizedValue: normalizeValueForMatching(entry.rawValue),
        count: entry.count,
      }));

    fields.push({
      name,
      displayName: rawMapping[name] ?? name,
      type: inferredType,
      isCategorical,
      nonEmptyCount: nonEmpties.length,
      emptyCount,
      distinctValues: boundedValues,
      hasMoreDistinctValues: hasMore,
      totalDistinctCount,
    });
  }

  return {
    source: "IMPORTED_DATASET",
    projectId: imp.projectId,
    importId: imp.id,
    sourceName: imp.sourceName,
    contentHash: imp.contentHash,
    totalRows: imp.totalRows,
    fields,
    canonicalFields,
  };
}
