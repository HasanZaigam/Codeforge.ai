import type { TaskStatus } from "../api/index.js";

export interface StatusMeta {
  label: string;
  /** CSS custom-property name used by StatusBadge/board columns — see index.css. */
  tone: "neutral" | "active" | "attention" | "info" | "success" | "danger" | "cancelled";
}

/**
 * Single place mapping a backend TaskStatus to how it's labeled and colored
 * in the UI. The frontend never infers or overrides status — it only
 * decides how to *display* a status the API already gave it. See
 * /docs/TASK_LIFECYCLE.md — REVIEW does not mean "definitely correct," so
 * its label/description stays honest about that.
 */
export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  TODO: { label: "To do", tone: "neutral" },
  WORKING: { label: "Working", tone: "active" },
  NEEDS_INPUT: { label: "Needs input", tone: "attention" },
  REVIEW: { label: "Review", tone: "info" },
  DONE: { label: "Done", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  // Deliberately not "danger": cancellation is a developer decision, not a failure — see
  // /docs/TASK_LIFECYCLE.md "Cancellation" and Step 4/5 instructions ("do not show misleading
  // failed language").
  CANCELLED: { label: "Cancelled", tone: "cancelled" },
};

export const BOARD_COLUMNS: TaskStatus[] = ["TODO", "WORKING", "NEEDS_INPUT", "REVIEW", "DONE"];

/**
 * Statuses shown only as an extra, conditional column when at least one task
 * actually has them — keeps the common-case board at exactly five columns.
 * See /docs/UI_ARCHITECTURE.md "Responsive strategy" (FAILED) and
 * TECHNICAL_DECISIONS.md TD-25 (CANCELLED, same treatment).
 */
export const CONDITIONAL_BOARD_COLUMNS: TaskStatus[] = ["FAILED", "CANCELLED"];
