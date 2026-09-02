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

There is no separate "create a branch" GitHub API call at all — the branch is created entirely by ordinary git (`git checkout -b` in the workspace, made real on GitHub the moment `git push -u origin <branch>` first succeeds), so "branch creation conflict" isn't a distinct GitHub API failure mode to handle; it's covered by push behavior (below). Explicitly handled cases:

- **Branch doesn't exist yet**: the normal case — created locally, pushed for the first time.
- **Branch already exists / already contains task commits**: expected on any retry, self-fix loop, or review/fix cycle within the same task — `git push` of a branch whose remote state already matches (or is a strict ancestor of) the local state is a no-op or a fast-forward, never an error, and never creates a duplicate branch.
- **Workspace is being recovered (crash-recovery)**: the workspace (and its local branch checkout) is reused as-is — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Crash recovery"; `Orchestrator.provisionWorkspace` never re-clones or re-creates the branch for a workspace already `"ready"`.
- **Branch was deleted remotely** (a human deletes it on GitHub mid-task): the next `git push -u origin <branch>` simply recreates it — ordinary git push semantics, nothing GitHub-specific to handle.
- **Branch creation request times out**: there is no such request (see above) — a push timeout is handled as any other transient push failure, see "Push behavior" below.

**Invariant preserved throughout**: one task → one task branch. Nothing in this codebase ever deletes or force-overwrites an existing task branch — the only branch-affecting operations are "create if it doesn't exist yet" (an ordinary push) and "reuse what's already there."

## Commit / push as a real gate

Unlike Steps 1–6 (where a stubbed "prepare changes" step was a non-fatal side effect), `Orchestrator.prepareChanges` now makes commit-and-push a required gate: a failure at either step throws, propagates through `executeTask`'s catch block, and the task lands in **FAILED** (`infra_failure` transition) — it never silently continues to REVIEW with unpushed changes. `COMMIT_CREATED` and `BRANCH_PUSHED` events are the durable evidence of what actually happened; `SOURCE_CONTROL_FAILED` records what didn't, with the step name and a sanitized error.

`commitAllLocal` (shared by both `SourceControlProvider` implementations) is itself idempotent: if there's nothing new to commit (e.g. a redundant re-run after a coarse-grained crash-recovery restart — see TASK_LIFECYCLE.md), it returns the current `HEAD` instead of erroring or creating an empty commit. No retry or recovery path in this codebase can ever produce a duplicate commit as a result of retrying `commitAll`/`push`.

### Push behavior: bounded retry for genuinely transient failures only

`GitHubSourceControlProvider.push` retries a failed `git push` up to twice more (`PUSH_MAX_RETRIES = 2`, fixed exponential backoff, not env-configurable — a narrow, single-purpose retry, not a general knob) — but **only** when `classifyGitPushError` (a small, git-CLI-text-based classifier, the counterpart to the GitHub REST API classifier below) recognizes the stderr as a genuinely transient network failure (`could not resolve host`, connection reset/timeout, `the remote end hung up unexpectedly`, a 5xx from GitHub's git-over-HTTPS endpoint, etc.). Every other category — `auth` (bad/expired credential), `authorization` (permission denied), `conflict` (`[rejected]`/non-fast-forward) — fails immediately, never retried: retrying a bad credential or a real conflict doesn't help, it just delays a clear error. Retrying a push at all is safe only because pushing the same local state twice is itself idempotent — see above; no retry here can ever create a duplicate commit.

## GitHub API error classification

`src/integrations/github/error-classifier.ts` (`classifyGitHubError`) is the GitHub-specific counterpart to `coding-engine/engine-failure-classifier.ts` (which classifies OpenCode/model-provider failures) — deliberately separate code, not shared: the error surfaces are completely different (typed HTTP-status exceptions here vs. parsed child-process NDJSON there), and a shared classifier would mean one implementation guessing about errors it wasn't designed for. Categories: `retryable_transient` (network error, 5xx), `rate_limited` (403 with rate-limit signals — see below), `auth` (401), `authorization` (403, not rate-limited — e.g. a token with insufficient scope), `not_found` (404), `conflict` (409), `invalid_request` (400/422), `unknown` (anything else). Only `retryable_transient` and a `rate_limited` whose suggested wait fits the configured budget are ever retried — everything else fails fast and clearly, the same conservative philosophy every retry/classification mechanism in this codebase already follows.

## Retry behavior

`GitHubClient` retries a failed request up to `maxRetries` additional times (default 2, so 3 total attempts; env-configurable via `GITHUB_MAX_RETRIES`/`GITHUB_RETRY_BASE_DELAY_MS`/`GITHUB_RETRY_MAX_DELAY_MS`, clamped the same way `OPENCODE_MAX_RETRIES` etc. are) — but **only for idempotent (read) calls**. `createPullRequest`'s `POST` explicitly opts out (`idempotent: false`): a `POST` is not safe to blindly retry, because if GitHub's server actually processed the request but the response was lost (a timeout reading the body, a dropped connection right after a `201`), retrying the same `POST` would create a second PR. See "PR idempotency" below for how retrying the *operation* (not the HTTP call) stays safe anyway. Backoff uses the same generic, engine-agnostic `computeBackoffDelayMs`/`sleepUnlessAborted` primitives `OpenCodeAdapter` uses (`coding-engine/retry-backoff.ts`) — reused as a shared utility (pure math, no OpenCode-specific knowledge), not duplicated; the classification and retry-loop logic around them is entirely separate per-domain code. Cancellation during a retry wait is honored immediately (not after the full backoff delay) via the same `sleepUnlessAborted` mechanism OpenCode's own retry loop uses.

## Pull Request: evidence-based content, no auto-merge

`ensurePullRequest` (called exactly once, immediately before a task is allowed to transition to REVIEW) builds the PR title/body from the task's own persisted goal, the Implementer's own summary, the real validation check results, and the real reviewer findings (`src/orchestrator/pull-request-content.ts`) — never fabricated content. The PR body's footer states explicitly that a human review and merge decision is still required. **The platform never merges, approves, or closes a PR itself** — see the Step 7 do-not-build list.

Opening the PR is itself part of the REVIEW gate: if it fails, the task goes to FAILED with the commit/push evidence already recorded (so a human can see exactly how far it got), not to a REVIEW state that falsely implies a PR exists.

## PR idempotency (crash/retry safety)

Double-guarded so a worker crash between "PR opened" and "task saved" can never produce a duplicate PR on retry:

1. **Orchestrator-level**: `ensurePullRequest` short-circuits immediately if `task.taskRecord.pullRequest` is already set from a prior attempt.
2. **Provider-level**: `GitHubSourceControlProvider.openPullRequest` (and the `FakeSourceControlProvider` test double, for the same contract) searches GitHub for an existing PR on `(head, base)` before creating one — `GET /repos/{owner}/{repo}/pulls?head=...&base=...&state=all`, preferring an `open` PR if found, otherwise returning whatever's found (e.g. a closed one from a previous, now-irrelevant attempt is still returned rather than duplicated).

This holds even for the specific "GitHub actually created the PR but the response never came back" race the search-before-create guard exists for: `createPullRequest`'s `POST` is never auto-retried (see "Retry behavior" above), so if its response is lost, the call simply fails — the task lands in `FAILED` with the commit/push evidence already recorded (see "Opening the PR is itself part of the REVIEW gate" above). Whatever retries the *operation* next — a manually-retried task, a crash-recovery resume, or (for the human-review-feedback loop) the next poll — calls `openPullRequest` again, which searches first and discovers the PR GitHub actually created, reusing it instead of creating a second one. Covered directly by `tests/github-source-control-provider.test.ts`'s "PR creation 'succeeds on GitHub but the response is lost'" test, which scripts exactly this sequence against the real `GitHubSourceControlProvider` (a stubbed `GitHubClient`, no live network).

Together these two guards mean **one task → one GitHub PR** holds across a worker restart, a crash, a manual retry, a duplicate worker racing the same task (only one wins the DB-level claim — see TECHNICAL_DECISIONS.md TD-12), an API timeout, or a lost success response — no second PR-tracking system was introduced; both guards reuse the exact same `TaskRecord.pullRequest`/GitHub-search mechanism that already existed.

## PR state handling

A PR search only ever needs to distinguish `open` from "everything else" (see above) — but the human review feedback loop needs to know specifically whether a PR is `merged`, so `GitHubClient.getPullRequest` (the single-PR fetch, `GET /repos/{owner}/{repo}/pulls/{number}`) is used instead, which is the only endpoint that returns a `merged` flag.

- **OPEN**: normal — feedback is fetched and processed as usual.
- **MERGED**: `GitHubSourceControlProvider.listPullRequestFeedback` checks state *before* fetching any reviews/comments and returns `[]` immediately if merged — a later worker poll can never re-trigger implementation because of a stray or late review on an already-merged PR. No new task status was introduced: the task simply stays in `REVIEW` (the platform never listens for a merge webhook or auto-completes the task on merge — a human still explicitly accepts it, exactly as before this milestone).
- **CLOSED (not merged)**: same treatment as merged — `[]`, no processing. A human closed it without merging; nothing here should keep pushing commits to a dead branch.

This check happens once per `checkHumanReviewFeedback` call, adds exactly one extra read (`getPullRequest`) before the (now frequently skipped) reviews/comments fetch, and required no new `SourceControlProvider` interface method beyond what already existed for the read path — `listPullRequestFeedback`'s own contract ("returns the actionable feedback for this PR, or `[]`") already covers "there is none because it's merged/closed."

## Human review feedback ingestion

The platform can also read back from the PR it opened — see [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Human review feedback loop" for the full lifecycle this feeds. `SourceControlProvider.listPullRequestFeedback(project, pr, signal)` is deliberately narrow: two read-only GitHub endpoints, not a general API client.

- `GET /repos/{owner}/{repo}/pulls/{number}/reviews` — submitted reviews, each with a `state` (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`, others ignored) and a body. This is the only source of an actionable verdict.
- `GET /repos/{owner}/{repo}/issues/{number}/comments` — general PR conversation comments (a PR is an "issue" in GitHub's own model for this endpoint). These carry no verdict; they're folded into the Implementer's feedback as supplementary context when an actionable review triggers a fix cycle, and otherwise just get marked processed.

Both fetches (skipped entirely for a merged/closed PR — see "PR state handling" above) run in parallel and are mapped into the platform's own small `HumanReviewFeedbackItem` shape (id, kind, verdict, body, author, timestamps). Ids are namespaced (`review:<n>` / `comment:<n>`) so a review and a comment can never collide in `TaskRecord.processedHumanFeedbackIds`. `local-git` has no PR-review concept and always returns `[]`; `FakeSourceControlProvider` (the test double already used for commit/push/PR idempotency tests) has matching `setPullRequestFeedback`/`setPullRequestState`/`failNextCallToFeedback` scripting hooks for deterministic tests.

**Polling idempotency and read-failure visibility**: a repeated poll (the worker's own tick, or an on-demand `POST /tasks/:taskId/check-review-feedback` call) is always safe — `TaskRecord.processedHumanFeedbackIds` is checked before anything is acted on, so an already-processed review/comment id is silently ignored no matter how many times it's re-fetched. A failed *fetch* (as opposed to already-processed feedback) is now classified via `classifyGitHubError`: a `retryable_transient`/`rate_limited` failure is logged and the task is left completely untouched — no event, since the very next poll is expected to succeed on its own and a permanent audit-trail entry for something self-healing would just be noise. Anything else (`auth`, `authorization`, `not_found`, `conflict`, `invalid_request`, `unknown` — most realistically a revoked/expired GitHub token) is genuinely persistent and needs to be *visible*, not just logged server-side: it's recorded via the existing `SOURCE_CONTROL_FAILED` event (the same one commit/push/PR-creation failures already use, `payload.step: "check_review_feedback"`) — still without failing the task, since the task's actual work already succeeded and reached `REVIEW`; only the feedback *read* is degraded, and it self-recovers the moment the credential/permission issue is fixed.

**Verified against a real PR** (see the human-review-feedback milestone's real end-to-end verification): a real `COMMENTED`-state review and a real issue comment, both posted through the same GitHub REST API this client calls, were correctly fetched, classified as non-actionable, and marked processed — with the task correctly staying in `REVIEW`. GitHub itself refuses a `CHANGES_REQUESTED` review from a PR's own author (`422 Can not request changes on your own pull request`), so the actionable trigger path itself was verified deterministically (`tests/human-review-feedback.test.ts`, using the same `FakeSourceControlProvider` pattern already used for the rest of this integration's test coverage) rather than against a second, real GitHub identity this deployment doesn't have.

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
| GitHub rate-limited, wait within budget | any GitHub call | retried automatically (see "Retry behavior") — invisible if it succeeds |
| GitHub rate-limited, wait exceeds budget | any GitHub call | `429 GITHUB_RATE_LIMITED` (API) / `SOURCE_CONTROL_FAILED` (mid-task, non-fatal for a feedback-read; fatal for a required gate like commit/push/PR-creation) — see "Rate limit handling" below |
| Cancellation races a source-control step (push, PR search/create, feedback fetch) | mid-task | task → **CANCELLED**, no PR opened, no duplicate work (see `tests/github-source-control.test.ts` and `tests/github-source-control-provider.test.ts`) |

Worker crash-recovery (`recoverOrphanedTasks`) needs no GitHub-specific handling: a re-claimed task resumes with its already-recorded `branchName` (reused, not regenerated) and `pullRequest` (short-circuited if already set), so a retry after a crash produces the same branch and, at most, the same PR — never duplicates. See [TASK_LIFECYCLE.md](./TASK_LIFECYCLE.md) "Crash recovery" for the general (provider-agnostic) mechanism this relies on, and `tests/github-source-control-provider.test.ts`'s "PR creation 'succeeds on GitHub but the response is lost'" test for the GitHub-specific edge of it.

## Rate limit handling

`GitHubClient` distinguishes GitHub's two rate limits, both surfaced as HTTP 403: the **primary** limit (`x-ratelimit-remaining: 0`, resets at a known time — `x-ratelimit-reset`) and the **secondary/abuse-detection** limit (no ratelimit headers, just a `Retry-After` header). Either signal throws `GitHubRateLimitError` carrying whichever wait time GitHub actually gave (`retryAfterMs` preferred when present, else derived from `resetAt`).

- **If the suggested wait fits within `retryMaxDelayMs`** (default 10s): retried automatically, respecting that exact wait — never a tight spin loop, never plain exponential backoff overriding what GitHub explicitly asked for.
- **If the suggested wait exceeds the budget** (e.g. the primary limit's hour-long reset window): failing fast, immediately, with a clear `GitHubRateLimitError` is the correct behavior, not blocking the call — or looping pointlessly against a still-active limit — for up to an hour. The API surfaces this as `429 GITHUB_RATE_LIMITED` with `resetAt` in the response body; mid-task, it's `SOURCE_CONTROL_FAILED`. A human (or the task's own natural retry cadence — the next worker poll, the next self-fix attempt) tries again later, once the window resets.

No unlimited retries anywhere in this path — every retry loop in this codebase (OpenCode's, GitHub's, the push-specific one) is bounded by a fixed `maxRetries`.

## Safe error handling

`error-middleware.ts` maps the full GitHub error vocabulary (`GitHubAuthError` → 502, `GitHubNotFoundError` → 502, `GitHubRateLimitError` → 429, generic `GitHubApiError` → 502, `GitHubNotConnectedError` → 409, `InvalidGitHubTokenError`/`InvalidRepositoryError` → 400) to safe, generic messages — never a raw GitHub response body, header, or the credential used to make the request. See `tests/github-client.test.ts` for a test asserting this directly.

## Testing strategy

- **`tests/github-client.test.ts`** — unit tests for `GitHubClient`'s error mapping, response shaping, and (since the source-control-hardening milestone) retry behavior — transient failures retried and eventually succeeding, non-retryable failures never retried, a bounded retry loop still throwing once exhausted, a short rate-limit wait retried and a long one failing fast, `createPullRequest` never auto-retrying, and cancellation during a retry wait being honored immediately — all against a stubbed `fetch` (no network).
- **`tests/github-error-classifier.test.ts`** — unit tests for `classifyGitHubError`'s category/retryable/suggestedDelayMs mapping for every `GitHubApiError` subtype and status code.
- **`tests/github-source-control-provider.test.ts`** — unit tests against the real `GitHubSourceControlProvider` with a stubbed `GitHubClient` (via its `clientFactory` constructor param) — no live network. Covers: PR idempotency including the "GitHub actually created the PR but the response was lost" race; PR state handling (merged/closed PRs never fetch reviews/comments); cancellation racing each network step (PR search, PR create, feedback fetch) converting to `CancellationError`, not a raw abort; `classifyGitPushError`'s git-CLI-text classification for transient/auth/authorization/conflict/unknown push failures.
- **`tests/github-source-control.test.ts`** — Orchestrator-level tests using `tests/helpers/fake-source-control-provider.ts`, a deterministic `SourceControlProvider` test double registered under the `"github"` key via `buildPlatform`'s test-only `additionalSourceControlProviders` option. Covers: the full commit→push→PR→REVIEW path with real evidence; PR idempotency at both the Orchestrator and provider layers; commit/push/PR-creation failures each independently landing the task in FAILED with the right partial evidence preserved; a cancellation racing the push step landing in CANCELLED with no PR opened. No live GitHub credential required.
- **`tests/human-review-feedback.test.ts`** — also covers (since the source-control-hardening milestone) merged/closed PR feedback never triggering a fix cycle even via a real worker poll, a transient read failure never failing the task with no permanent event, and an auth/permission read failure being surfaced via `SOURCE_CONTROL_FAILED` without failing the task.
- **`tests/github-integration.test.ts`** — HTTP-level tests against the real Express app, with only `api.github.com` requests intercepted (everything else — the local test server itself — passes through real `fetch`). Covers: connect/status/disconnect; a rejected token never gets stored; the stored credential is genuinely ciphertext, not plaintext; two users' GitHub connections are fully isolated (an explicit cross-user security test, matching the pattern in `tests/auth.test.ts`); a github-backed project requires a connected account; repository/branch verification actually blocks project creation on failure; no DTO ever echoes a token.

None of the above requires `CREDENTIAL_ENCRYPTION_KEY` to be pre-set for the rest of the suite — `github-integration.test.ts` sets a fresh throwaway one for itself only, since it's the only file that exercises credential storage.

### Live GitHub smoke test — reported as unverified

The Step 7 brief calls for an optional, non-mandatory live-credential contract-test suite, and a live smoke test if real credentials are available. **No real GitHub Personal Access Token or a disposable real repository was available in this environment.** A manual check confirmed the sandbox *can* reach `api.github.com` (a deliberately-invalid token round-tripped through the real API and came back as a real `401`, correctly mapped to `400 INVALID_GITHUB_TOKEN`) — so network reachability is not the blocker. What remains genuinely unverified: connecting a real account, creating a real GitHub-backed project, and a task actually producing a real commit/push/PR against a live repository. This is reported honestly rather than fabricated, per explicit instruction — running this once real credentials and a disposable test repo are available is the natural next verification step, not a code change.

## What was not built (explicit non-goals for Step 7)

Auto-merge, Jenkins/AWS/Kubernetes deployment integration, CI/CD orchestration, GitHub Actions management, GitHub org/team management, billing, notifications, WebSockets, Redis, Kafka, or any new agent role. See the Step 7 brief and [MVP_SCOPE.md](./MVP_SCOPE.md).
