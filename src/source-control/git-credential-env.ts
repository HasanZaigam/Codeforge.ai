import type { GitCredential } from "../domain/types.js";

/**
 * Turns a `GitCredential` into environment variables for a single `git`
 * child-process invocation — never a `-c`/`--config` CLI flag and never
 * written into the repository's `.git/config`. See
 * /docs/GITHUB_INTEGRATION.md "Credential exposure boundary" for the full
 * reasoning; the short version:
 *
 *  - CLI flags (`git -c http.extraHeader=...`) are visible to any local
 *    user via `ps aux` for the life of the process, and can leak into
 *    `execFile`'s own "Command failed: <cmd>" error message.
 *  - Persisting the header to `.git/config` (via `git config` or a URL with
 *    an embedded token) would put the token on disk, inside the exact
 *    workspace directory the coding engine reads and edits — defeating the
 *    "Claude never sees the credential" requirement.
 *  - Environment variables set only for one `child_process` call are
 *    visible only to that process (and, on most systems, only to a
 *    privileged reader of `/proc/<pid>/environ` — not to `ps aux`, and not
 *    to anything reading files inside the workspace).
 *
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` is git's own
 * supported mechanism (2.31+) for passing config through the environment
 * instead of the command line or a file.
 */
export function gitCredentialEnv(credential: GitCredential | null | undefined): NodeJS.ProcessEnv {
  if (!credential) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: credential.header,
  };
}
