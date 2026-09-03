/**
 * Fail-fast, secret-free startup configuration validation for the API and
 * worker entrypoints (src/api/server.ts, src/worker/run-worker.ts). Every
 * check here reports what's wrong without ever printing a secret's *value*
 * — only whether it's set and well-formed (e.g. a decoded byte length, never
 * the key itself). A malformed value is reported clearly at process startup
 * instead of being silently coerced (`Number("abc")` -> `NaN`) or deferred
 * to first use deep inside a request/task. See /docs/DEPLOYMENT.md
 * "Configuration validation".
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const KNOWN_CODING_ENGINES = new Set(["opencode", "claude-code", "claude", "fixture"]);

/**
 * Validates the configuration shared by both entrypoints: which coding
 * engine is selected, and — only if it's set at all, since a deployment
 * that never uses the GitHub integration legitimately never sets it (see
 * loadEncryptionKey's own doc comment) — that CREDENTIAL_ENCRYPTION_KEY is
 * at least well-formed, so a typo'd key is caught at startup rather than
 * the first time a task actually needs it.
 */
export function validateSharedConfig(env: NodeJS.ProcessEnv = process.env): void {
  const engine = (env.CODING_ENGINE ?? "opencode").toLowerCase().trim();
  if (!KNOWN_CODING_ENGINES.has(engine)) {
    throw new ConfigError(
      `CODING_ENGINE="${env.CODING_ENGINE}" is not recognized. Valid values: opencode, claude-code, fixture.`,
    );
  }
  if (engine === "fixture" && env.NODE_ENV === "production") {
    throw new ConfigError(
      "CODING_ENGINE=fixture (deterministic, no live model) must never be set with NODE_ENV=production — " +
        "it performs no real work and is intended for local development/demo only. Set CODING_ENGINE to " +
        "opencode or claude-code, or unset NODE_ENV=production for local/demo use.",
    );
  }

  const key = env.CREDENTIAL_ENCRYPTION_KEY;
  if (key) {
    const decoded = Buffer.from(key, "base64");
    if (decoded.length !== 32) {
      throw new ConfigError(
        `CREDENTIAL_ENCRYPTION_KEY is set but does not decode to 32 bytes (got ${decoded.length}) — GitHub ` +
          `credential storage would fail the first time it's used. Generate one with: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
  }
}

/**
 * Parses a positive-integer env var, failing clearly if it's set but
 * malformed rather than silently falling back (`Number(process.env.PORT)`
 * on a typo'd value produces `NaN`, and `app.listen(NaN)` binds to a random
 * port with no indication anything was wrong).
 */
export function parsePositiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer if set (got "${raw}").`);
  }
  return n;
}
