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

const ALLOW_LOCAL_GIT_PROJECTS_ENV = "ALLOW_LOCAL_GIT_PROJECTS";

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

  // Format-validated eagerly whenever it's set at all (any NODE_ENV) — same "fail clearly at
  // startup, not silently coerce" stance as parsePositiveIntEnv. The value only actually
  // *restricts* anything under NODE_ENV=production — see isLocalGitProjectsAllowed below.
  parseBooleanEnv(ALLOW_LOCAL_GIT_PROJECTS_ENV, env[ALLOW_LOCAL_GIT_PROJECTS_ENV], false);

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

/**
 * Parses a boolean-flag env var, failing clearly if it's set but not a
 * clean "true"/"false" (case-insensitive) — same "fail clearly at startup,
 * never silently coerce" stance as parsePositiveIntEnv. `ALLOW_LOCAL_GIT_PROJECTS`
 * is the only current caller.
 */
export function parseBooleanEnv(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ConfigError(`${name} must be "true" or "false" if set (got "${raw}").`);
}

/**
 * Whether `sourceControlProvider: "local-git"` projects may be created.
 * Local-git is a dev/testing convenience — no GitHub account, no PR, no
 * merge signal (see /docs/GITHUB_INTEGRATION.md "Local git / plain-git
 * testing") — always available outside production so the entire automated
 * test suite and `npm run demo` keep working with zero env setup. Under
 * `NODE_ENV=production` it is disabled unless `ALLOW_LOCAL_GIT_PROJECTS=true`
 * is set explicitly. Read directly wherever project creation is handled
 * (see ProjectService.create) — this is a per-request policy check, not a
 * one-time startup check, since it must reject the API call itself, not
 * just hide the option in the UI.
 */
export function isLocalGitProjectsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return parseBooleanEnv(ALLOW_LOCAL_GIT_PROJECTS_ENV, env[ALLOW_LOCAL_GIT_PROJECTS_ENV], false);
}
