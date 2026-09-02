import type { TaskEventDTO } from "../api/index.js";

/**
 * Extracts a short, human-readable detail line from a TaskEvent's own payload — see
 * /docs/UI_ARCHITECTURE.md "Activity timeline". Every event type already carries structured,
 * non-secret data (see src/api/dto.ts's toTaskEventDTO on the backend); this only decides how to
 * *render* it, never fabricates anything. Returns null when there's nothing meaningful to add
 * beyond the event's own label.
 */
export function detailForEvent(event: TaskEventDTO): string | null {
  const p = event.payload;
  switch (event.type) {
    case "AGENT_STARTED":
      return describeRoleAttempt(p);
    case "AGENT_COMPLETED":
      return joinParts([describeRoleAttempt(p), typeof p.status === "string" ? `result: ${p.status}` : null]);
    case "AGENT_FAILED":
      return joinParts([describeRoleAttempt(p), typeof p.error === "string" ? truncate(p.error) : null]);
    case "VALIDATION_COMPLETED": {
      const checks = Array.isArray(p.checks) ? (p.checks as Array<{ name?: unknown; passed?: unknown }>) : [];
      if (checks.length === 0) return "no checks declared";
      const passed = checks.filter((c) => c.passed === true).length;
      return `${passed}/${checks.length} checks passed`;
    }
    case "REVIEW_STARTED":
      return typeof p.attemptNumber === "number" ? `attempt ${p.attemptNumber}` : null;
    case "REVIEW_COMPLETED": {
      const verdict = typeof p.verdict === "string" ? p.verdict : null;
      const findingCount = Array.isArray(p.findings) ? p.findings.length : 0;
      return joinParts([verdict ? `verdict: ${verdict}` : null, findingCount ? `${findingCount} finding${findingCount === 1 ? "" : "s"}` : null]);
    }
    case "REVIEW_CHANGES_REQUESTED": {
      const findingCount = Array.isArray(p.findings) ? p.findings.length : 0;
      return findingCount ? `${findingCount} finding${findingCount === 1 ? "" : "s"}` : null;
    }
    case "RETRY_STARTED":
      return typeof p.nextAttempt === "number" ? `next attempt ${p.nextAttempt}` : null;
    case "HUMAN_REVIEW_DETECTED":
      return typeof p.newItemCount === "number" ? `${p.newItemCount} new item${p.newItemCount === 1 ? "" : "s"} found` : null;
    case "HUMAN_REVIEW_CHANGES_REQUESTED":
    case "HUMAN_REVIEW_APPROVED":
      return typeof p.reviewer === "string" ? `by ${p.reviewer}` : null;
    case "COMMIT_CREATED":
      return typeof p.commitSha === "string" ? p.commitSha.slice(0, 7) : null;
    case "BRANCH_PUSHED":
    case "BRANCH_CREATED":
      return typeof p.branch === "string" ? p.branch : null;
    case "PULL_REQUEST_CREATED":
      return typeof p.number === "number" ? `#${p.number}` : typeof p.url === "string" ? p.url : null;
    case "TASK_FAILED":
      return typeof p.error === "string" ? truncate(p.error) : null;
    case "TASK_CANCELLED":
    case "CANCEL_REQUESTED":
    case "EXECUTION_CANCELLED":
      return typeof p.requestedBy === "string" ? `requested by ${p.requestedBy}` : null;
    case "WORKSPACE_FAILED":
    case "SOURCE_CONTROL_FAILED":
      return typeof p.error === "string" ? truncate(p.error) : null;
    default:
      return null;
  }
}

function describeRoleAttempt(payload: Record<string, unknown>): string | null {
  const role = typeof payload.role === "string" ? roleLabel(payload.role) : null;
  const attempt = typeof payload.attemptNumber === "number" ? `attempt ${payload.attemptNumber}` : null;
  return joinParts([role, attempt]);
}

function roleLabel(role: string): string {
  return role === "implementer" ? "Implementer" : role === "reviewer" ? "Reviewer" : role;
}

function joinParts(parts: Array<string | null>): string | null {
  const present = parts.filter((p): p is string => Boolean(p));
  return present.length ? present.join(" · ") : null;
}

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
