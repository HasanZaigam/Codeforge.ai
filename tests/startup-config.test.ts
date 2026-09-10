import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ConfigError, isLocalGitProjectsAllowed, parseBooleanEnv, parsePositiveIntEnv, validateSharedConfig } from "../src/config/startup-config.js";

/**
 * Fail-fast startup configuration validation (src/config/startup-config.ts),
 * used by both entrypoints via env-platform.ts/api/server.ts/worker/run-
 * worker.ts. Every case here is exercised against the exported functions
 * directly with a synthetic env object — never against the real
 * process.env — so it can assert exact ConfigError messages without any
 * risk of leaking (or depending on) this process's own environment.
 */

test("validateSharedConfig: accepts every known CODING_ENGINE value, case-insensitively", () => {
  for (const value of ["opencode", "OpenCode", "claude-code", "claude", "fixture", "FIXTURE"]) {
    assert.doesNotThrow(() => validateSharedConfig({ CODING_ENGINE: value }));
  }
});

test("validateSharedConfig: defaults to opencode when CODING_ENGINE is unset", () => {
  assert.doesNotThrow(() => validateSharedConfig({}));
});

test("validateSharedConfig: rejects an unrecognized CODING_ENGINE with a clear, actionable message", () => {
  assert.throws(
    () => validateSharedConfig({ CODING_ENGINE: "gpt5-turbo" }),
    (err: unknown) => err instanceof ConfigError && /CODING_ENGINE="gpt5-turbo" is not recognized/.test(err.message),
  );
});

test("validateSharedConfig: refuses CODING_ENGINE=fixture together with NODE_ENV=production", () => {
  assert.throws(
    () => validateSharedConfig({ CODING_ENGINE: "fixture", NODE_ENV: "production" }),
    (err: unknown) => err instanceof ConfigError && /must never be set with NODE_ENV=production/.test(err.message),
  );
});

test("validateSharedConfig: fixture is fine outside production (unset or any other NODE_ENV)", () => {
  assert.doesNotThrow(() => validateSharedConfig({ CODING_ENGINE: "fixture" }));
  assert.doesNotThrow(() => validateSharedConfig({ CODING_ENGINE: "fixture", NODE_ENV: "development" }));
  assert.doesNotThrow(() => validateSharedConfig({ CODING_ENGINE: "fixture", NODE_ENV: "test" }));
});

test("validateSharedConfig: a real production CODING_ENGINE is fine with NODE_ENV=production", () => {
  assert.doesNotThrow(() => validateSharedConfig({ CODING_ENGINE: "opencode", NODE_ENV: "production" }));
});

test("validateSharedConfig: CREDENTIAL_ENCRYPTION_KEY is optional — unset is never an error", () => {
  assert.doesNotThrow(() => validateSharedConfig({}));
});

test("validateSharedConfig: accepts a well-formed (32-byte, base64) CREDENTIAL_ENCRYPTION_KEY", () => {
  const key = randomBytes(32).toString("base64");
  assert.doesNotThrow(() => validateSharedConfig({ CREDENTIAL_ENCRYPTION_KEY: key }));
});

test("validateSharedConfig: rejects a CREDENTIAL_ENCRYPTION_KEY that doesn't decode to 32 bytes, without ever including the key's value in the error", () => {
  const badKey = randomBytes(10).toString("base64");
  assert.throws(
    () => validateSharedConfig({ CREDENTIAL_ENCRYPTION_KEY: badKey }),
    (err: unknown) =>
      err instanceof ConfigError &&
      /does not decode to 32 bytes \(got 10\)/.test(err.message) &&
      !err.message.includes(badKey),
  );
});

test("parsePositiveIntEnv: returns the fallback when unset or blank", () => {
  assert.equal(parsePositiveIntEnv("PORT", undefined, 3000), 3000);
  assert.equal(parsePositiveIntEnv("PORT", "", 3000), 3000);
  assert.equal(parsePositiveIntEnv("PORT", "   ", 3000), 3000);
});

test("parsePositiveIntEnv: parses a valid positive integer string", () => {
  assert.equal(parsePositiveIntEnv("PORT", "8080", 3000), 8080);
});

test("parsePositiveIntEnv: rejects non-numeric, zero, negative, and non-integer values — never silently falling back to NaN or the default", () => {
  for (const bad of ["notanumber", "0", "-5", "3.5", "Infinity"]) {
    assert.throws(
      () => parsePositiveIntEnv("PORT", bad, 3000),
      (err: unknown) => err instanceof ConfigError && err.message.includes(`got "${bad}"`),
    );
  }
});

test("parseBooleanEnv: returns the fallback when unset or blank", () => {
  assert.equal(parseBooleanEnv("ALLOW_LOCAL_GIT_PROJECTS", undefined, false), false);
  assert.equal(parseBooleanEnv("ALLOW_LOCAL_GIT_PROJECTS", "", true), true);
  assert.equal(parseBooleanEnv("ALLOW_LOCAL_GIT_PROJECTS", "   ", false), false);
});

test("parseBooleanEnv: parses true/false case-insensitively, trimmed", () => {
  assert.equal(parseBooleanEnv("X", "true", false), true);
  assert.equal(parseBooleanEnv("X", "TRUE", false), true);
  assert.equal(parseBooleanEnv("X", "  True  ", false), true);
  assert.equal(parseBooleanEnv("X", "false", true), false);
  assert.equal(parseBooleanEnv("X", "FALSE", true), false);
});

test("parseBooleanEnv: rejects anything other than a clean true/false — never silently coerced", () => {
  for (const bad of ["yes", "1", "0", "no", "TRUE1"]) {
    assert.throws(
      () => parseBooleanEnv("ALLOW_LOCAL_GIT_PROJECTS", bad, false),
      (err: unknown) => err instanceof ConfigError && err.message.includes(`got "${bad}"`),
    );
  }
});

test("validateSharedConfig: rejects a malformed ALLOW_LOCAL_GIT_PROJECTS at startup regardless of NODE_ENV", () => {
  assert.throws(
    () => validateSharedConfig({ ALLOW_LOCAL_GIT_PROJECTS: "yes" }),
    (err: unknown) => err instanceof ConfigError && /ALLOW_LOCAL_GIT_PROJECTS must be "true" or "false"/.test(err.message),
  );
  assert.throws(
    () => validateSharedConfig({ ALLOW_LOCAL_GIT_PROJECTS: "yes", NODE_ENV: "development" }),
    (err: unknown) => err instanceof ConfigError,
  );
});

test("validateSharedConfig: a well-formed ALLOW_LOCAL_GIT_PROJECTS never throws, in any NODE_ENV", () => {
  assert.doesNotThrow(() => validateSharedConfig({ ALLOW_LOCAL_GIT_PROJECTS: "true" }));
  assert.doesNotThrow(() => validateSharedConfig({ ALLOW_LOCAL_GIT_PROJECTS: "false", NODE_ENV: "production" }));
});

test("isLocalGitProjectsAllowed: allowed by default outside production, regardless of the flag", () => {
  assert.equal(isLocalGitProjectsAllowed({}), true);
  assert.equal(isLocalGitProjectsAllowed({ NODE_ENV: "development" }), true);
  assert.equal(isLocalGitProjectsAllowed({ NODE_ENV: "test" }), true);
  assert.equal(isLocalGitProjectsAllowed({ NODE_ENV: "development", ALLOW_LOCAL_GIT_PROJECTS: "false" }), true);
});

test("isLocalGitProjectsAllowed: disabled by default in production", () => {
  assert.equal(isLocalGitProjectsAllowed({ NODE_ENV: "production" }), false);
  assert.equal(isLocalGitProjectsAllowed({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "false" }), false);
});

test("isLocalGitProjectsAllowed: allowed in production only when ALLOW_LOCAL_GIT_PROJECTS=true explicitly", () => {
  assert.equal(isLocalGitProjectsAllowed({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "true" }), true);
});

test("isLocalGitProjectsAllowed: throws clearly on a malformed flag under NODE_ENV=production", () => {
  assert.throws(
    () => isLocalGitProjectsAllowed({ NODE_ENV: "production", ALLOW_LOCAL_GIT_PROJECTS: "yes" }),
    (err: unknown) => err instanceof ConfigError,
  );
});
