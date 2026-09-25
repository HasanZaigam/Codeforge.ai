# Backlog Intelligence *(Phase 4A — foundation; 4A.1 — production hardening; 4A.2 — evidence-grounded analysis & usage telemetry)*

> "CodeForge understands engineering work before it executes engineering work."

This document describes what Phases 4A and 4A.1 actually implement — and, just as importantly, what they do not. Phase 4A.1 moved analysis execution out of the API process into the worker, with a database-coordinated global concurrency cap, crash recovery and bounded retry (§4), and recorded the first real-provider validation (§11). Phase 4A.2 adds **evidence** (§4a): the model's statements about the repository are separated from what the platform itself verified, the platform reads a bounded amount of real file content, and real usage/cost is recorded. It is the reference for the backlog domain; the reasoning behind individual choices is in [TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md) TD-49, and the endpoints are in [API.md](./API.md) "Backlog".

## 1. What this is

Before this phase the only way into the product was `POST /projects/:id/tasks` — a human writing one exact task. Real teams have a **backlog**: dozens of loosely worded items. Phase 4A adds the *data and intelligence foundation* for that, without touching execution:

```
Backlog item ──Analyze (HTTP: enqueue a JOB, 202)──▶ [worker claims job → model → validate] ──▶ Analysis (AI proposal + platform checks)
                              │
                              ├─▶ duplicate / dependency PROPOSALS
                              ▼
                        Task proposal ──(human approves)──▶ (human converts) ──▶ ordinary Task (BACKLOG)
                                                                                      │
                                                     unchanged existing lifecycle ◀───┘  (human "Start Task" → worker → …)
```

| Concept | Meaning | Table |
|---|---|---|
| **BacklogItem** | Something the team wants CodeForge to *understand*. **Not** executable. | `backlog_items` |
| **BacklogAnalysisJob** *(4A.1)* | The unit of *work*: one queued/claimed/retried request to analyze an item. Executed only by a worker. Points at its result when terminal. | `backlog_analysis_jobs` |
| **BacklogAnalysis** | The *result*: the model's strictly-validated structured *proposal*, plus the platform's own checks of it. Append-only history. | `backlog_analyses` |
| **BacklogRelationship** | A duplicate / dependency *proposal* between two items. | `backlog_relationships` |
| **TaskProposal** | The explicit human-approval boundary between an item and a real Task. | `task_proposals` |
| **BacklogEvent** | Append-only audit trail / observability. | `backlog_events` |
| **Task** | Something CodeForge has approved for execution. Unchanged. | `tasks` |

A `BacklogItem` and a `Task` are deliberately separate concepts. The UI labels every backlog item "not an executable task".

## 2. Trust model — "AI can make claims. CodeForge owns evidence and state."

This is the same principle the reviewer/verification work established ([SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md)), applied to planning:

- **Only platform code writes a status.** `BacklogService` is the one place item/proposal status changes, through guarded repository transitions whose rules live in `src/backlog/backlog-state-machine.ts`. There is no method that accepts an arbitrary status.
- **The model's output enters exactly one place** (`BacklogAnalysisExecutor`, in the worker), strictly schema-validated (`analysis-schema.ts`, every object `.strict()`). From it the platform derives the outcome by a fixed rule (`deriveAnalysisOutcome`: any *blocking* missing-information entry ⇒ `NEEDS_CLARIFICATION`, else `ANALYZED`) and *builds the proposal itself*.
- **Unknown keys make the whole output malformed.** A response that includes `status`, `approved`, `taskId`, `retryLimit`, `skipValidation`, `branch`, … is rejected as malformed — never partially accepted with the key ignored. The model cannot even *name* platform state.
- **Approval exists only as an authenticated user action** (`approveProposal(actorId)`). Nothing on the analysis path can reach it. The model cannot approve its own proposal, convert an item, execute a task, alter retry limits or validation, pick a branch, change ownership or credentials, or merge anything — none of those is a capability of the analysis path at all.
- **Prompt-injection posture.** Item text, sibling items, project context and file names are placed in labelled DATA blocks with an instruction to treat them as material, not commands. This is defense in depth, not the boundary: even a fully compromised model output can only produce a schema-valid *proposal* a human must approve.
- **Nothing here runs code.** The analysis prompt tells the model not to act, and the engine is pointed at an **empty throwaway directory** (never a repository or task workspace) that is always removed.

## 3. Lifecycles (deterministic)

**BacklogItem** (`BACKLOG_TRANSITIONS`):

| From | Trigger | To |
|---|---|---|
| NEW / NEEDS_CLARIFICATION / ANALYZED | `analysis_requested` | ANALYZING *(a job is QUEUED; the item stays ANALYZING through running, retry backoff and recovery)* |
| ANALYZING | `analysis_succeeded` | ANALYZED |
| ANALYZING | `analysis_needs_clarification` | NEEDS_CLARIFICATION |
| ANALYZING | `analysis_aborted` | *the status it had before the analysis* |
| ANALYZED | `proposal_generated` | READY_FOR_TASK |
| READY_FOR_TASK | `proposal_rejected` | ANALYZED |
| READY_FOR_TASK | `converted` | CONVERTED |
| NEW / NEEDS_CLARIFICATION / ANALYZED / READY_FOR_TASK | `rejected` | REJECTED |
| NEW / NEEDS_CLARIFICATION / ANALYZED | `content_edited` | NEW |

`CONVERTED` and `REJECTED` are terminal. No edit or rejection while `ANALYZING`; no edit while `READY_FOR_TASK`.

What lands where after an analysis:

| Outcome | Item status | Analysis row |
|---|---|---|
| Valid, nothing blocking | `ANALYZED` | `succeeded` |
| Valid, has a *blocking* missing-information question | `NEEDS_CLARIFICATION` | `succeeded` |
| **Malformed** model output | `NEEDS_CLARIFICATION` | `failed` / `malformed_output`, bounded redacted diagnostics kept |
| Infrastructure failure that is **terminal** (auth/config/unknown error, retries exhausted, interrupted too often, context error) | back to its **pre-analysis** status | `failed` / the category |
| Retryable failure with attempts left | stays `ANALYZING` (job requeued with a backoff) | none — an intermediate attempt leaves no result row |
| Cancelled by the user | back to its **pre-analysis** status | none (the job is `CANCELLED`) |

**TaskProposal**: `PENDING → APPROVED → CONVERTING → CONVERTED`; `PENDING/APPROVED → REJECTED`; `CONVERTING → APPROVED` (failed creation, retryable). A proposal must be explicitly approved before it can be converted — `PENDING → CONVERTING` does not exist.

## 4. Analysis — executed by the worker *(Phase 4A.1)*

```
HTTP  POST /backlog/:id/analyze ──▶ persist QUEUED job + mark item ANALYZING ──▶ 202 { item, job, enqueued }
                                                                      │ (no model is called in the API process)
worker process (existing Worker loop) ── BacklogAnalysisRunner.tick() ── claims the job (atomic, leased, fenced, globally capped)
      ──▶ BacklogAnalysisExecutor ──▶ context (bounded) ──▶ BacklogAnalyzer ──▶ ModelRegistry/selectModel ──▶ coding engine ──▶ model
      ──▶ strict schema validation ──▶ ONE transaction: analysis + relationship proposals + item status + job SUCCEEDED/FAILED
frontend polls GET /backlog/:id  (item.status + analysisJob)
```

**Structural guarantee:** `BacklogService` (the API side) has no analyzer, context builder or engine dependency — it only writes the job row (test: `backlog-analysis-worker.test.ts`). Only `Worker` (via `platform.backlogRunner`) executes analyses; `run-worker.ts` passes the runner to the same `Worker` that runs tasks, so there is **no second worker system** — analysis rides its poll loop and its graceful shutdown, but is independent of task execution (a failure in the analysis tick never stops task dispatch, and it is bounded by its own cap, not `WORKER_MAX_CONCURRENT_TASKS`). It is deliberately **not** an `AgentRun`: there is no task, no workspace and no coding — it is a read-only model call.

### Job vs result

`backlog_analysis_jobs` is the *work*; `backlog_analyses` is the *result* (append-only history). A job records: item/project ids, requester, `status` (`QUEUED`/`RUNNING`/`SUCCEEDED`/`FAILED`/`CANCELLED`), `attempt_count`/`max_attempts`, `available_at` (backoff), `claim_owner`, `lease_expires_at`, `lock_generation`, `cancel_requested_at`, the latest failure category/reason, the routing decision of the latest attempt (`model_id`/`provider_id`), timestamps, and `analysis_id` (the result reference, set when a result row was recorded). At most **one live (QUEUED/RUNNING) job per item** is enforced by a partial unique index.

### Idempotent enqueue (deterministic)

| Item status when `Analyze` is requested | Result |
|---|---|
| `ANALYZING` (a QUEUED or RUNNING job — including a retry backoff) | `202` with the **existing** job, `enqueued: false`. No new job, no new model call |
| `NEW` / `NEEDS_CLARIFICATION` | new job queued (`enqueued: true`) |
| `ANALYZED` | new job queued — an explicit re-analysis (the user asked for it) |
| after a job **SUCCEEDED** | the item is `ANALYZED`/`NEEDS_CLARIFICATION`: the next request is a new job by design |
| after a job **FAILED** | the item returned to its pre-analysis status: a new job may be requested |
| after a job **CANCELLED** | likewise |
| `READY_FOR_TASK` | `409` — reject the pending proposal first |
| `CONVERTED` / `REJECTED` | `409` — terminal |

A page refresh only issues `GET`s, never `POST /analyze`; a double click, a retried request or two API processes cannot create a second job (the item flip + job insert are one transaction and the unique index is the backstop).

### Claiming, lease, heartbeat, fencing (the same principles as task execution)

- **Atomic claim** — one guarded `UPDATE` in `BacklogAnalysisJobRepository.claimNext` moves a due `QUEUED` job (or a `RUNNING` job whose lease **expired**) to `RUNNING`, sets `claim_owner`, a lease, increments `attempt_count` and bumps `lock_generation`. Two workers can never both win the same job.
- **Lease + heartbeat** — the runner renews the lease every `heartbeatMs` (default 30 s; lease 120 s); the same heartbeat notices a lost claim (abort, discard) and a user cancel request (abort, settle `CANCELLED`).
- **Generation fencing** — every write a worker makes (`succeed`/`fail`/`cancel`/`requeue`/`release`/`renewLease`) must match `(claim_owner, lock_generation)` and `status = 'RUNNING'`, and the result rows are written in **one transaction with that fence** — a stale worker's transaction rolls back completely, so no half-written or duplicate result can exist.

### Global concurrency cap

`MAX_BACKLOG_ANALYSIS_CONCURRENCY` (default **2**, positive integer, max **16**, validated at startup by `validateSharedConfig` in both processes; `.env.example`). It is enforced **by the database claim**, not by each worker counting its own runs: the claim's `UPDATE … WHERE (SELECT COUNT(*) FROM jobs WHERE status='RUNNING' AND lease_expires_at > now AND id != this) < cap` evaluates count-and-update atomically (SQLite serializes writers), so with 3 workers and cap 2 there are at most **2 live analyses in total**, not 6. A lapsed lease does not count (a crashed worker never holds a slot). Test: 3 platform instances, 6 jobs, cap 2 — the maximum number of concurrent model calls observed is 2, and the number of `RUNNING` rows sampled after every poll never exceeds 2. The cap protects provider quota and is independent of `WORKER_MAX_CONCURRENT_TASKS`.

### Crash recovery

- A worker that dies leaves a `RUNNING` job with a lapsing lease. Once it lapses, any worker's claim recovers it (`attempt_count` + 1, new `lock_generation`); the dead worker is fenced out if it ever wakes. Exactly one final result exists (tested, including a stale worker finishing after replacement).
- **Bounded:** a job whose lease keeps expiring is not run forever — once `attempt_count ≥ max_attempts` the next worker settles it `FAILED` (`interrupted`), releasing the item to its pre-analysis status, with **no model call**.
- **Graceful shutdown** (`Worker.stop()` → `runner.stop()`): in-flight analyses are aborted and their jobs go straight back to `QUEUED` with the attempt given back, so another worker (or this one after restart) simply redoes them — no failed-analysis noise, no 2-minute wait.

### Retry and provider failure (no second framework)

The analyzer classifies with the **existing** `classifyOrchestratorFailure`, routes with the existing `ModelRegistry`/`selectModel`, and updates the existing `provider_health`. Job-level retry uses the same knobs as episode-level infrastructure retry (`INFRA_MAX_EPISODE_RETRIES` ⇒ `max_attempts = retries + 1`, default 3; `INFRA_RETRY_BASE_DELAY_MS`/`INFRA_RETRY_MAX_DELAY_MS`, full-jitter `computeBackoffDelayMs`):

| Failure | Behavior |
|---|---|
| Timeout / provider quota / rate limit / 5xx (the classifier's *retryable* set) | inside one attempt: fall back to a **different** model if the registry has one; if none, requeue with bounded backoff while attempts remain; terminal `FAILED` after `max_attempts` |
| Every candidate model cooling down (`no_model_available`) | requeue **without calling anything**, waiting until the earliest cooldown ends (bounded by `providerCooldownMaxMs`); consumes an attempt, so it is bounded |
| **Malformed model output** | **never retried** — recorded as a failed analysis, item → `NEEDS_CLARIFICATION` |
| Authentication / permanent-configuration / invalid-request / unknown error | terminal `FAILED` immediately, no retry |
| Context build error | terminal `FAILED` (`context_error`) |
| Cancellation | `CANCELLED` (no result row); shutdown → job handed back |

The real bound on cost is therefore `max_attempts × maxModelAttempts(2)` model calls per job.

### Cancellation

`POST /backlog/:id/analysis/cancel`: a `QUEUED` job is cancelled at once; a `RUNNING` job gets `cancel_requested_at`, and the owning worker aborts the model call at its next heartbeat and settles `CANCELLED`. A cancel that lands before a worker claims the job is honored the instant it is claimed (no model call). The item returns to its pre-analysis status. Idempotent; `409` if nothing is live.

### Provider abstraction

Nothing here names a vendor (a test scans the backlog code for vendor names). The model comes from `ModelRegistry` (`OPENCODE_MODEL` in production); `inferProviderId` now also reads an operator-stated `<provider>/<model>` id (OpenCode's `--model` form), so `google/gemini-3.1-flash-lite` health-tracks as provider `google` instead of the shared `"unknown"` (found by the first real-provider run, §11).

### Bounded, deterministic context

`BacklogContextBuilder` assembles, within fixed limits (`PROMPT_LIMITS`, `DEFAULT_STRUCTURE_LIMITS`): the item; the project's own Project Context Manifest (the exact loader task execution uses); a *selected slice* of the repository structure; and up to 50 sibling items (truncated summaries) for duplicate/dependency detection. Total prompt ≤ 60,000 characters; if over, siblings are dropped from the tail, then relevant paths, then the outline. **Same inputs ⇒ same prompt.**

Repository awareness is a **file listing only**: `GitRepositoryStructureProvider` does a blobless, depth-1, `--no-checkout` clone into a temp dir (using the project's own `resolveCloneCredential`, credential in env only) and `git ls-tree`s it — no file contents are read or sent. `selectRelevantStructure` (pure) drops noise (`node_modules`, build output, binaries, lockfiles), builds a directory outline, and ranks paths by filename/directory match against the item's own words. `RepositoryStructureProvider` is the seam a future index plugs into; there is no vector store or RAG here. If the listing can't be produced the analysis still runs and says so (`platformChecks.context.repositoryStructure = "unavailable"`).

### Platform checks on the model's claims

Stored next to the model's proposal (`platformChecks`), never mixed into it: each `candidateFiles` path gets `existsInRepository` `true` / `false` / `null` (null = no listing, or a *truncated* listing where absence proves nothing); relationship `ref`s that match no sibling are recorded as `unresolvedReferences` and dropped.

## 4a. Evidence — AI claims vs platform evidence *(Phase 4A.2)*

> **AI may suggest. CodeForge obtains. CodeForge owns.** A model can say "the limiter is missing"; only the platform can record that `otpThrottle.ts` exists. The two are stored in different objects and are never merged.

The real-provider validation (§12) showed why this matters: given only file *names*, the model asserted a rate limiter was missing while the listing contained `otpThrottle.ts` — with `high` confidence. Schema validation cannot catch that; evidence can.

**Claims (the model's side).** The analysis schema gains a strict, optional `claims` array. A claim is a *checkable statement*: `{ statement, kind, path, searchTerms, confidence }` with `kind` ∈ `FILE_EXISTS`, `FILE_ABSENT`, `FEATURE_ABSENT`, `FEATURE_PRESENT`, `BEHAVIOR_CORRECT`, `BEHAVIOR_INCORRECT`. There is **no** field for evidence, verification or a verdict; adding `verified`, `evidence`, `status`, … to a claim (or the analysis) makes the whole output malformed. Words like "verified", "confirmed", "tested" inside a `statement` are inert text — nothing consults them.

**Evidence (the platform's side).** `PlatformEvidence` is produced only by `collectEvidence` (`src/backlog/evidence.ts`), from the repository listing or from file content the platform read itself under the inspection budget. Only the types the platform can actually obtain exist:

| Type | Source | Meaning |
|---|---|---|
| `FILE_EXISTS` | listing | the path is in the repository |
| `FILE_NOT_FOUND` | listing | the path is absent — emitted **only when the listing is complete** (never on a truncated/unavailable one) |
| `PATH_MATCH` | listing | a path whose name contains ≥ min(2, n) of the claim's distinct search terms (one common word like `otp` alone never counts) |
| `CONTENT_MATCH` | file content | a line (with number and a secret-masked excerpt) containing ≥ min(2, n) of the terms |

(`TEST_RESULT`, `CONFIG_PRESENT`, `GIT_STATE` are deliberately not implemented — see GAP-033. Phase 4A.3/4A.4 add `SYMBOL_MATCH` (index), `SYMBOL_REFERENCE` (declared and referenced in a file the platform read) and the reserved `CHECK_RESULT`; see §4b–§4d.)

**Assessment (deterministic, pure — `assessClaims`).** Each claim gets `SUPPORTED` / `CONTRADICTED` / `UNRESOLVED` / `NOT_CHECKED`, the ids of the evidence behind it, a **platform-written** reason, and an `establishes` scope:

| Claim | Result |
|---|---|
| `FILE_EXISTS` / `FILE_ABSENT` | supported or contradicted by the listing; `UNRESOLVED` on a truncated listing, `NOT_CHECKED` with no repository |
| `FEATURE_ABSENT` | a matching path/content ⇒ **CONTRADICTED**; **nothing found ⇒ UNRESOLVED, never SUPPORTED** (a bounded search cannot prove absence) |
| `FEATURE_PRESENT` | a match ⇒ SUPPORTED — for *existence only* |
| `BEHAVIOR_CORRECT` / `BEHAVIOR_INCORRECT` | **always UNRESOLVED** (or CONTRADICTED only if the named file does not exist): existence never proves behavior, and no test is run |

`establishes` is `existence` or `nothing`, decided by the platform, so a behavioural sentence the model mislabels as `FEATURE_PRESENT` can never read as "CodeForge confirmed this sentence": the UI shows "Establishes only that matching files/code exist — not what they do." (This happened in a real run — §12.)

**Confidence cannot override evidence.** If a claim the model stated with `high` or `medium` confidence is CONTRADICTED, `deriveAnalysisOutcome` moves the item to `NEEDS_CLARIFICATION` (a human must look before a proposal can exist). `assessment.confidenceOverridden` is set whenever the model was `high` (on the claim, or overall) over a contradicted claim — the contradiction is *exposed*, never silently downgraded. A tentative (`low`) contradicted claim is recorded but does not block.

**Proposals consume the assessment.** `buildTaskProposalContent` copies each claim's status/reason/evidence into `claimAssessments` and sets `investigateFirst` when a claim the proposal would rest on is contradicted. The generated goal then leads with **INVESTIGATE FIRST — the analysis stated X, but the platform's own evidence contradicts it … begin by investigating the existing behavior**, lists UNRESOLVED/NOT_CHECKED claims as unverified, and the AI `summary` is labelled as AI-stated. It never says "implement X because nothing exists" when evidence says something does. The proposal is still `PENDING` until a human approves it.

### Repository content inspection (bounded, safe)

The platform — never the model — decides what is read, in two deterministic steps within **one shared budget per attempt**: (1) before the model call, the ≤6 most name-relevant readable files are excerpted into the prompt (line-numbered, secret-masked, ≤3,000 chars each, ≤16,000 total; delimited as data); (2) after it, files named by claims or hit by claim search terms are read to gather evidence.

| Control | Value / rule |
|---|---|
| Files | ≤ 12 per attempt (`maxFiles`) |
| Per file | ≤ 64 KiB (`maxFileBytes`) — larger is skipped, never truncated |
| Total | ≤ 256 KiB (`maxTotalBytes`) |
| Time | 30 s deadline for the whole inspection (`deadlineMs`); per-blob 20 s |
| Containment | contents are read from the git **object store by exact listed tree path** (`git cat-file blob HEAD:<path>`); nothing is checked out, so there is no working-tree path to traverse and no symlink to follow. A model/claim path is only ever a *lookup key*: `normalizeRepoPath` rejects `..`, absolute, `~`, drive letters, backslashes, NUL, empty segments; it must then be an exact member of the listing |
| Symlinks / submodules | mode `120000` / `160000` entries are refused, never read |
| Secrets | never read: `.env*`, `*.pem`/`*.key`/`*.p12`/`*.jks`, `id_rsa*`, `.npmrc`/`.netrc`, `credentials*`, `secrets*`, `service-account*.json`, `google-services.json`, `.ssh/` `.aws/` `.gnupg/` `.kube/` `secrets/` directories; a non-secret-named file containing a `-----BEGIN … PRIVATE KEY-----` marker is discarded after reading; credential-looking assignments and token shapes are masked in every excerpt and evidence line |
| Binary | NUL byte in the first 8 KB ⇒ skipped |
| Shell / network | none: only `git clone --depth 1 --filter=blob:none --no-checkout` (read-only, credential in env only) and per-blob `git cat-file`; no arbitrary command, no other network access |

Everything skipped is recorded (`inspection.filesSkipped` with a reason) so "not read" is never mistaken for "not there". This reuses no new filesystem layer: the existing project-workspace path protections guard the manifest directory; repository content deliberately never touches a filesystem path at all.

*Implementation note found by the real run:* the listing must NOT use `git ls-tree --long` — in a blobless clone that lazily fetches every blob (≈1,000 round trips for a mid-size repo) and timed out at 90 s. Sizes are enforced while reading instead.

### Usage and cost *(GAP-031)*

Real engine usage is normalized in one place (`src/coding-engine/engine-usage.ts`) and persisted: `CostMetadata { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, estimatedCost?, durationMs? }` on `analysis.cost` (and on `AgentRun.cost` for coding runs — the same adapter code). The OpenCode adapter now reads its real `step_finish` events (previously only legacy flat fields, so real runs recorded nothing) and sums steps.

- **Absent means unavailable, never `0`.** A field the engine did not report is absent/`null`; garbage values are ignored, not coerced; a run with no usage stores `null`.
- **Usage and estimated cost are separate objects.** `estimatedCost { amount, currency, pricingSource, pricingVersion }` exists only when the engine supplied a positive figure (`pricingSource: "opencode-reported"` = the engine's own estimate, **not** provider-billed; `pricingVersion` is `null` because the engine does not say). A reported cost of `0` next to real tokens means "no price known" and is recorded as *no* estimate. There is no platform price table, so no cost is ever computed by CodeForge.
- **Provider-agnostic.** The domain sees only normalized numbers; vendor parsing lives in the adapter. Provider/model come from the routing decision (`modelId`, `providerId`, `engineKey`). The API exposes `usage` (each field number or `null`) and `estimatedCost` (or `null`), never the raw blob.
- A malformed-output analysis keeps the usage its (real) call consumed; a call that failed before returning records none.

**Task-level roll-up *(Phase 4A.3)*.** `TaskReport.usage` (`src/reporting/usage-rollup.ts`) rolls a task's `AgentRun`s up: token totals (input/output/reasoning/cache-read/cache-write), the **provider-reported estimate**, per-run provider/model/usage/estimate, and per-phase (implementation / fix / review — derived from the same trigger the run history already shows) breakdowns. Three concepts are kept apart, because they will differ under BYOK: **raw usage** (what the engine reported), the **provider-reported estimate** (labelled with its source; never a billed amount), and a **CodeForge-calculated cost** — always `null`, since there is no explicit, versioned pricing source. Rules: each `AgentRun` row is counted **exactly once** (retries and fallbacks are separate rows, each once); a total is the sum over only the runs that reported that field, `runsReporting` says how many did, and a field nobody reported is `null` (the old report turned "unreported" into `0` — fixed); estimates in different currencies are never added; nothing is rounded. Failed/timed-out/cancelled runs now keep the usage the engine emitted before stopping, labelled `partial` (§4f, GAP-034).


## 4b. Repository index — selecting files by structure, not just names *(Phase 4A.3, GAP-032)*

> **The index ranks. Evidence decides.** The index tells the platform which files are *probably about* an item; it never tells anyone what the code *does*.

Name-relevance selection (§4) misses a file whose **name** shares nothing with the item — `src/accounts/manager.ts` declaring `deleteProfile()` for an item about "deleting the main profile". `src/backlog/repository-index.ts` adds a minimal, **deterministic, bounded, platform-generated** index. There is no vector database, no embeddings, no RAG and no model call anywhere in it.

**What is indexed (per file).** path · language · **application** (`backend`, `frontend/mobile`) · **feature** (`profiles` from `…/modules/profiles/…`) · **roles** (route / controller / service / model / repository / middleware / validator / provider / screen / component / hook / test / config — from path conventions and content) · size (when read) · **declared symbols** (classes, functions, methods, exported consts/types) · **route strings** (`POST /otp/send`, `GoRoute(path:)`, JSX `<Route path>`) · **imports**, resolved to *other files of the same repository* (relative, `@/` alias, Dart `package:`), with external packages kept separately. Extraction is line-oriented regex per language — **TypeScript/JavaScript and Dart today**, the languages actually in the connected Jinvani repository. A new language is one `LanguageExtractor` entry. It is *not* a parser and claims no understanding: a symbol is "a declaration with this name appears in this file".

**Ownership.** Platform-generated from repository contents through the *same* `RepositoryInspector` that guards every analysis read (secret paths, private-key markers, binary, symlink/submodule, size, deadline). AI cannot write, edit or vouch for an index entry, and AI-written file summaries are never stored as repository metadata.

**Lifecycle — revision-bound, cached, lazy, never a storm.**

```
repository revision (commit SHA)  →  cache lookup  →  hit: use it
                                                   →  miss: claim the build → build (once) → store → use it
```

- **Revision binding.** The session reports the exact `HEAD` SHA; the index row is keyed `(project, sourceKey, revision, schemaVersion)` where `sourceKey` hashes the repository URL + branch. A repository that has moved on **misses** and gets a new index; an old index is never returned for a new revision. Consumers also run `indexMismatch` (revision, source, schema) — defence in depth against a mislabelled row — and a failing check yields `state: "rejected"`, i.e. name-only selection.
- **Project isolation.** Every lookup includes `project_id`; two projects pointing at the same repository build separate rows.
- **No indexing storm, no second worker system.** The index is built lazily *inside an analysis job* (so the existing lease/heartbeat/cancel/global-concurrency-cap all apply). The `repository_indexes` row *is* the build claim (`INSERT OR IGNORE` … `BUILDING` + lease): a second analysis that finds a live claim does **not** wait and does **not** build — it proceeds with name-only selection and records `index.state = "building_elsewhere"`. A crashed builder's lease expires and can be taken over; a failed build backs off (10 min) before being retried; an aborted build abandons its claim. Only the newest 3 revisions per project are retained.
- **Bounded build (once per revision), separate from analysis limits.** ≤ 900 files, 64 KiB/file, 8 MiB total, 180 s, 8 concurrent blob reads (the file/byte budget can be overrun by at most `concurrency − 1` in-flight reads). These never raise the per-analysis inspection limits (§4a: 12 files / 256 KiB / 30 s), which are unchanged. If a limit stops the build early the index is stored as **partial** (`coverage.complete = false`, skip reasons counted) and the UI says so — it never pretends to be complete.
- **Secrets.** Secret-named files are excluded from the index entirely (not even listed); a file containing a private-key marker is not content-indexed; symlinks/submodules are never indexed. The index row contains identifiers, route strings and paths only.

**File selection (`rankFiles`, pure).** Per file: name (+3), directory (+1), declared symbol (+4), route (+3), feature/application match (+2), then a **structural** step — files a strong match imports, or that import it, get +2 — a small role nudge (+1, only for files that already matched), a Project-Context nudge (+1, only for files inside an application/feature the context *names*; it can never add a file), and a penalty for test files unless the item is about tests. Query words also match their stems (`deleting` → `delete`). Ties break by path. The result is bounded by the *existing* limits (≤ 60 ranked paths shown, ≤ 6 excerpts). Each analysis records how it chose (`platformChecks.context.selection`: method `index`|`name`, the top files with reasons, and `context.index`: state, revision, counts).

**Excerpts.** Excerpts now show up to five *windows* around the best-matching lines (most distinct terms first) instead of only the region after the first hit — same character budget, gaps marked `…`. A real run (§14) showed why: the model saw a helper's definition at the top of a long file but never its call site 100 lines down, and concluded it was unused.

**Existence ≠ structure ≠ behaviour ≠ execution.** Four rungs, never conflated:

| Rung | Obtained how | What it can say |
|---|---|---|
| Existence | listing, file content, **index symbols** (`SYMBOL_MATCH`, bound to the revision) | "a file / declaration / route with this name is there at revision R" |
| Structure | index imports/routes | **ranking only** — never evidence for or against a claim |
| Behaviour | not obtainable by inspection | claims about it are always `UNRESOLVED` |
| Execution | the verification seam (§4c) | "the project's configured check returned X at revision R" — about the *check*, not a claim |

`SYMBOL_MATCH` is evidence like `CONTENT_MATCH`: it can CONTRADICT "nothing implements X" (something declared that name) and SUPPORT existence, needs ≥ min(2, n) distinct terms, and carries `revision`. An index that is partial, stale or missing simply produces no such evidence — absence in the index is never absence in the repository.

## 4c. The verification seam — executed evidence, designed but switched off *(Phase 4A.3, GAP-033)*

```
AI claim  →  required verification  →  platform verification executor  →  CHECK_RESULT evidence
                (platform decides)        (existing approved-check machinery)     (bound to a revision)
```

`src/backlog/verification.ts`. **What exists:** `planVerification` (which approved check would bear on a `BEHAVIOR_*` claim — only the project's own configured `test` command, never an invented one), `runVerification` (policy gate → check must be allowed **and** configured → workspace `HEAD` must equal the analysed revision → the existing `executeApprovedVerification` → `runCheck`, so the existing timeout and cancellation apply, one run serving all claims that need the same check), and `applyVerification` (adds `CHECK_RESULT` evidence and updates the requirement rows).

**What is deliberately not on:** production analysis runs with `ANALYSIS_VERIFICATION_DISABLED`. It only *records* the requirement as `state: "not_run"` (shown in the UI as "not run — analysis is read-only by policy"). Nothing is executed during backlog analysis, and no workspace is prepared for it.

**Why the model cannot use it.** The analysis schema is strict and has no verification/command/check field (an output with one is malformed and rejected whole); a requirement's `checkId` comes from the project's configuration; the command that would run is looked up *by name* from that configuration. Injected ids (`rm -rf /`, `node x; touch pwned`, `TEST`) are refused before any process is spawned (`tests/backlog-verification.test.ts`).

**What a result would mean.** `CHECK_RESULT` says the project's `test` check passed/failed at revision R. Checks are not bound to individual claims (a project has one `test` command, not a test per behaviour), so a passing check **does not** make a behaviour claim `SUPPORTED`: the claim stays `UNRESOLVED` and its reason says "that is the project's whole check, not a test of this claim". "The code contains X" and "the configured test for X passed" remain different statements; closing that needs per-claim check binding (later phase). **GAP-033 therefore stays open.**

## 4d. Evidence-aware reconciliation *(Phase 4A.4)*

```
item → repository/index investigation → AI analysis → AI claims → platform evidence → RECONCILIATION → final analysis state
```

Three objects are stored side by side and never merged: **AI CLAIM** (`result.claims`), **PLATFORM EVIDENCE** (`platformChecks.assessment.evidence`) and **RECONCILIATION** (`assessment.reconciliation`, produced by the pure `reconcile()` in `src/backlog/reconciliation.ts`). The model is never asked whether evidence contradicts its own claim; the platform decides, from evidence alone, *after* the model answered.

**What the claim asserts, not what the model labelled it.** Real runs showed the model mislabelling both ways, so `reconcile` classifies by content:

| The claim … | Can evidence contradict it? | Result |
|---|---|---|
| **explicitly asserts an implementation absence** (`FEATURE_ABSENT`/`FILE_ABSENT`, or wording like "there is no…", "nothing enforces…", "not implemented") | yes | `IMPLEMENTATION_PRESENT` **strong** when the file exists, or a matching declaration (`SYMBOL_MATCH`, ≥ 2 distinct terms within one declared name) is also **wired in** — `SYMBOL_REFERENCE`: declared at L*n*, referenced at L*m* in a file the platform read; `IMPLEMENTATION_POSSIBLE` (weak) when related names/content exist but nothing is shown wired in; `UNRESOLVED` when nothing was found (a bounded search never proves absence) |
| is a **behaviour** claim worded with broad negation ("does not check…", "without validation") | only as a lead | `IMPLEMENTATION_PRESENT` **weak** if — and only if — the platform sees the declaration wired in; otherwise `UNRESOLVED`. Its *status* is never CONTRADICTED. |
| is a **behaviour** claim | no | **always `UNRESOLVED`**: existence, a declaration, even a call does not establish behaviour |
| says something exists | — | `NO_CONFLICT` if supported |
| has a platform check **explicitly bound to it** that PASSED at this revision | — | `CHECK_VERIFIED` (`behaviorVerified: true`). No check is bound to any claim today, so this cannot occur in production analysis; a generic passing check never verifies a claim |

**The already-implemented signal** (`reconciliation.alreadyImplemented`: `strong` | `possible` | `none`) means only *"implementation evidence conflicts with the reported absence; behavioural verification is still required."* It never means fixed. Effects: `strong` sends the item to `NEEDS_CLARIFICATION` whatever confidence the model claimed (a human looks first); `possible` is shown and does not block. Either way the proposal (if a human generates one) carries `implementationConflict`, sets `investigateFirst`, and its goal opens with an **IMPLEMENTATION EVIDENCE CONFLICTS WITH THE REPORTED ABSENCE** block telling the implementer to verify existing behaviour first and change code only if the reported problem proves real. Nothing closes the item, creates a task, or starts anything; conversion still needs an explicit human Approve then Convert, and a human still has to Start the task.

**Revision integrity.** Reconciliation is done at one revision (the analysis session's commit). Evidence is stamped with the revision it describes; evidence stamped with any other revision — a stale index row, a `CHECK_RESULT` from another commit — is **ignored** and listed in `reconciliation.ignoredEvidence`; with an unknown analysed revision no stamped evidence is usable. `collectEvidence` also refuses an index built for another revision. So evidence from revision A can never reconcile a claim analysed at B.

**Honest limits.** The signal only fires when the model *makes* an absence-shaped claim or one the platform recognises by wording. In every real run so far (§14, §15) the model accepted the bug report's premise and made behavioural claims, which reconcile to `UNRESOLVED` — the real-model contradiction/conflict path has **not** been observed; it is proven only by deterministic fixtures (`tests/backlog-reconciliation.test.ts`). Item premises phrased as behaviour ("a user can delete every profile") are not reconciled at all: the platform cannot tell from structure that they are already handled.

## 4e. Retrieval / selection benchmark *(Phase 4A.4, GAP-032)*

`npm run benchmark:retrieval -- --ground-truth <file> --repo <local git dir> [--out-json f] [--out-md f]` measures what the production pipeline (`BacklogContextBuilder`: ranking + excerpt choice under the real limits) would show a model for each item, replayed at the item's **exact revision**, with the repository index and as the name-only baseline (the two differ only in the index). Deterministic (no model, no network; results byte-identical across runs) and machine-readable (JSON) plus human-readable (Markdown).

*Ground truth vs system output are separate types.* A `GroundTruthItem` carries the item text, the revision and human/independent `expectedFiles` (optionally symbols/application); a `SelectionOutput` (candidates, excerpts) is scored against it and never used to create expectations. Metrics: candidate recall and excerpt recall (macro and micro), recall@N, rank of each expected file, item-level hit rate, mean/median rank of found files, and **not-in-ground-truth rate** (an upper bound on "irrelevant": a file can be relevant without being one the fix modified).

*The Jinvani ground truth is project data and is kept outside this repository* (`.data/benchmarks/`; CLAUDE.md: no project-specific content in the platform repo). Its provenance: for each **merged** Jinvani fix, the files the real fix **modified** (`git diff --name-status`, status `M`, base commit → fix commit), excluding files the fix added (not selectable at the item's revision), tests and implementer scratch scripts; descriptions are the QA-style symptom text with root-cause/required-behaviour sections removed. It is objective repository history, **not** adjudicated by an independent human reviewer, and a fix's modified files are a lower bound on relevance. Only 17 tasks were DONE (not 20–30): one had no modified pre-existing source file, leaving **16 items / 38 expected files** — a small sample; nothing was fabricated to enlarge it. See §15 for results.

## 4f. Usage of failed invocations *(Phase 4A.4, GAP-034 — closed)*

`CostMetadata.usageStatus` = `complete` | `partial`; absent (`cost: null`) = **unavailable**. The OpenCode adapter now accumulates `step_finish` usage across the whole invocation: usage emitted by an attempt that fails, is killed by the timeout or is cancelled is kept (a half-written last line is not usage) and attached to the thrown engine error (`usageFromError`), which the orchestrator persists on the failed/cancelled `AgentRun` and the backlog analyzer keeps on a failed analysis. A normal exit is `complete`; anything else `partial` (a lower bound); nothing emitted ⇒ `null`, never zero. A priced part merged with an unpriced one drops the estimate rather than fabricate a total. The task roll-up adds `usageStatus` per run and per task (`complete` only if every run is; `unavailable` if none has usage; else `partial`), treating a legacy row without the field as complete only when the run completed. Remaining loss: a job-level analysis *retry* (a new attempt after a transient failure) writes no row for the failed attempt, so its usage is not recorded.

## 5. Duplicates and dependencies are proposals

A model's `duplicateCandidates` / `dependencyCandidates` are resolved **only** against sibling items of the *same project* (case-insensitive `externalRef` or exact `id`). An unknown ref, a self-reference, or a dependency that would close a cycle (direct or indirect, over live `DEPENDS_ON` proposals — the same reachability check `TaskService.addDependency` uses) is dropped and reported. The rest become `PROPOSED` rows with a deterministic id (`sha256(kind|from|to)`), a confidence level and a rationale. A re-analysis replaces the item's own still-`PROPOSED` rows and never touches a human decision.

**Nothing merges, deletes, reorders or blocks anything.** Duplicate/dependency data reaches a task proposal as information only, and conversion never creates `task_dependencies` (that decision belongs to Phase 4C). `CONFIRMED`/`DISMISSED` statuses exist in the schema for that later workflow but nothing produces them yet.

## 6. Task proposal and conversion

`POST /backlog/:id/proposal` builds a proposal **deterministically from the latest successful analysis — no model call** (`task-proposal-builder.ts`): title, the exact `goal` text that would become `Task.goal` (item description + an analysis-notes block explicitly labelled as unverified suggestions, with each candidate file annotated by the *platform's* existence check), summary, acceptance criteria, validation, informational dependencies/duplicate warnings, and uncertainty + missing information. It is idempotent (one live proposal per item — partial unique index), and only an `ANALYZED` item may get one. The stored content is re-validated (`TaskProposalContentSchema`, strict) on every read; a corrupted/hand-edited row reads as `content: null` and can be rejected but never approved or converted.

`POST /task-proposals/:id/approve` (human) then `POST /task-proposals/:id/convert` (human) are **two separate calls**. Conversion goes through the **existing `TaskService.create`** — the same path a hand-created task takes — so the Task lands in `BACKLOG`, and a person still has to press **Start Task**. It records `origin: { backlogItemId, taskProposalId }` on the `TASK_CREATED` event. The branch/workspace/review/verification/recovery machinery is untouched.

### Concurrency and idempotency (structural, not frontend)

| Situation | Guarantee | Mechanism |
|---|---|---|
| Repeated / racing `Analyze` for one item (same or different API process) | one job; the others get that job back (`enqueued:false`) | item flip + job insert in one transaction; partial unique index (§4) |
| Two workers, one job | only one executes it | atomic claim + generation fencing (§4) |
| Worker dies mid-analysis | recovered, bounded, one result | lease expiry + attempt bound (§4) |
| More jobs than the cap | at most `MAX_BACKLOG_ANALYSIS_CONCURRENCY` live, across all workers | count inside the claim `UPDATE` (§4) |
| Stale worker finishes after being replaced | its result is discarded, nothing half-written | fenced single transaction |
| Repeated / racing proposal generation | one proposal | idempotent read + partial unique index |
| Repeated approval | no-op, decision not re-stamped | `UPDATE … WHERE status='PENDING'` |
| Repeated conversion | same Task returned (`200`, `alreadyConverted`) | `CONVERTED` short-circuit |
| Simultaneous conversions (requests or processes) | exactly one Task; loser gets `409 CONVERSION_IN_PROGRESS` or the finished result | atomic claim + **Task id reserved on the proposal**, unique-indexed; Task created *with that id* |
| Crash after Task created, before proposal finalized | retry adopts the existing Task, never a second | reserved id + lease re-claim |
| Task creation fails | proposal returns to `APPROVED`, retryable | claim release; reserved id kept |
| Reject item during/after conversion | refused | checked inside the same transaction |

Multi-row changes use `runInTransaction` (`BEGIN IMMEDIATE`, synchronous callbacks only).

## 7. Observability

`backlog_events` (append-only; returned on `GET /backlog/:id`): item created/updated/rejected; `ANALYSIS_QUEUED` (API), `ANALYSIS_STARTED` (per worker attempt), `ANALYSIS_RETRY_SCHEDULED`, `ANALYSIS_COMPLETED` / `ANALYSIS_FAILED` / `ANALYSIS_CANCELLED` (job id, attempt n of m, model, provider, fallback index, duration, outcome status, context summary, proposal counts, failure category); proposal generated / approved / rejected / converted. Failure text and malformed-output excerpts pass through `redactSecrets` and are bounded; raw model output is never stored beyond a ≤500-character excerpt of a *failed* analysis.

## 8. Frontend

A **Backlog** tab on the project (`/projects/:id/backlog`, `/projects/:id/backlog/:itemId`): list + "New backlog item"; detail page with analysis (proposal vs platform-verified file checks, blocking questions marked), duplicate and dependency proposals, the task proposal, and Approve / Reject / Convert as separate explicit actions; activity log. The analysis panel shows the **job**: *Queued — waiting for a worker*, *Running — attempt n of m* (model/provider), *Retry scheduled* (cause + next attempt time), *Failed* (category, reason, nothing accepted), *Cancelled*, with a **Cancel analysis** button while queued/running — it never implies the call is synchronous. Polling only while an item is `ANALYZING` or a proposal is `CONVERTING`. See [UI_ARCHITECTURE.md](./UI_ARCHITECTURE.md).

## 9. What this does not do (and does not guarantee)

- **No execution.** Nothing starts, schedules, releases or runs a task; no "Start All"; no dependency-aware scheduler (4E).
- **No import** — the API can only create `manual` items (bulk/sheet import is 4B); no Jira/Slack/Sentry/MCP.
- **No cross-task intelligence** beyond per-item proposals; proposals are not turned into task dependencies (4C).
- **No project chat** (4D), no vector store/RAG, no embeddings.
- **Analysis is only partly code-aware.** File selection now uses a revision-bound index of declared symbols, routes, feature/module and imports (§4b) in addition to names — but that is a regex-extracted shortlist for TypeScript/JavaScript/Dart, not understanding of behaviour, not a call graph, and it can still miss the relevant file. Root-cause investigation remains the Implementer's job (GAP-020, GAP-032). Behaviour claims can never be settled (no checks run during analysis — §4c, GAP-033).
- **Analysis quality is not guaranteed.** The output is a *proposal* from a model that has read the item text, project context, sibling items and file **names**. In the first real runs (§12) every candidate file was real, but a summary asserted "lacks rate limiting" while the listing itself contained `otpThrottle.ts` — the model was confident where the evidence pointed the other way. Treat every claim as a lead; the platform verifies only what it can (file existence, reference resolution).
- **Cost is an engine-reported estimate.** Real usage is recorded and rolled up per task (§4a, 4A.3), but the only price is the engine's own estimate; there is no platform price table (CodeForge-calculated cost is `null`), and a job-level analysis retry records no usage for its failed attempt (§4f).
- **No automatic merge or duplicate-collapsing** of items, ever.
- **A worker must be running.** With none, jobs stay `QUEUED` (the UI says "waiting for a worker"); nothing is lost.
- **Fixture engine:** with `CODING_ENGINE=fixture` the demo reviewer handler does not return analysis JSON, so items land in `NEEDS_CLARIFICATION`. Tests use a scripted `CodingEngine`; `npm run validate:backlog` refuses `fixture`.

## 10. Where the code is

`src/backlog/` (types, state machine, strict schema, prompt, context builder, repository-structure seam, analyzer, relationship resolution, proposal builder) · `src/application/backlog-service.ts` (API side: CRUD, enqueue/cancel, proposals, conversion) · `src/application/backlog-analysis-executor.ts` (worker side: one attempt → settle) · `src/worker/backlog-analysis-runner.ts` (claim loop, heartbeat, global cap, stop) · `src/worker/worker.ts` (drives the runner) · `src/persistence/repositories/{backlog-item,backlog-analysis,backlog-analysis-job,backlog-relationship,task-proposal,backlog-event}-repository.ts` · `src/persistence/migrations/013_backlog_intelligence.sql`, `014_backlog_analysis_jobs.sql` · `src/persistence/transaction.ts` · `src/api/routes/backlog.ts`, `src/api/backlog-dto.ts` · `src/backlog/{evidence,repository-inspector,repository-index,repository-index-service,index-selection,verification}.ts`, `src/persistence/repositories/repository-index-repository.ts`, `migrations/015_repository_indexes.sql`, `src/coding-engine/engine-usage.ts`, `src/reporting/usage-rollup.ts` · `src/cli/validate-backlog-analysis.ts`, `src/cli/validate-task-usage.ts` · `web/src/{pages,components/backlog,hooks,api}/…Backlog*`. Tests: `tests/backlog-{domain,service,persistence,api,analysis-worker,evidence,index,verification}.test.ts`, `tests/engine-usage.test.ts`, `tests/usage-rollup.test.ts`, `tests/helpers/backlog-harness.ts`.

## 11. Manual real-model validation (`npm run validate:backlog`)

Automated tests use a scripted `CodingEngine`; they prove the platform's behavior, **not** any model's quality. This command runs the production path with the **real** configured engine/model and then checks the safety invariants (no Task, task event, agent run, workspace or proposal created; no GitHub mutation is even reachable — the only network touch is a read-only tree-only clone for the file listing).

Prerequisites: `CODING_ENGINE=opencode` (default), `OPENCODE_MODEL` set (e.g. `google/gemini-3.1-flash-lite`), the provider credential OpenCode holds (`opencode auth list`), the project's GitHub connection (`CREDENTIAL_ENCRYPTION_KEY`) if you want a real repository listing. It refuses `CODING_ENGINE=fixture`.

```
npm run validate:backlog -- --project <projectId> \
  --ref BUG-019 --title "User can spam OTP requests" \
  --description "A user can keep tapping Resend OTP and gets an SMS every time." \
  --sibling "BUG-002|OTP can be requested unlimited times|There is no limit on how many times an OTP can be requested." \
  [--json-out report.json]
```

It works on a **copy** of the database and project-workspaces in a temp dir (`--in-place` opts out), enqueues the item, plays the worker (`runner.drain()`), prints the analysis, the routing decision, the relationship proposals and the invariants, and exits non-zero if an invariant fails. To exercise a *separate* worker process as well: copy the database, cancel any non-terminal tasks **in the copy** (otherwise the worker would execute them), enqueue with the service, run `npm run worker` against the copy with `DB_PATH` pointing at it, poll `backlog_analysis_jobs`, then `SIGTERM` the worker (see §12).

## 12. Evidence — first real-provider validation *(Phase 4A.1, 2026-09-25)*

Real OpenCode 1.18.29 → `google/gemini-3.1-flash-lite`, project *Jinvani_OTT*, items derived from real QA-sheet entries (BUG-073, BUG-019/BUG-002…), on a database copy; repository listing of 1,066 files fetched from GitHub read-only.

| Check | Result |
|---|---|
| Real model invoked through the existing engine/registry path | yes (`configured default for backlog_analysis`; `providerId` `google`) |
| API-side enqueue | ~1–4 ms, no model call |
| Job lifecycle | QUEUED → RUNNING → SUCCEEDED, attempt 1/3, ~11–12 s |
| Output | valid JSON, **strict schema accepted**, persisted; no tool calls made by the model (verified in the OpenCode session: reasoning + text parts only) |
| Real usage (from OpenCode's own DB) | 12,446 input / 349 output / 1,150 reasoning tokens, ≈ US$0.005 — **not** captured into `analysis.cost` (GAP-031) |
| Safety invariants | no Task, task event, agent run, workspace or proposal created; item not converted |
| Separate `run-worker` process | picked the job up from the DB, completed it, exited 0 on `SIGTERM` |

Factual observations of the structured analysis (not a quality verdict): summaries, `issueType: bug` and `affectedApplication: backend` were plausible; **all** candidate files (3/3 and 3/3) existed in the real listing (platform-verified); a genuinely overlapping pair (BUG-019 ↔ BUG-002) was flagged `POSSIBLE_DUPLICATE`, confidence *high*, and persisted as a proposal, while unrelated siblings were correctly not flagged; blocking questions (limit and lockout duration) put the items in `NEEDS_CLARIFICATION`, as designed. Weaknesses seen: the summary asserts the limiter is *missing* even though the listing it was given contains `otpThrottle.ts`/`otpThrottle.model.ts` (the item's fix had already landed in the connected repository), and `confidence.overall` was `high` despite that. The current contract carries enough structure to improve this later without change (`uncertainties`, `platformChecks`); no contract change was made.

## 13. Evidence — Phase 4A.2 real-provider runs and live browser validation *(2026-09-25)*

**Real provider (OpenCode 1.18.29 → `google/gemini-3.1-flash-lite`, Jinvani_OTT on a database copy, real GitHub repository — 1,066 files):**

| Run | What happened |
|---|---|
| Listing bug | first run: repository "unavailable" after 90 s — `ls-tree --long` lazily fetched every blob in the blobless clone (§4a note). Fixed; the analysis correctly degraded (claim `NOT_CHECKED`, item not blocked) |
| BUG-073 (after fix) | 20.5 s; listing complete; **6 files (27 KB) read and excerpted**; the model — now seeing real code — no longer asserted the limiter was missing: it cited the model's `attempts` field and the send-throttle file, claim assessments `SUPPORTED` (existence) ×2, none contradicted |
| BUG-019 (+ sibling BUG-002) | 26 s; cited the real mobile file `frontend/mobile/lib/mobile/screens/auth/otp_page.dart`; `POSSIBLE_DUPLICATE` BUG-002 (high) persisted; behavioural claim `UNRESOLVED`; **no contradiction fired** |
| Usage | captured and persisted: e.g. 7,499 in / 519 out / 1,507 reasoning / 8,157 cache-read / 0 cache-write; `estimatedCost` US$0.0051 from `opencode-reported`; provider `google` |

**What this does and does not show.** It shows the pipeline works end to end with a real model and that real content grounds the model better than names alone (one observation each, not a quality benchmark). The **contradiction path was NOT triggered by the real model** in these runs — it is proven deterministically (fixture Jinvani scenario, `tests/backlog-evidence.test.ts`), not by a real model contradicting itself. One real weakness was observed: the model labelled a behavioural sentence as `FEATURE_PRESENT`, so the platform marked it SUPPORTED-for-existence; the `establishes` scope and a prompt instruction were added in response (not re-observed to be sufficient).

**Live browser (headless Chrome driven over the DevTools Protocol against a real API process + real worker process + Vite dev server + real model; scratch database):**
registered/logged in through the UI → created an item through the dialog → Analyze with **no worker running** showed *Queued — waiting for a worker* (and stayed queued across several poll intervals: nothing runs in the API process) → **Cancel analysis** → Analyze again → started the real worker → UI showed *Running — attempt 1 of 3* → result appeared without a reload, with three separate sections (AI analysis / Platform evidence / Evidence assessment), usage tokens, and "Estimated cost: US$0.005163 — estimate reported by opencode-reported (not provider-billed)"; injected real-shaped 503s ahead of the real model → *Retry scheduled — attempt 1 of 3 failed …*, then success on attempt 2; three consecutive failures → *Analysis failed … Nothing was accepted and no task can be created from it*, item back to NEW; the evidence layout at 390 px has no horizontal scroll; 0 console errors. It also caught a UX defect unit tests had not: a QUEUED job showed an "Analyzing…" spinner button — fixed (*Queued…*). The `.env` secret in the demo repository never appeared in the page. Not covered by any browser run: approving/converting a proposal, and a real model actually contradicting itself.

## 14. Evidence — Phase 4A.3 real-provider runs *(2026-09-25/26)*

Real OpenCode 1.18.29 → `google/gemini-3.1-flash-lite`, project *Jinvani_OTT* (real GitHub repository, revision `714503897313`, 936 indexable files; index of 834 content-indexed files / 3,622 symbols built in-run, `complete: false`), on a copy of the database. Every run below is **one observation** — not a benchmark, and not evidence the model is or is not accurate.

**Contradiction test on an already-implemented item.** Chosen from real, DONE Jinvani tasks whose fix is on `main`; the description is only the QA-style symptom (no root cause, no file hints). Ground truth, read directly from the repository at that revision: for BUG-043 (delete main/last profile) `ProfileService.deleteProfile` already calls `getProfileDeleteBlocker` (`profile.service.ts:127`).

| Run | Model claims (kind, confidence) | Platform result | Item | Latency / usage |
|---|---|---|---|---|
| BUG-043 #1 | FILE_EXISTS high; BEHAVIOR_INCORRECT high ("controller calls the service with no validation") | SUPPORTED (existence); BEHAVIOR UNRESOLVED | NEEDS_CLARIFICATION (its own blocking question) | 131 s; 18,225 in / 677 out / 2,615 reasoning; US$0.0095 |
| BUG-043 #2 (after multi-window excerpts) | FEATURE_PRESENT high (blocker exists); BEHAVIOR_INCORRECT high | SUPPORTED; UNRESOLVED; platform evidence includes `CONTENT_MATCH … L121: const blockerMessage = getProfileDeleteBlocker(…)` | NEEDS_CLARIFICATION (blocking questions) | 125 s; US$0.0077 |
| BUG-043 #3 (final code) | FEATURE_PRESENT high; BEHAVIOR_INCORRECT high | SUPPORTED; UNRESOLVED; evidence lists `getProfileDeleteBlocker` symbol | **ANALYZED** | 138 s; US$0.0078 |
| BUG-001 #1, #2 / SEC mobile-number #1, #2 | only BEHAVIOR_INCORRECT / FILE_EXISTS / FEATURE_PRESENT claims | UNRESOLVED / SUPPORTED-existence | NEEDS_CLARIFICATION | 125–159 s; US$0.005–0.0075 |

**Result: "Real contradiction scenario executed, but the model did not generate a contradictory claim."** In 7 real analyses across 3 implemented items the model never asserted that something was *absent* (the only claim shape the platform can CONTRADICT); it accepted each bug report's premise and made *behavioural* claims, which inspection can never settle (`UNRESOLVED`). Nothing was tuned to force a contradiction. The deterministic fixture (`tests/backlog-evidence.test.ts`) remains the regression test for that path.

**What the runs did show (limitations, all recorded in GAP-032/033):**
- The platform **could not** refute the model's wrong belief ("BUG-043 is unfixed") — it can only show its own evidence next to it (the call site at L121 was shown to a human, but not to the model, since evidence is collected after the call). In run #3 the item ended `ANALYZED`, i.e. *not* flagged, although the requested behaviour already exists: a human reading the evidence would see it; the platform does not conclude it.
- **File selection is not reliably good.** The index found `getProfileDeleteBlocker`/`deleteProfileHandler` by symbol (a name-only search cannot), but generic words ("error", "message", "mobile", "status") drove the top-ranked files for BUG-001 to payment/gift-card files, and the backend files where the real fix landed were often outside the six excerpted. Two fixes were made after seeing this — excerpts as several windows (a helper's call site 100 lines below its definition was invisible) and document-frequency damping of common words — then the same items were re-run, so the re-runs are **not independent** evidence of improvement (BUG-043's backend service was in the excerpts in run #2 and not in #3).
- Two precision defects in the *new* evidence were found and fixed from real output: `SYMBOL_MATCH` accepted terms spread over unrelated symbols (`parseUserAgent` + `recordSuccessfulOtpSend` ⇒ "user OTP"); terms must now co-occur in one declared name.
- The first analysis of a revision costs ~1–1.5 min extra (834 blobs fetched one by one from a blobless clone) — cached after.

**Real task usage validation** (`npm run validate:task-usage`, real OpenCode, real model, throwaway local fixture repo, no fixture engine): task `REVIEW` after 81 s (run 1) and again on the final code. Final run: 3 AgentRuns — implementer (75,181 in / 1,006 out / 620 reasoning), reviewer (7,627 / 251 / 630), and the reviewer's **verification follow-up** (31,877 / 299 / 609; distinguished as phase `verification`). Raw `step_finish` events (captured by a `tee` wrapper, parsed independently) == persisted `agent_runs.cost_json` == report totals **exactly**, field by field and run by run: 114,685 in / 1,556 out / 1,859 reasoning / 98,079 cache-read / 0 cache-write; engine-reported estimate US$0.0362457 (3 of 3 runs, source `opencode-reported`); CodeForge-calculated cost `null`. The earlier run reconciled identically (84,649 / 1,156 / 1,277 / 105,838; US$0.0274577).

## 15. Evidence — Phase 4A.4 *(2026-09-26)*

**Retrieval benchmark** (Jinvani_OTT, real merged fixes replayed at each item's own pre-fix revision; **16 items, 38 expected files**; ground truth = files the real fix modified, see §4e for provenance and caveats; two identical runs produced byte-identical JSON):

| Metric | name-only baseline | with index |
|---|---|---|
| Candidate recall, macro / micro | 58.3% / 60.5% (23/38) | 78.1% / 84.2% (32/38) |
| Recall in top 5 / 10 / 20 | 17.2% / 27.1% / 44.3% | 25.0% / 42.2% / 64.6% |
| Excerpt recall, macro / micro | 17.2% / 23.7% | 32.8% / 34.2% |
| Items with ≥1 expected file **excerpted** | 37.5% (6/16) | 50.0% (8/16) |
| Mean / median rank of found expected files | 15.8 / 10 | 15.6 / 11 |
| Candidates not in ground truth (upper bound on irrelevant) | 97.6% | 96.7% |
| Excerpts not in ground truth | 90.6% | 86.5% |

Subsets: on the 11 items whose symptom text names **no file**, excerpt recall is 7.6% → 37.9% and items with an excerpted expected file 18.2% → 54.5%; on the 5 items whose symptom **does** name files, candidate recall is 95% either way and excerpt recall is *worse* with the index (38.3% → 21.7%). **Reading it honestly:** the index materially improves *finding* expected files (recall 60% → 84%), but rank quality is unchanged (median ≈ 10–11), half the items still show the model none of the files the real fix touched, and ~87–90% of excerpts are not files the fix modified. That is a measurement on a small sample, not a pass — selection is not good enough to call solved, and nothing was tuned to this benchmark.

**Real-model reconciliation runs** (OpenCode 1.18.29 → `google/gemini-3.1-flash-lite`, Jinvani revision `714503897313`, QA-style symptom only, three items already implemented on `main`; BUG-073's QA wording — "There is no limit on OTP attempts during login." — is an explicit absence):

| Item | Model claims | Reconciliation | Item | Latency / usage |
|---|---|---|---|---|
| BUG-073 | FILE_EXISTS ×2, BEHAVIOR_CORRECT | NO_CONFLICT ×2, UNRESOLVED; `alreadyImplemented: none` | NEEDS_CLARIFICATION | 115 s; 16,674 in / 808 out / 2,662 reasoning; US$0.0094 |
| BUG-043 | BEHAVIOR_INCORRECT ("lacks a validation check for the last profile"), FILE_EXISTS | UNRESOLVED; NO_CONFLICT; `none` | NEEDS_CLARIFICATION | 106 s; US$0.0068 |
| mobile-number change | FEATURE_PRESENT, FILE_EXISTS, BEHAVIOR_INCORRECT | NO_CONFLICT ×2, UNRESOLVED; `none` | NEEDS_CLARIFICATION | 227 s; US$0.0065 |

**A real-model contradiction/conflict was NOT observed.** Even when the item text is an explicit absence (BUG-073) the model did not assert one; it cited the existing files. Every reconciliation was `UNRESOLVED`/`NO_CONFLICT` and `alreadyImplemented` was `none`. The conflict path is validated only by the deterministic fixture (`tests/backlog-reconciliation.test.ts`, including the flagship "deletion does not check whether it is allowed" case), not by a real model. (An earlier attempt at BUG-043 failed to start — the copy of the database was locked by a concurrent process — and was simply re-run.)

**Real task usage, success path** (final code, real task through the orchestrator, 3 AgentRuns): raw OpenCode `step_finish` == persisted `agent_runs.cost_json` == task report, exactly — 86,369 input / 957 output / 1,471 reasoning / 81,370 cache-read / 0 cache-write tokens; engine estimate US$0.0272685 (3 of 3 runs); CodeForge-calculated cost `null`.

**Real task usage, failure/timeout path (GAP-034):** a real task whose implementer invocation had a 15,000 ms timeout: OpenCode was killed after emitting **2** `step_finish` events; the failed `AgentRun` persisted `usageStatus: "partial"` with 5,999 input / 125 output / 93 reasoning / 16,278 cache-read / 0 cache-write and estimate US$0.0022337 — exactly the raw events (raw == persisted == report totals, field by field); the task report's `usageStatus` was `partial`. The "killed before any usage ⇒ `null`/unavailable" case is covered by real-adapter tests with a mock executable (a real run would have to be timed to die before its first step).

