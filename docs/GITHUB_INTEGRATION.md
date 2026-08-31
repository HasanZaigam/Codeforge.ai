# GitHub Integration (Step 7)

How the platform connects a project to a real GitHub repository and turns a completed task into a real Pull Request. See [INTEGRATION_ARCHITECTURE.md](./INTEGRATION_ARCHITECTURE.md) for where this sits among the other provider abstractions, and [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) for the credential-isolation rules this design exists to satisfy.

## Platform auth vs. GitHub authorization

These are two separate concerns, deliberately never conflated:

- **Platform auth** (Step 6): who is the signed-in user — a session cookie, verified against `users`/`sessions`. Answers "is this hasan@example.com."
- **GitHub authorization** (Step 7): what the platform may do on GitHub *on that user's behalf* — a per-user stored GitHub credential (`github_credentials`, one row per `user_id`). Answers "may the platform commit/push/open PRs against acme/widgets as this user's GitHub identity."

A user can be fully authenticated to the platform with no GitHub account connected at all (e.g. only using `local-git` projects). Connecting GitHub (`POST /integrations/github`) is a distinct, explicit action from login.

## Credential mechanism: PAT, as an explicit dev-only boundary

A GitHub App (fine-grained, repo-scoped, revocable installation tokens) is the right mechanism for a production multi-tenant product — it doesn't require the user to hand over a broad personal token, and installations are scoped to specific repositories by GitHub itself. Building and registering a GitHub App requires a public callback URL and app registration that don't exist for this MVP's deployment story (see [MVP_SCOPE.md](./MVP_SCOPE.md)), so Step 7 ships a **Personal Access Token (PAT)**, stored per-user, as the supported mechanism — with the limitations below made explicit rather than hidden:

- A PAT's scope is whatever the user granted it (ideally `repo` only) — the platform cannot narrow it further than GitHub already lets the user narrow it at creation time.
- Revocation is two-sided: `DELETE /integrations/github` deletes the platform's stored copy, but a user who wants to fully revoke access must also revoke/rotate the token on GitHub's side (Settings → Developer settings). The platform cannot do this for them — it holds no more authority over the token's lifecycle than any other holder of that PAT.
- There is one credential per user, not per project — every GitHub project a user connects uses their same connected account.

This is a real security tradeoff, made explicitly rather than silently: swapping in a GitHub App implementation later requires no change to `SourceControlProvider`, `Orchestrator`, or any core logic — only a new provider registered under the same interface (see "Adding a new provider" in INTEGRATION_ARCHITECTURE.md).

## Credential storage

`github_credentials` (migration `004_github.sql`): `id`, `user_id UNIQUE`, `github_login`, `encrypted_token`, `iv`, `auth_tag`, `created_at`, `updated_at`, `last_used_at`.

- Encrypted at rest with **AES-256-GCM** (`src/auth/credential-encryption.ts`) — authenticated encryption, so tampering with the ciphertext is detected, not silently decrypted wrong. Distinct from password hashing (TD-31): a password is verified and never recovered; a GitHub token must be recovered in full to call the GitHub API with it, so it's encrypted, not hashed.
- The key comes from `CREDENTIAL_ENCRYPTION_KEY` (base64, must decode to exactly 32 bytes), read lazily via `loadEncryptionKey()` — a deployment that never uses the GitHub integration never needs it set. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- Only ciphertext ever leaves `credential-encryption.ts` — repositories, services, and the API only ever see `{ciphertext, iv, authTag}` or a resolved in-memory token, never a persisted plaintext column.

**Revocation behavior**: `disconnect()` performs a real `DELETE` on the row — not a soft "inactive" flag. Reconnecting (`connect()` again) overwrites the previous row via `upsert`. There is no token rotation reminder or expiry tracking in the MVP; a token that GitHub itself has expired or revoked simply starts failing (`GitHubAuthError` → surfaced as `SOURCE_CONTROL_FAILED` on the affected task, `502 GITHUB_AUTH_FAILED` on the affected API call).

## Never exposed to Claude, logs, prompts, DTOs, or the frontend

- The coding engine (Claude Code) never sees the token. It runs inside the task workspace with normal filesystem access, including to `.git/config` — so the credential is injected only as ephemeral environment variables (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, see `src/source-control/git-credential-env.ts`) around the platform's own `git clone`/`push` child-process calls, never written to `.git/config`, never passed as a CLI flag (visible in `ps aux`), never embedded in the clone URL.
- `GitHubClient` (`src/integrations/github/github-client.ts`) centralizes every request; its error mapping (`safeErrorMessage`) forwards only GitHub's own `message` field, never raw headers or response internals — see the github-client.test.ts suite for this asserted directly (an error is checked to never contain the token used to make the request).
- `push()`'s error path additionally redacts any `authorization: bearer …` pattern from a caught error message as defense in depth, in case a future git version ever includes the credential helper's value in its own stderr.
- API DTOs (`ProjectDTO`, `TaskDTO`, `GitHubConnectionDTO`) carry only non-secret fields (`owner`/`repo`, PR url/number, `githubLogin`) — the token itself has no read path anywhere in the API surface once stored.
- `TaskEvent.payload` and `AgentRun.result` for source-control events (`BRANCH_CREATED`, `COMMIT_CREATED`, `BRANCH_PUSHED`, `PULL_REQUEST_CREATED`, `SOURCE_CONTROL_FAILED`) carry branch names, commit shas, PR numbers/urls, and sanitized error strings — never a credential.

## Repository connection

`POST /projects` with `sourceControlProvider: "github"` takes `owner`, `repo`, and an optional `defaultBranch`. Before ever persisting a `Project` row:

1. Resolves the caller's connected GitHub credential (`GitHubIntegrationService.clientForUser`) — throws `GitHubNotConnectedError` (`409 GITHUB_NOT_CONNECTED`) if none.
2. Calls the real GitHub API (`GET /repos/{owner}/{repo}`) to confirm the repository exists and is accessible with that credential — a missing/inaccessible repo is reported as `400 INVALID_REPOSITORY`, not a 502 (see `ProjectService.verifyGitHubRepository`; GitHub itself doesn't distinguish "doesn't exist" from "private and inaccessible," and neither does the platform).
3. Resolves the branch to use: the caller's requested `defaultBranch`, or the repository's own real default branch from GitHub if omitted — never silently guessed.
4. Confirms that branch exists (`GET /repos/{owner}/{repo}/branches/{branch}`) — `400 INVALID_REPOSITORY` if not.

Only after all four succeed is the `Project` row (with `owner`, `repo`, the resolved `defaultBranch`, and a derived `repoUrl` of `https://github.com/{owner}/{repo}.git`) inserted.

## Branch strategy and base branch

Each task gets a deterministic branch name, `task/{taskId.slice(0,8)}`, created once per task and reused across retries (stored in `TaskRecord.branchName`, set the first time a workspace is provisioned). The base branch is always `Project.defaultBranch` — resolved once at project-connection time as above, never re-derived per task.

## Commit / push as a real gate

Unlike Steps 1–6 (where a stubbed "prepare changes" step was a non-fatal side effect), `Orchestrator.prepareChanges` now makes commit-and-push a required gate: a failure at either step throws, propagates through `executeTask`'s catch block, and the task lands in **FAILED** (`infra_failure` transition) — it never silently continues to REVIEW with unpushed changes. `COMMIT_CREATED` and `BRANCH_PUSHED` events are the durable evidence of what actually happened; `SOURCE_CONTROL_FAILED` records what didn't, with the step name and a sanitized error.

## Pull Request: evidence-based content, no auto-merge

`ensurePullRequest` (called exactly once, immediately before a task is allowed to transition to REVIEW) builds the PR title/body from the task's own persisted goal, the Implementer's own summary, the real validation check results, and the real reviewer findings (`src/orchestrator/pull-request-content.ts`) — never fabricated content. The PR body's footer states explicitly that a human review and merge decision is still required. **The platform never merges, approves, or closes a PR itself** — see the Step 7 do-not-build list.

Opening the PR is itself part of the REVIEW gate: if it fails, the task goes to FAILED with the commit/push evidence already recorded (so a human can see exactly how far it got), not to a REVIEW state that falsely implies a PR exists.

## PR idempotency (crash/retry safety)

Double-guarded so a worker crash between "PR opened" and "task saved" can never produce a duplicate PR on retry:

1. **Orchestrator-level**: `ensurePullRequest` short-circuits immediately if `task.taskRecord.pullRequest` is already set from a prior attempt.
2. **Provider-level**: `GitHubSourceControlProvider.openPullRequest` (and the `FakeSourceControlProvider` test double, for the same contract) searches GitHub for an existing PR on `(head, base)` before creating one — `GET /repos/{owner}/{repo}/pulls?head=...&base=...&state=all`, preferring an `open` PR if found, otherwise returning whatever's found (e.g. a closed one from a previous, now-irrelevant attempt is still returned rather than duplicated).

## Failure recovery — mapped to existing states, no new states added

Every GitHub/git failure mode maps onto the existing task-state machine — Step 7 adds zero new `TaskStatus` values:

| Failure | Where | Result |
|---|---|---|
| No GitHub account connected | `POST /projects` (github) | `409 GITHUB_NOT_CONNECTED` — project never created |
| Repo/branch doesn't exist or isn't accessible | `POST /projects` (github) | `400 INVALID_REPOSITORY` — project never created |
| Token invalid/expired | `POST /integrations/github`, or mid-task | `400 INVALID_GITHUB_TOKEN` (connect) / task → **FAILED** with `SOURCE_CONTROL_FAILED` (mid-task) |
| Clone/credential resolution fails | mid-task | task → **FAILED**, `WORKSPACE_FAILED` |
| Commit or push fails | mid-task | task → **FAILED**, `SOURCE_CONTROL_FAILED` |
| PR creation fails | mid-task | task → **FAILED**, `SOURCE_CONTROL_FAILED` (commit/push evidence already recorded) |
| GitHub rate-limited | any GitHub call | `429 GITHUB_RATE_LIMITED` (API) / `SOURCE_CONTROL_FAILED` (mid-task) — see "Rate limiting" below |
| Cancellation races a source-control step | mid-task | task → **CANCELLED**, no PR opened (see `tests/github-source-control.test.ts`) |

Worker crash-recovery (`recoverOrphanedTasks`) needs no GitHub-specific handling: a re-claimed task resumes with its already-recorded `branchName` (reused, not regenerated) and `pullRequest` (short-circuited if already set), so a retry after a crash produces the same branch and, at most, the same PR — never duplicates.

## Rate limiting

Minimal, deliberately not a retry system (out of scope — see "What was not built"): `GitHubClient` detects a rate-limited `403` (via `x-ratelimit-remaining: 0`) and throws `GitHubRateLimitError` carrying the `resetAt` time parsed from `x-ratelimit-reset`. The API surfaces this as `429 GITHUB_RATE_LIMITED` with `resetAt` in the response body; mid-task, it's recorded as any other `SOURCE_CONTROL_FAILED` failure (task → FAILED). No automatic backoff/retry loop is implemented — a human resolves it by retrying the task later, once the rate limit window resets.

## Safe error handling

`error-middleware.ts` maps the full GitHub error vocabulary (`GitHubAuthError` → 502, `GitHubNotFoundError` → 502, `GitHubRateLimitError` → 429, generic `GitHubApiError` → 502, `GitHubNotConnectedError` → 409, `InvalidGitHubTokenError`/`InvalidRepositoryError` → 400) to safe, generic messages — never a raw GitHub response body, header, or the credential used to make the request. See `tests/github-client.test.ts` for a test asserting this directly.

## Testing strategy

- **`tests/github-client.test.ts`** — unit tests for `GitHubClient`'s error mapping and response shaping, against a stubbed `fetch` (no network).
- **`tests/github-source-control.test.ts`** — Orchestrator-level tests using `tests/helpers/fake-source-control-provider.ts`, a deterministic `SourceControlProvider` test double registered under the `"github"` key via `buildPlatform`'s test-only `additionalSourceControlProviders` option. Covers: the full commit→push→PR→REVIEW path with real evidence; PR idempotency at both the Orchestrator and provider layers; commit/push/PR-creation failures each independently landing the task in FAILED with the right partial evidence preserved; a cancellation racing the push step landing in CANCELLED with no PR opened. No live GitHub credential required.
- **`tests/github-integration.test.ts`** — HTTP-level tests against the real Express app, with only `api.github.com` requests intercepted (everything else — the local test server itself — passes through real `fetch`). Covers: connect/status/disconnect; a rejected token never gets stored; the stored credential is genuinely ciphertext, not plaintext; two users' GitHub connections are fully isolated (an explicit cross-user security test, matching the pattern in `tests/auth.test.ts`); a github-backed project requires a connected account; repository/branch verification actually blocks project creation on failure; no DTO ever echoes a token.

None of the above requires `CREDENTIAL_ENCRYPTION_KEY` to be pre-set for the rest of the suite — `github-integration.test.ts` sets a fresh throwaway one for itself only, since it's the only file that exercises credential storage.

### Live GitHub smoke test — reported as unverified

The Step 7 brief calls for an optional, non-mandatory live-credential contract-test suite, and a live smoke test if real credentials are available. **No real GitHub Personal Access Token or a disposable real repository was available in this environment.** A manual check confirmed the sandbox *can* reach `api.github.com` (a deliberately-invalid token round-tripped through the real API and came back as a real `401`, correctly mapped to `400 INVALID_GITHUB_TOKEN`) — so network reachability is not the blocker. What remains genuinely unverified: connecting a real account, creating a real GitHub-backed project, and a task actually producing a real commit/push/PR against a live repository. This is reported honestly rather than fabricated, per explicit instruction — running this once real credentials and a disposable test repo are available is the natural next verification step, not a code change.

## What was not built (explicit non-goals for Step 7)

Auto-merge, Jenkins/AWS/Kubernetes deployment integration, CI/CD orchestration, GitHub Actions management, GitHub org/team management, billing, notifications, WebSockets, Redis, Kafka, or any new agent role. See the Step 7 brief and [MVP_SCOPE.md](./MVP_SCOPE.md).
