import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEngineFailure } from "../src/coding-engine/engine-failure-classifier.js";

/**
 * `classifyEngineFailure` unit tests. The "real (live-captured)" cases below
 * use the EXACT NDJSON line format observed from a genuine
 * `opencode run --format json --auto` invocation against live Gemini in
 * this repo's own `.data/platform.sqlite` (task 703b57b4..., 2026-08-31) —
 * not a hypothetical shape. See /docs/CODING_ENGINE.md "Retry behavior".
 */

test("real (live-captured) Gemini 503: responseBody is a JSON-encoded STRING, not an object — still classified retryable with the UNAVAILABLE status text extracted", () => {
  // Exact shape as actually emitted by OpenCode 1.18.25 against live Gemini — note responseBody
  // is a *string* containing escaped JSON, and there's an extra `responseHeaders` field that
  // must be ignored gracefully, not crash the parser.
  const line = JSON.stringify({
    type: "error",
    timestamp: 1788198874244,
    sessionID: "ses_fa70cb927ffebPwOABetXcJ8f8",
    error: {
      name: "APIError",
      data: {
        message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
        statusCode: 503,
        isRetryable: true,
        responseHeaders: { "content-type": "text/event-stream" },
        responseBody: '{\n  "error": {\n    "code": 503,\n    "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",\n    "status": "UNAVAILABLE"\n  }\n}\n',
        metadata: { url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse" },
      },
    },
  });

  const result = classifyEngineFailure(line, "", 1);

  assert.equal(result.retryable, true);
  assert.equal(result.category, "server_unavailable");
  assert.equal(result.statusCode, 503);
  assert.ok(result.reason.includes("Gemini"), result.reason);
  assert.ok(result.reason.includes("UNAVAILABLE"), `expected the string-encoded responseBody's status to be extracted: ${result.reason}`);
  assert.ok(result.reason.includes("This model is currently experiencing high demand"), result.reason);
});

test("responseBody as an already-parsed object (alternate provider shape) is also handled", () => {
  const line = JSON.stringify({
    type: "error",
    error: {
      name: "APIError",
      data: {
        message: "high demand",
        statusCode: 503,
        isRetryable: true,
        responseBody: { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } },
        metadata: { url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview" },
      },
    },
  });

  const result = classifyEngineFailure(line, "", 1);
  assert.equal(result.retryable, true);
  assert.ok(result.reason.includes("UNAVAILABLE"));
});

test("a malformed/non-JSON responseBody string never throws — falls back gracefully", () => {
  const line = JSON.stringify({
    type: "error",
    error: { name: "APIError", data: { message: "oops", statusCode: 503, isRetryable: true, responseBody: "not json at all {{{" } },
  });

  const result = classifyEngineFailure(line, "", 1);
  assert.equal(result.retryable, true, "classification must not crash or silently drop retryability just because responseBody didn't parse");
  assert.equal(result.category, "server_unavailable");
});

test("429 rate limit is retryable", () => {
  const line = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "slow down", statusCode: 429, isRetryable: true } } });
  const result = classifyEngineFailure(line, "", 1);
  assert.equal(result.retryable, true);
  assert.equal(result.category, "rate_limit");
});

test("401 invalid API key is NOT retryable even without an explicit isRetryable flag", () => {
  const line = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Invalid API key provided", statusCode: 401 } } });
  const result = classifyEngineFailure(line, "", 1);
  assert.equal(result.retryable, false);
  assert.equal(result.category, "auth");
});

test("400 invalid model is NOT retryable", () => {
  const line = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Invalid model specified", statusCode: 400 } } });
  const result = classifyEngineFailure(line, "", 1);
  assert.equal(result.retryable, false);
  assert.equal(result.category, "invalid_request");
});

test("no structured error at all: falls back to raw exit-code text, non-retryable (preserves pre-fix behavior)", () => {
  const result = classifyEngineFailure("", "some crash trace", 1);
  assert.equal(result.retryable, false);
  assert.equal(result.category, "unknown");
  assert.ok(result.reason.includes("exit code 1"));
  assert.ok(result.reason.includes("some crash trace"));
});

test("real (live-captured) Gemini free-tier 429 quota exhaustion: parses the provider's own suggested wait time out of the message", () => {
  // Exact message text as actually returned by live Gemini when captured during a real e2e
  // verification run (2026-08-31) — see /docs/CODING_ENGINE.md "Retry behavior".
  const message =
    "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: " +
    "https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n" +
    "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash\n" +
    "Please retry in 48.883053394s.";
  const line = JSON.stringify({ type: "error", error: { name: "APIError", data: { message, statusCode: 429, isRetryable: true } } });

  const result = classifyEngineFailure(line, "", 1);

  assert.equal(result.retryable, true);
  assert.equal(result.category, "rate_limit");
  assert.equal(result.suggestedDelayMs, 48884, "48.883053394s rounded up to the millisecond");
});

test("no suggested-delay hint in the message: suggestedDelayMs is null, not 0 (0 would wrongly mean 'retry immediately')", () => {
  const line = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "high demand", statusCode: 503, isRetryable: true } } });
  const result = classifyEngineFailure(line, "", 1);
  assert.equal(result.suggestedDelayMs, null);
});

test("a structured error record mixed in among other NDJSON event types (step_finish, etc.) is still found", () => {
  const stream = [
    JSON.stringify({ type: "step_start", sessionID: "s1" }),
    JSON.stringify({ type: "step_finish", tokens: { total: 100 }, cost: 0.01 }),
    JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "high demand", statusCode: 503, isRetryable: true } } }),
  ].join("\n");

  const result = classifyEngineFailure(stream, "", 1);
  assert.equal(result.retryable, true);
  assert.equal(result.category, "server_unavailable");
});
