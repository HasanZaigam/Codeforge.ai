/**
 * Classifies a failed coding-engine child-process invocation as retryable or
 * not, from whatever the process printed. Exists specifically because
 * OpenCode exits non-zero for both transient provider outages (Gemini/OpenAI
 * 503, 429 — should be retried) and permanent failures (bad API key, invalid
 * model, malformed request — must not be retried). See
 * /docs/CODING_ENGINE.md "Retry behavior".
 *
 * Deliberately conservative (see Step 9 instructions, point O): anything
 * that doesn't look like a recognized transient-provider error is treated as
 * NOT retryable. Blindly retrying every exit code 1 would turn genuine bugs
 * (bad prompts, tool errors, auth failures) into slow, repeated failures
 * instead of fast, clear ones.
 */

export type FailureCategory = "rate_limit" | "server_unavailable" | "auth" | "invalid_request" | "unknown";

export interface EngineFailureClassification {
  retryable: boolean;
  category: FailureCategory;
  /** Human-readable reason, safe to put in a TaskEvent/error message — never contains secrets. */
  reason: string;
  statusCode: number | null;
  /**
   * The provider's own suggested wait time, if it told us one (e.g. Gemini's
   * "Please retry in 48.88s." on quota-exhaustion 429s) — parsed from the
   * message text since OpenCode doesn't currently surface a structured
   * `Retry-After` field. `null` when no such hint is present, in which case
   * the caller falls back to plain exponential backoff. Real-world evidence
   * (see /docs/CODING_ENGINE.md "Retry behavior"): a free-tier Gemini quota
   * 429 explicitly asks for a 10-50s wait — retrying on our own much shorter
   * default backoff just re-hits the same still-exhausted quota every time.
   */
  suggestedDelayMs: number | null;
}

interface StructuredErrorRecord {
  type?: unknown;
  error?: {
    name?: unknown;
    data?: {
      message?: unknown;
      statusCode?: unknown;
      isRetryable?: unknown;
      /**
       * OpenCode's real (observed live) shape sends this as a JSON-encoded
       * STRING — e.g. `"{\n  \"error\": {\"status\": \"UNAVAILABLE\", ...}\n}"`
       * — not a pre-parsed object. Handle both: see extractResponseBodyError().
       */
      responseBody?: unknown;
      metadata?: { url?: unknown };
    };
  };
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const AUTH_STATUS_CODES = new Set([401, 403]);

const AUTH_PATTERN = /invalid[_ ]?api[_ ]?key|unauthorized|authentication|permission denied|forbidden/i;
const INVALID_REQUEST_PATTERN = /invalid model|model not found|malformed|bad request|unsupported/i;

/**
 * Scans an OpenCode process's combined stdout for a structured
 * `{type:"error", error:{...}}` record (NDJSON, one per line) and classifies
 * it. Falls back to a generic, non-retryable "unknown" classification with
 * the raw exit code + truncated output when no structured error is found —
 * preserving the previous behavior for engines/output that predate this.
 */
export function classifyEngineFailure(stdout: string, stderr: string, exitCode: number | null): EngineFailureClassification {
  const structured = findStructuredError(stdout) ?? findStructuredError(stderr);

  if (!structured) {
    const detail = stderr.slice(-2000) || stdout.slice(-2000) || `exit code ${exitCode}`;
    return {
      retryable: false,
      category: "unknown",
      reason: `exit code ${exitCode}: ${detail}`,
      statusCode: null,
      suggestedDelayMs: null,
    };
  }

  const { error } = structured;
  const data = error?.error?.data;
  const statusCode = typeof data?.statusCode === "number" ? data.statusCode : null;
  const isRetryableFlag = data?.isRetryable === true;
  const responseBodyError = extractResponseBodyError(data?.responseBody);
  const message = typeof data?.message === "string" ? data.message : typeof responseBodyError?.message === "string" ? responseBodyError.message : "";
  const statusText = typeof responseBodyError?.status === "string" ? responseBodyError.status : null;
  const providerName = inferProviderName(typeof data?.metadata?.url === "string" ? data.metadata.url : null);
  const errorName = typeof error?.error?.name === "string" ? error.error.name : "APIError";

  const category = classifyCategory({ statusCode, message, errorName });
  const retryable = isRetryableFlag || (category !== "auth" && category !== "invalid_request" && statusCode !== null && RETRYABLE_STATUS_CODES.has(statusCode));

  const statusPart = statusCode !== null ? `HTTP ${statusCode}${statusText ? ` ${statusText}` : ""}` : errorName;
  const reason = `${providerName} returned ${retryable ? "retryable " : ""}${statusPart}${message ? `: ${message}` : ""}`;
  const suggestedDelayMs = parseSuggestedDelayMs(message);

  return { retryable, category, reason, statusCode, suggestedDelayMs };
}

/**
 * Parses a provider's own suggested retry delay out of its error message
 * text, e.g. Gemini's "Please retry in 48.883053394s." or a more generic
 * "retry after 30 seconds" / "retry-after: 30". Returns null (not 0) when no
 * such hint is found — callers must not treat "not found" as "retry now."
 */
function parseSuggestedDelayMs(message: string): number | null {
  const match = message.match(/retry[- ]?(?:in|after)[:\s]+(\d+(?:\.\d+)?)\s*s(?:econds?)?\b/i);
  if (!match || !match[1]) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

function classifyCategory(input: { statusCode: number | null; message: string; errorName: string }): FailureCategory {
  const { statusCode, message, errorName } = input;
  const haystack = `${errorName} ${message}`;

  if (statusCode !== null && AUTH_STATUS_CODES.has(statusCode)) return "auth";
  if (AUTH_PATTERN.test(haystack)) return "auth";

  if (statusCode === 400 || INVALID_REQUEST_PATTERN.test(haystack)) return "invalid_request";

  if (statusCode === 429) return "rate_limit";
  if (statusCode !== null && RETRYABLE_STATUS_CODES.has(statusCode)) return "server_unavailable";

  return "unknown";
}

/**
 * `error.data.responseBody` varies by provider/OpenCode version: sometimes
 * an already-parsed object, but the real Gemini/OpenCode payload observed in
 * production sends it as a JSON-encoded STRING (the raw HTTP response body,
 * unparsed). Handles both without throwing on a malformed/non-JSON string.
 */
function extractResponseBodyError(responseBody: unknown): { status?: unknown; message?: unknown; code?: unknown } | null {
  let body: unknown = responseBody;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === "object") return err as { status?: unknown; message?: unknown; code?: unknown };
  }
  return null;
}

function findStructuredError(text: string): { error: StructuredErrorRecord } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && (parsed as StructuredErrorRecord).type === "error" && (parsed as StructuredErrorRecord).error) {
      return { error: parsed as StructuredErrorRecord };
    }
  }
  return null;
}

/** Friendly provider name for the error message, inferred from the failing request's URL — never guessed beyond well-known hosts. */
function inferProviderName(url: string | null): string {
  if (!url) return "The model provider";
  try {
    const host = new URL(url).hostname;
    if (host.includes("generativelanguage.googleapis.com")) return "Gemini";
    if (host.includes("api.anthropic.com")) return "Anthropic";
    if (host.includes("api.openai.com")) return "OpenAI";
    if (host.includes("openrouter.ai")) return "OpenRouter";
    return host;
  } catch {
    return "The model provider";
  }
}
