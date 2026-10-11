import { createHash } from "node:crypto";

/**
 * Phase 4B — the bulk-import boundary. PURE and deterministic: it turns CSV text into normalized source rows and nothing else —
 * no model, no repository, no filesystem, no network. Every row is either ACCEPTED (with a stable source identity) or REJECTED with a
 * deterministic reason; nothing is silently dropped and nothing is invented. Imported text is DATA: it is never interpreted,
 * never executed, and `=`/`+`/`-`/`@`-leading values are flagged (formula injection) rather than trusted.
 */

export const IMPORT_LIMITS = {
  maxBytes: 500_000, // CSV text; JSON-escaped it must still fit the API's 1 MB body limit
  maxRows: 500,
  maxColumns: 40,
  maxTitle: 300,
  maxField: 4_000, // each of steps / expected / actual / description
  maxDescription: 9_500, // the composed description (item limit is 10 000)
  maxMeta: 300,
  maxHeader: 60,
} as const;

export type CanonicalField = "bugId" | "title" | "description" | "steps" | "expected" | "actual" | "severity" | "priority" | "module" | "platform" | "environment" | "reporter" | "status";

/** Header aliases (normalised: lowercase letters/digits only). Includes the misspellings real QA sheets contain ("Actual Ressult"). */
const ALIASES: Record<CanonicalField, string[]> = {
  bugId: ["bugid", "issuekey", "bugidno", "issueid", "ticketid", "ticket", "key", "id", "bugnumber", "bugno", "srno", "sno", "slno", "reference", "ref"],
  title: ["bugtitle", "title", "summary", "issuesummary", "bugsummary", "issuetitle", "bugname", "name", "issue", "subject", "feedback"],
  description: ["description", "bugdescription", "issuedescription", "details", "bugdetails"],
  steps: ["steptoreproduce", "stepstoreproduce", "steps", "reproductionsteps", "reprosteps", "stepstoreproducebug", "repro"],
  expected: ["expectedresult", "expected", "expectedbehavior", "expectedbehaviour"],
  actual: ["actualresult", "actualressult", "actual", "actualbehavior", "actualbehaviour", "observedresult"],
  severity: ["severity"],
  priority: ["priority"],
  module: ["module", "component", "area", "feature", "screen", "application", "app"],
  platform: ["platform", "os", "device"],
  environment: ["environment", "env", "build", "version"],
  reporter: ["reporter", "reportedby", "tester", "assignedby", "createdby", "raisedby"],
  status: ["status", "state", "bugstatus", "devstatus", "dev-status", "dev_status", "developmentstatus", "development-status", "development_status"],
};

const norm = (h: string) => h.replace(/^\uFEFF/, "").trim().normalize("NFC").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface CsvParseResult {
  headers: string[];
  rows: Array<{ rowNumber: number; cells: string[] }>;
  errors: string[];
}

/** RFC-4180-style parsing (quoted fields, embedded newlines, doubled quotes, CRLF, BOM). Bounded; a violation is an error, never a crash. */
export function parseCsv(text: string): CsvParseResult {
  const out: CsvParseResult = { headers: [], rows: [], errors: [] };
  if (Buffer.byteLength(text, "utf8") > IMPORT_LIMITS.maxBytes) {
    out.errors.push(`The file is larger than ${IMPORT_LIMITS.maxBytes} bytes.`);
    return out;
  }
  const src = text.replace(/^\uFEFF/, "");
  const records: Array<{ cells: string[]; line: number }> = [];
  let cell = "";
  let cells: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0]!.trim() === "")) records.push({ cells, line: recordLine });
    cells = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === ",") endCell();
    else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else if (ch === "\n") {
      endRecord();
      line++;
      recordLine = line;
    } else cell += ch;
    i++;
    if (records.length > IMPORT_LIMITS.maxRows + 1) {
      out.errors.push(`More than ${IMPORT_LIMITS.maxRows} rows.`);
      return out;
    }
  }
  if (inQuotes) {
    out.errors.push("Malformed CSV: a quoted field is never closed.");
    return out;
  }
  if (cell !== "" || cells.length > 0) endRecord();
  if (records.length === 0) {
    out.errors.push("The file contains no rows.");
    return out;
  }
  out.headers = records[0]!.cells.map((h) => h.replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim());
  if (out.headers.length > IMPORT_LIMITS.maxColumns) {
    out.errors.push(`More than ${IMPORT_LIMITS.maxColumns} columns.`);
    return out;
  }
  out.rows = records.slice(1).map((r) => ({ rowNumber: r.line, cells: r.cells }));
  return out;
}

export interface ColumnMapping {
  /** canonical field → column index */
  fields: Partial<Record<CanonicalField, number>>;
  /** Columns kept as bounded, inert metadata (header → index). */
  metadata: Array<{ header: string; index: number }>;
  /** Columns with no header (dropped, reported). */
  unnamed: number[];
}

export function detectMapping(headers: string[], override?: Partial<Record<CanonicalField, string>>): ColumnMapping {
  const fields: ColumnMapping["fields"] = {};
  const used = new Set<number>();
  const taken = (f: CanonicalField, idx: number) => {
    fields[f] = idx;
    used.add(idx);
  };
  const normalized = headers.map(norm);

  // 1. Explicit override mapping
  for (const [field, header] of Object.entries(override ?? {}) as Array<[CanonicalField, string]>) {
    const idx = normalized.indexOf(norm(header));
    if (idx >= 0 && !used.has(idx)) taken(field, idx);
  }

  // 2. Alias preference order mapping
  for (const field of Object.keys(ALIASES) as CanonicalField[]) {
    if (fields[field] !== undefined) continue;
    for (const rawAlias of ALIASES[field]) {
      const aliasNorm = norm(rawAlias);
      const idx = normalized.findIndex((h, k) => !used.has(k) && h === aliasNorm);
      if (idx >= 0) {
        taken(field, idx);
        break;
      }
    }
  }

  const metadata: ColumnMapping["metadata"] = [];
  const unnamed: number[] = [];
  headers.forEach((h, index) => {
    if (used.has(index)) return;
    if (h === "") unnamed.push(index);
    else if (h.length <= IMPORT_LIMITS.maxHeader) metadata.push({ header: h, index });
  });
  return { fields, metadata, unnamed };
}

export type RowStatus = "ACCEPTED" | "REJECTED";
export type RejectReason =
  | "missing_title"
  | "missing_description"
  | "invalid_bug_id"
  | "duplicate_source_row"
  | "title_too_long"
  | "field_too_long"
  | "malformed_row";

export interface NormalizedRow {
  rowNumber: number;
  status: RowStatus;
  reason: RejectReason | null;
  detail: string | null;
  /** Stable source identity within this source: the normalised bug id, else a content hash. */
  sourceKey: string | null;
  bugId: string | null;
  title: string | null;
  description: string | null;
  fields: Partial<Record<CanonicalField, string>>;
  metadata: Record<string, string>;
  warnings: string[];
}

export interface ImportPreview {
  headers: string[];
  mapping: { fields: Partial<Record<CanonicalField, string>>; metadataColumns: string[]; unnamedColumns: number };
  missingRecommended: CanonicalField[];
  rows: NormalizedRow[];
  totalRows: number;
  accepted: number;
  rejected: number;
  warnings: string[];
  errors: string[];
}

const FORMULA = /^[=+\-@]/;
const SHEET_ERROR = /^#(?:VALUE|REF|N\/A|NAME|DIV\/0|NUM|NULL)[!?]?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const clean = (v: string | undefined): string => (v ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Slug of a source name, used as the namespace of its source keys ("OTT Bug Report — Application" → "ott-bug-report-application"). */
export function sourceSlug(sourceName: string): string {
  return sourceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 22).replace(/-+$/, "") || "import";
}

/** The reference an accepted row's BacklogItem carries: `<source-slug>:<bug id>` — stable across re-imports of the same source. */
export function externalRefFor(sourceName: string, sourceKey: string): string {
  return `${sourceSlug(sourceName)}:${sourceKey}`;
}

export function normalizeBugId(raw: string): string | null {
  const id = raw.replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9._#-]{0,38}$/.test(id) ? id : null;
}

export function buildPreview(text: string, options: { mapping?: Partial<Record<CanonicalField, string>> } = {}): ImportPreview {
  const parsed = parseCsv(text);
  const empty: ImportPreview = { headers: parsed.headers, mapping: { fields: {}, metadataColumns: [], unnamedColumns: 0 }, missingRecommended: [], rows: [], totalRows: 0, accepted: 0, rejected: 0, warnings: [], errors: parsed.errors };
  if (parsed.errors.length > 0) return empty;

  const mapping = detectMapping(parsed.headers, options.mapping);
  const warnings: string[] = [];
  const errors: string[] = [];
  if (mapping.fields.title === undefined) errors.push("No title column was found (expected e.g. “Bug title”, “Title”, “Summary”).");
  if (mapping.fields.description === undefined && mapping.fields.steps === undefined && mapping.fields.expected === undefined && mapping.fields.actual === undefined) {
    errors.push("No description column was found (expected “Description”, or “Step to Reproduce” / “Expected Result” / “Actual Result”).");
  }
  if (mapping.unnamed.length > 0) warnings.push(`${mapping.unnamed.length} column(s) without a header were ignored.`);
  const missingRecommended = (["bugId"] as CanonicalField[]).filter((f) => mapping.fields[f] === undefined);
  if (missingRecommended.length > 0) warnings.push("No bug-id column was found: rows are identified by a hash of their content.");

  const headerOf = (f: CanonicalField) => (mapping.fields[f] === undefined ? undefined : parsed.headers[mapping.fields[f]!]);
  const mappingOut: ImportPreview["mapping"] = {
    fields: Object.fromEntries((Object.keys(mapping.fields) as CanonicalField[]).map((f) => [f, headerOf(f)!])) as ImportPreview["mapping"]["fields"],
    metadataColumns: mapping.metadata.map((m) => m.header),
    unnamedColumns: mapping.unnamed.length,
  };
  if (errors.length > 0) return { ...empty, mapping: mappingOut, missingRecommended, warnings, errors };

  const seen = new Set<string>();
  const rows: NormalizedRow[] = parsed.rows.map((r) => {
    const row: NormalizedRow = { rowNumber: r.rowNumber, status: "ACCEPTED", reason: null, detail: null, sourceKey: null, bugId: null, title: null, description: null, fields: {}, metadata: {}, warnings: [] };
    const reject = (reason: RejectReason, detail: string): NormalizedRow => ({ ...row, status: "REJECTED", reason, detail });
    if (r.cells.length > parsed.headers.length) {
      // Spreadsheet exports often carry a stray formula-error cell (#VALUE!) past the last header: that is noise, not data.
      const extras = r.cells.slice(parsed.headers.length).map((c) => c.trim());
      if (!extras.every((c) => c === "" || SHEET_ERROR.test(c))) return reject("malformed_row", `The row has ${r.cells.length} cells but the header has ${parsed.headers.length}.`);
      row.warnings.push(`${extras.filter((c) => c !== "").length} trailing spreadsheet error cell(s) past the last header were ignored.`);
    }
    const get = (f: CanonicalField) => (mapping.fields[f] === undefined ? "" : clean(r.cells[mapping.fields[f]!]));
    for (const f of Object.keys(mapping.fields) as CanonicalField[]) {
      const v = get(f);
      if (v !== "") row.fields[f] = v;
      if (v !== "" && FORMULA.test(v)) row.warnings.push(`“${headerOf(f)}” starts with “${v[0]}” (formula-like); it is stored as inert text.`);
    }
    for (const m of mapping.metadata) {
      const v = clean(r.cells[m.index]);
      if (v === "") continue;
      if (v.length > IMPORT_LIMITS.maxMeta) row.warnings.push(`Column “${m.header}” exceeds ${IMPORT_LIMITS.maxMeta} characters and was not kept.`);
      else row.metadata[m.header] = v;
    }
    const title = row.fields.title ?? "";
    if (title === "") return reject("missing_title", "The title is empty.");
    if (title.length > IMPORT_LIMITS.maxTitle) return reject("title_too_long", `The title exceeds ${IMPORT_LIMITS.maxTitle} characters.`);
    for (const f of ["description", "steps", "expected", "actual"] as const) {
      if ((row.fields[f] ?? "").length > IMPORT_LIMITS.maxField) return reject("field_too_long", `“${headerOf(f)}” exceeds ${IMPORT_LIMITS.maxField} characters.`);
    }
    const sections: string[] = [];
    if (row.fields.description) sections.push(row.fields.description);
    if (row.fields.steps) sections.push(`Steps to reproduce:\n${row.fields.steps}`);
    if (row.fields.expected) sections.push(`Expected result:\n${row.fields.expected}`);
    if (row.fields.actual) sections.push(`Actual result:\n${row.fields.actual}`);
    const description = sections.join("\n\n");
    if (description === "") return reject("missing_description", "The row has no description, steps, expected or actual result.");
    if (description.length > IMPORT_LIMITS.maxDescription) return reject("field_too_long", `The combined description exceeds ${IMPORT_LIMITS.maxDescription} characters.`);

    let sourceKey: string;
    const rawId = get("bugId");
    if (rawId !== "") {
      const id = normalizeBugId(rawId);
      if (!id) return reject("invalid_bug_id", `“${rawId.slice(0, 40)}” is not a usable bug id.`);
      row.bugId = id;
      sourceKey = id;
    } else {
      sourceKey = `H-${createHash("sha256").update([title, description].join("\u0000")).digest("hex").slice(0, 12)}`;
    }
    if (seen.has(sourceKey.toLowerCase())) return reject("duplicate_source_row", `Source row ${sourceKey} appears more than once in this file.`);
    seen.add(sourceKey.toLowerCase());
    return { ...row, sourceKey, title, description };
  });

  return {
    headers: parsed.headers,
    mapping: mappingOut,
    missingRecommended,
    rows,
    totalRows: rows.length,
    accepted: rows.filter((r) => r.status === "ACCEPTED").length,
    rejected: rows.filter((r) => r.status === "REJECTED").length,
    warnings,
    errors,
  };
}

/** Escapes a value for CSV OUTPUT (reports): quotes, and defuses a leading formula character with a single quote. */
export function csvEscape(v: string): string {
  const safe = FORMULA.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
