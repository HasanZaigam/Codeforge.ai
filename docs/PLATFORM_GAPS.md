# Platform Gaps — field notes from real-world use

A living log of gaps, friction and failure modes discovered while running this platform against **real production codebases** (as opposed to the fixture repositories the test suite uses).

## Why this file exists

The other documents in `docs/` describe the system as designed. This one records where the running system diverged from that design, or where the design turned out to be incomplete once a real project was connected. Every entry is something a user hit — not something anticipated in a planning session.

**Rules for this file:**
- One entry per distinct gap. Evidence first (what actually happened), then impact, then a proposed direction.
- Keep entries **platform-general**. The connected project that surfaced a gap is named only as evidence. Never let project-specific configuration, credentials or context leak into this repository — see [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md) and the ground rules in [CLAUDE.md](../CLAUDE.md).
- A gap is not closed until the entry says so, with the commit or slice that closed it.
- Resist designing the fix here. Record the problem precisely; the fix belongs in a slice plan or [TECHNICAL_DECISIONS.md](./TECHNICAL_DECISIONS.md).

## Severity

| | Meaning |
|---|---|
| **Blocker** | A user cannot complete the core loop without manual workarounds outside the product. |
| **Trust** | The product reports something that is not true, or stays silent when it should speak. This is the worst category — it is worse than a visible failure. |
| **Friction** | The loop works, but costs the user avoidable time or money. |

---

## Open

### GAP-001 — Nothing installs dependencies into the task workspace
**Severity:** Blocker

Every task gets a fresh `git clone` ([`local-git-workspace-provider.ts`](../src/workspace/local-git-workspace-provider.ts)), so the workspace has no `node_modules`, no `vendor/`, no `.dart_tool/`. Nothing in the platform runs an install step — there is no `install`/`setup` concept anywhere in `ProjectCommands`.

The consequence is that a perfectly ordinary declared command (`npm run build`) fails with `next: command not found` on a repository where that command works fine locally. The user's only workaround is to chain the install into the check itself:

```
cd backend && npm ci --no-audit --fund=false && npx tsc -p tsconfig.build.json --noEmit
```

That works, but it is invisible knowledge — nothing in the UI suggests it — and it charges the install cost to every check, against a timeout that did not budget for it (see GAP-002).

**Direction:** a first-class `setup` command on the project, run once after provisioning and before any check, reported as its own step. Longer term this is also where a dependency cache belongs, since re-downloading a full dependency tree per task is pure waste (see GAP-009).

---

### GAP-002 — The validation timeout is fixed, invisible, and reported as a failure
**Severity:** Trust

`DEFAULT_CHECK_TIMEOUT_MS` in [`validation-runner.ts`](../src/validation/validation-runner.ts) is a hardcoded 5 minutes, after which the check is `SIGKILL`ed. Three separate problems:

1. **It is not configurable.** A real monorepo build plus a dependency install routinely exceeds it. Combined with GAP-001, the practical budget for the actual check is well under five minutes.
2. **A timeout is reported as `passed: false`.** It is indistinguishable in the result from a genuine compile error, so the self-fix loop hands the Implementer a "failure" that has no cause in the diff. The agent then burns its budget hunting a bug that does not exist.
3. **The limit is not surfaced anywhere in the UI.** A user configuring commands has no way to know the constraint exists until a task fails.

**Direction:** a distinct `timed_out` outcome on `CheckResult` that the self-fix loop treats as inconclusive rather than failing; a per-project (or per-check) timeout; and the effective limit shown next to the command fields.

**Narrowed — V1.1 Slice 1 (Execution Integrity & Evidence).** Item 1 of three: `CheckResult.outcome` now includes a distinct `"timed_out"` (and `"infrastructure_error"`, for a command that couldn't even be spawned), never collapsed into a plain `"failed"` — see `tests/validation-runner.test.ts`, which exercises a real timeout against a real spawned process. The self-fix loop's own handling is unchanged (a timeout still counts as "not passed" and retries the same as any failure) and there is still no per-project timeout or UI display of the limit — those two remain open.

---

### GAP-003 — One command set per project breaks monorepos
**Severity:** Trust

`ProjectCommands` is a single `{ build, test, lint, typecheck }` on the project. A monorepo containing several independently-buildable applications has no way to express "typecheck the backend for backend tasks, analyze the Flutter app for mobile tasks."

The failure is silent and in the dangerous direction: with a backend typecheck configured, a task that only touches the mobile app runs that backend check, it passes, and the task advances to review with **zero verification of the code that actually changed**. A false green is worse than no green.

**Direction:** command profiles selectable per task, or commands scoped to a path so the platform can pick the profile from the diff. The latter is more automatic and needs no extra input at task-creation time.

---

### GAP-004 — Undeclared checks are skipped silently, with nothing said anywhere
**Severity:** Trust

By design, a check with no declared command is skipped rather than failed ([`validation-runner.ts`](../src/validation/validation-runner.ts)). The design decision is right — the platform must not invent commands for arbitrary stacks.

What is wrong is that it is **invisible**. A project with no commands at all produces `status: "passed"` with an empty `checks` array, and the task report says validation passed. Until the Settings UI for commands shipped, no project had commands configured, which means every task ever run on this platform ran with no automated validation and reported success.

**Direction:** distinguish "passed" from "nothing to run" in `ValidationResult`; refuse to show an unqualified green for the latter; warn at project level when a project has no commands declared, and at task level in the report.

**Narrowed — V1.1 Slice 1 (Execution Integrity & Evidence).** The first two bullets are done: `ValidationResult.outcome` is `"no_checks_configured"`, distinct from `"checks_passed"`, even though `status` (which only gates the self-fix loop, unchanged) is `"passed"` for both — and everything that surfaces this to a human (the task report, the PR description) shows the honest outcome, never an unqualified "passed" — see `tests/validation-runner.test.ts` and the PR-content tests. A project-level warning in the Settings UI when no commands are declared is still open — out of this slice's backend-only scope.

---

### GAP-005 — No way to provide environment configuration to a workspace
**Severity:** Blocker

`.env` files are correctly gitignored in real projects, so a fresh clone never has one. The platform has no per-project secret/env store and no mechanism to inject values into the workspace.

This caps what can be validated. Type-checking works because it never reads `process.env`; a production build of a framework that validates env at build time, or anything that needs a database connection, cannot run at all. It also means the "self-fix" loop can hit a class of failure it can never resolve.

**Direction:** per-project encrypted environment variables (the credential encryption from [GITHUB_INTEGRATION.md](./GITHUB_INTEGRATION.md) already establishes the pattern), materialized into the workspace at provisioning time and redacted from every log and prompt.

---

### GAP-006 — Workspace teardown is not guaranteed, and nothing reaps the leftovers
**Severity:** Friction

`destroy()` removes the clone, but tasks that fail, are cancelled, or die with the worker never reach it. Observed on a development machine: **52 orphaned workspace directories, 358 MB**, some weeks old.

This scales badly in exactly the situation the product is for. A large monorepo clone plus an installed dependency tree can run to 1 GB per task; a batch of 50 bug-fix tasks could leave tens of gigabytes behind, and nothing warns the user or cleans it up.

**Direction:** a startup reaper that removes directories for workspaces already `torn_down`/`failed` in the database, plus a retention policy for the rest. Disk usage is worth surfacing in the UI once this product runs on a shared host.

**Re-verified — Developer Alpha audit.** Still open and confirmed against the code: `cleanupWorkspace` runs only on cancellation; nothing tears a workspace down on DONE/FAILED, and deleting a project leaves both workspace roots on disk. Not closed for the alpha — [INTERNAL_ALPHA.md](./INTERNAL_ALPHA.md) §8 documents the disk budget and a manual, safe-to-prune procedure (a FAILED task's workspace can hold the only copy of unpublished work, so it is deliberately not auto-pruned).

---

### GAP-007 — A connected integration reports health it has not actually checked
**Severity:** Trust

`GET /integrations/github` was a database-only read: it reported "Connected" whenever a credential row existed, which it cannot distinguish from a token revoked or expired on the provider's side. A user whose token had been revoked saw a green "Connected" badge while every task silently failed to open a pull request.

**Partially addressed** by an explicit on-demand `POST /integrations/github/verify` (see [`github-integration-service.ts`](../src/application/github-integration-service.ts)), which makes a real API call and carefully distinguishes "the token is bad" from "we could not check right now."

**Still open:** verification is manual. Nothing revalidates in the background, and nothing notices the pattern of repeated auth failures described in GAP-008. The general principle this generalizes to — *never report the health of a dependency you have not contacted* — applies to every future adapter, not just GitHub.

---

### GAP-008 — Persistent execution failures are invisible outside the worker log
**Severity:** Trust

Three tasks stuck in `REVIEW` re-polled a provider every 30 s and failed authentication every time, for days. The errors appeared only in the worker's stdout. Nothing surfaced on the task, on the project, or anywhere in the UI, and the tasks stayed in a state that looks, to a user, like "waiting for a human."

A user who only ever sees the UI — the actual target user of this product — had no way to learn that anything was wrong.

**Direction:** count consecutive failures of the same kind per task; after a threshold, move the task to a state that says so and attach the reason. A task that cannot make progress must not be indistinguishable from one that is merely waiting.

---

### GAP-009 — Onboarding a real repository is entirely manual
**Severity:** Friction

Connecting a real production monorepo took an extended back-and-forth before the first task could run safely. Everything discovered was mechanically discoverable from the repository:

- there is no root `package.json`, so commands must `cd` into a subdirectory first
- `npm test` exits non-zero because no test suite exists — declaring it would fail every task
- `npm run lint` reports hundreds of pre-existing errors — declaring it would send the agent chasing unrelated code
- one `tsconfig.json` includes archived scripts with pre-existing type errors while a sibling `tsconfig.build.json` does not
- documentation in the repository contradicts the code about which port the API uses

None of this is exotic. It is the normal condition of a real codebase, and the product currently expects the user to find and write all of it by hand before the first task is safe to run.

**Direction:** a connect-time repository scan that proposes commands and drafts the project context manifest for the user to confirm. This is explicitly anticipated in [MVP_SCOPE.md](./MVP_SCOPE.md) assumption #3, but only for commands — the same scan can carry the context manifest, which is where most of the manual effort actually went.

---

### GAP-010 — Every task re-clones the entire repository
**Severity:** Friction

A batch of bug fixes against one repository means one full clone per task, plus (with GAP-001 worked around) one full dependency install per task. For a 78-item bug backlog on a large monorepo, that is the same multi-gigabyte download repeated dozens of times, with the time cost charged against the validation timeout.

**Direction:** a per-project reference clone that task workspaces branch from, or a local object cache. The `WorkspaceProvider` interface is the right seam; no caller changes.

---

### GAP-011 — The execution environment is not sandboxed
**Severity:** Blocker (for anything beyond trusted local use)

Known and documented in the provider's own source and in [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md), but recorded here because connecting a real project is exactly the moment it stops being theoretical: declared commands and the coding engine run with the same OS privileges as the platform process, on the developer's own machine, with that machine's credentials in the environment.

The architecture anticipates this — [ARCHITECTURE.md](./ARCHITECTURE.md) layer 10 specifies a resource-limited container, and `WorkspaceProvider` is the seam. It has not been implemented.

---

### GAP-012 — Deleting a project cannot clean up its filesystem or run in a transaction
**Severity:** Friction

`ProjectRepository.deleteCascade` deletes child rows in dependency order, but the codebase-wide posture of no cross-statement transactions means a crash mid-delete leaves a partially-deleted project. It also does not remove the project's persistent workspace directory or any orphaned task workspaces.

**Direction:** decide whether the no-transaction posture should hold for destructive multi-table operations, and pair row deletion with filesystem cleanup.

---

### GAP-013 — A failed provider call discards the only part of the error that explains it
**Severity:** Trust

`safeErrorMessage` in [`github-client.ts`](../src/integrations/github/github-client.ts) reads `body.message` and nothing else. For a `422` that field is always the generic string `"Validation Failed"` — GitHub puts the actual cause in a sibling `errors[]` array (`"A pull request already exists for owner:branch"`, `"No commits between main and X"`, and so on).

A real task failed with:

```
GitHubApiError: GitHub API request failed (422): Validation Failed
```

That is the entire diagnostic surface, in the UI and in the event log. It does not say which validation, on which resource, or what the user should do about it — and the information existed in the response the platform already parsed and then dropped.

The cost was concrete: the first diagnosis of this failure, made from the platform's own output, guessed "a pull request already exists" — and was wrong. The real cause (GAP-015) only came out after manually inspecting the GitHub branches page and the leftover workspace's git state. The actual `errors[]` reason — almost certainly `No commits between main and <branch>` — would have pointed straight at it.

The redaction instinct behind it is right (the doc comment says "never forwards raw headers/response internals"), but `errors[]` is exactly the safe, user-facing part.

**Direction:** append the structured `errors[]` entries (`resource`, `field`, `code`, `message`) to the thrown message, still without forwarding headers or raw bodies. Then map the common ones to actionable UI copy.

---

### GAP-014 — Approved work is thrown away when the last step fails
**Severity:** Trust

The same task ran the complete loop successfully: the Implementer produced a fix, validation passed, the Reviewer rejected it with a real finding, the Implementer fixed that, validation passed again, and the Reviewer approved it. Then the final step — opening the pull request — returned a `422`, and the task went to `FAILED`.

Two separate problems:

1. **The user cannot tell what survived.** "Failed" says nothing about whether the work exists anywhere. In this case the approved commits existed *only* in a local task workspace that happened not to be torn down (GAP-006 — the leak is what saved the work). Nothing in the UI said so, or named where to look.
2. **Nothing is recoverable.** `ensurePullRequest` is idempotent, but a task in `FAILED` has no path back. The only way to get a PR for work already written, validated and approved is to re-run the entire six-minute, two-review task from an empty workspace.

The general principle: a failure in the *publishing* step is not the same as a failure of the *work*, and collapsing the two throws away everything the task earned.

**Direction:** distinguish "work completed but could not be published" from "the work failed", keep the approved commits and workspace alive until they are published or explicitly discarded, and allow a retry that resumes at the failed step.

---

### GAP-016 — "Independently verified" means read, not run
**Severity:** Trust

The Reviewer approved the name-validation fix with, in its own words, "I have independently verified that … the regex `/^[\p{L}'-]+(\s[\p{L}'-]+)*$/u` effectively restricts the input to Unicode letters, apostrophes, hyphens … while rejecting digits and disallowed symbols." A human then ran that regex against the inputs the QA reports actually describe:

| Bug | Input | Expected | Result |
|---|---|---|---|
| 006 / 009 | `"   "` | rejected | rejected |
| 012 — "only special characters" | `@@@`, `#$%` | rejected | rejected |
| 012 — "only special characters" | `---`, `'''`, `-'-`, `- -` | rejected | **accepted** |
| 013 — "only alphabet" | `Rahul123` | rejected | rejected |
| 013 — "only alphabet" | `Müller`, `张伟` | rejected | **accepted** |

Because every character class in the regex allows `'` and `-` on their own, a name made entirely of those two symbols passes — precisely the class of input BUG-012 reports. The Reviewer described exactly this regex, named exactly this property as verified, and approved. A two-line script found the counterexample in under a second.

Two layers to this:

1. **The Reviewer cannot tell reading from verifying.** It reasons over the diff statically, but its report uses the language of verification. A user reading "independently verified" reasonably believes something was executed. Nothing was.
2. **Nobody reproduced the bug.** Four QA bug reports went in; no step in the loop reproduced any of them before the fix or confirmed their absence after. In a repository with no test suite, "validation passed" meant only "it type-checks," and review meant only "it reads correctly." The loop produced an approval with no behavioral evidence behind it at all — and did not say so.

It also missed a user-visible half of the reports: the backend now rejects bad names, but the shared validation middleware still puts the generic `"Validation failed for the requested resource"` in the top-level message (the field-specific text sits in `details[]`). That string is, verbatim, the "exception" the QA reports complained about. The task *specification* was met; the *bug*, as the tester will see it, is not yet fixed.

A later batch of twelve tasks reinforced this from two more angles. On the Continue Watching task the Reviewer wrote out the consequence of the change in plain words — "a video of, for example, 31 seconds could be marked as completed after only 1 second of playback" — called it "a direct, intended consequence", and approved. On the add-profile task it returned `VERDICT: APPROVED` while simultaneously listing findings, one of them a security concern about the fix being client-side only; the platform recorded that as an approval with the findings attached, and the task advanced. A verdict that can carry unresolved concerns of its own is not a gate.

**Direction:** let the Reviewer — or a deterministic step before it — write and run small throwaway checks for concrete behavioral claims (a regex, a parser, a boundary) even when the project has no test suite; require the report to say plainly when an approval rests on reading alone; and for tasks created from bug reports, make "reproduce, then confirm fixed" an explicit part of the loop rather than an implicit hope.

**Narrowed — V1.1 Slice 1 (Execution Integrity & Evidence).** The second bullet is done: the Reviewer prompt now explicitly forbids the words "verified"/"confirmed"/"independently verified" unless it actually ran something and is reporting real output, requires a closing `VERIFICATION: STATIC | EXECUTED` line (`review/reviewer.ts`'s `deriveReviewResult`, mirroring the existing `VERDICT:` convention), and the report/PR always show this label — including `"unknown"` when the model never said, which is never presented as more thorough than it was. What is still open, unchanged: nothing lets the Reviewer actually execute a check with the platform capturing its real output the way `ValidationResult` does — a `VERIFICATION: EXECUTED` claim is still trusted, not verified — and "reproduce, then confirm fixed" for bug-report tasks is still an inert extension point (`TaskRecord.bugFixVerification`), not a working loop. Both remain open.

**Narrowed further — V1.1 Slice 2 (Platform-Captured Reviewer Verification).** The specific gap the previous note called out — "a `VERIFICATION: EXECUTED` claim is still trusted, not verified" — is now closed: the Reviewer can request a bounded `VERIFY: <checkId>` verification (one of the project's own configured build/test/lint/typecheck commands, never an arbitrary command); the platform executes it through the same `runCheck` the Implementer's own validation already uses (`review/reviewer-verification.ts`), captures the real outcome/exit code/output/commit, and `deriveReviewResult` can only ever set `verificationMethod: "executed"` when that real evidence exists — a text-only "EXECUTED" claim with nothing behind it is now downgraded to `"static"` rather than trusted (see `tests/reviewer-verification.test.ts`, `tests/reviewer-verification-integration.test.ts`, and the real end-to-end reproduction in the latter's scenario E). Verification evidence is bound to the exact commit it ran against and is never carried forward across a review cycle (scenario H). This satisfies the literal closing criterion this slice set for itself — "Reviewer executable verification is platform-captured and cannot be established solely by reviewer prose" — but the gap is not marked fully **Closed** here because the *original* Direction above was broader than that: it also asked for throwaway checks the Reviewer can write on the fly for a project with no test suite at all (this slice only offers the four already-configured command slots — a project with nothing configured has nothing to offer), and for "reproduce, then confirm fixed" to become an explicit part of the loop for bug-report tasks (`TaskRecord.bugFixVerification` is still a completely inert extension point — nothing populates or reads it). Both remain open, and are the natural next slice.

**Narrowed further still — V1.1 Slice 3 (Reproduce → Implement → Platform-Verified Fix).** The second of the two items the previous note left open — "reproduce, then confirm fixed" as an inert extension point — is now a real, working mechanism. A task may be created with a `BugFixVerificationContract` (`checkId` + `bugPresentWhenCheckOutcome` — one of the project's own configured build/test/lint/typecheck commands, never an arbitrary command; reuses the exact same `executeApprovedVerification` mechanism Slice 2 built, not a second execution engine — see `review/bug-fix-verification.ts`). When present: the platform runs the contract's check against the workspace's pristine pre-implementation state and records a deterministic `BUG_REPRODUCED`/`BUG_NOT_REPRODUCED` (or `timed_out`/`infrastructure_error`/`rejected`) status; the Implementer is handed this real evidence, clearly labeled platform-captured, before it starts; after every commit (the first, and every review/fix-cycle recommit), the platform re-runs the SAME check and derives `FIX_VERIFIED`/`FIX_NOT_VERIFIED`, overwriting the task's own record with fresh, commit-bound evidence — never leaving a superseded commit's result readable as if it applied to a newer one (see `tests/bug-fix-verification-integration.test.ts` scenario H/I). The Reviewer receives this evidence the same way (clearly labeled, never something its own prose can create or override) — a Reviewer that claims "the fix is verified" while the platform's own record says `fix_not_verified` does not change that record (scenario J/K). A crash before reproduction ever ran resumes and re-runs it fresh, exactly once, never fabricating a result (scenario L).

**What this does NOT close, and is not claimed to:** this mechanism is opt-in and reachable today only through `TaskService.create`/`task-factory.ts`'s `CreateTaskInput.bugFixVerification` — there is deliberately no HTTP endpoint or UI for it yet (see item 16 of this slice's own brief, "keep API changes minimal"), so it is not yet the automatic experience for an ordinary bug-report task the way the original Direction above envisioned. The other half of the original Direction — letting the Reviewer write and run small *throwaway* checks (a regex, a parser, a boundary) for a project with no test suite configured at all — is still not built; this slice, like Slice 2, only offers the four already-configured command slots. Both remain open.

---

### GAP-017 — The task form promises plain language; getting a correct result took a spec
**Severity:** Friction (product positioning)

The Create Task dialog tells the user: *"Describe the problem in plain language — no need to write instructions for the AI."* That is the product's core promise (see [PRODUCT_VISION.md](./PRODUCT_VISION.md)).

In practice, the first task on a real repository was written close to plain language, and produced a fix that was incomplete against its own bug reports (GAP-016). The retry that is expected to succeed specifies the exact files, the exact regex, seventeen named test inputs, an instruction to execute a throwaway check and report its output, and two "do not touch" boundaries. That is an engineering specification, not a bug description.

The gap is not that detailed instructions help — they always will. It is that the product tells users they are unnecessary while the loop has no way to close the distance itself: nothing turns "BUG-012: accepts only special characters" into "try `---`" before approving. Until GAP-016 is addressed, the hint text actively sets users up to write the kind of task that fails.

**Direction:** either close the gap in the loop (reproduce-and-confirm, executable reviewer checks — see GAP-016), or make the hint honest about what currently produces reliable results, for example by prompting for concrete examples of bad input and expected behavior.

A related trap on the same form: **Depends on** offers a `FAILED` task as a dependency. A dependency on a task that can never reach `DONE` blocks the new task permanently, and nothing warns the user.

---

### GAP-018 — Work lands in the customer's repository under a stale name and an unroutable identity
**Severity:** Friction

The product was renamed to CodeForge.ai in the UI, but what it writes into a connected repository was not: every commit is authored as `AI Task Manager <platform@local>` ([`git-commit.ts`](../src/source-control/git-commit.ts)), and every PR ends with "Opened automatically by AI Developer" ([`pull-request-content.ts`](../src/orchestrator/pull-request-content.ts)). A reviewer on the connected project sees two different product names, neither of which is the one the user signed up for, and a commit author GitHub cannot link to anyone.

This is the only part of the product that most people on a customer's team will ever see.

**Direction:** one configurable product name and bot identity used for commit authorship and PR text, defaulting to the current brand.

---

### GAP-019 — Whatever the toolchain touches gets committed
**Severity:** Trust

`commitAllLocal` ([`git-commit.ts`](../src/source-control/git-commit.ts)) runs `git add -A`. Anything a validation command, a dependency install or the agent itself changes in a tracked file lands in the task's commit.

Observed while preparing a Flutter task: on a clean clone, `flutter pub get` rewrites `pubspec.lock`, because the host's Flutter SDK pins SDK-bundled packages (`meta`, `test_api`) to newer versions than the lockfile was generated with. `flutter pub get --enforce-lockfile` refuses outright (exit 65). So every Flutter task on that host would have shipped an unrelated lockfile change inside a bug-fix PR — silently, since nothing in the loop inspects what is being staged.

The same run surfaced the underlying cause: validation executes on the **host's** toolchain, whose versions are whatever happens to be installed on the platform machine, not what the project pins.

A later batch of twelve tasks showed the same gap from the other direction: three tasks committed files their instructions explicitly told them not to commit — `verify_label.ts` at the repository root, `backend/src/verify_validation.ts`, and a permanent `backend/src/modules/auth/services/otpThrottle.test.ts` in a project that has no test runner. Each task's description said "do not commit it". `git add -A` took them anyway, and nothing in the report showed the user which files were about to ship.

The workaround is to make the declared command restore what it dirties (`…; rc=$?; git checkout -- pubspec.lock; exit $rc`). That works, but it is invisible knowledge again, per command, per stack.

**Direction:** stage only paths the Implementer actually changed rather than `-A`, or at minimum show the staged file list in the report and flag files no step of the task was asked to touch. Longer term, per-project toolchain versions belong in the execution environment (GAP-011).

The project context for the same repository also stated that `flutter analyze` produces "zero errors and zero warnings." On a clean clone it produced 0 errors, 15 warnings and 166 infos, and exits 1 — a plain `flutter analyze` as a declared check would have failed every mobile task before the agent changed a line. Evidence for GAP-009: the context a user writes about their own repository is not reliable enough to configure validation from without running it once.

**Narrowed — V1.1 Slice 1 (Execution Integrity & Evidence).** `git add -A` itself is unchanged — deliberately: a stack-agnostic "this file looks unrelated" heuristic was evaluated and rejected, since a wrong one would silently drop a legitimate multi-file change (a real risk the task's own instructions for this slice called out explicitly). What is done is the "at minimum" half of Direction: `commitAllLocal` now captures the real changed-file list from `git status --porcelain`, read *before* staging, and that list is real platform evidence in the task report (`TaskReport.gitEvidence.changedFiles`) and the PR description's new "Files changed" section — see `tests/git-commit.test.ts`'s dedicated "unrelated generated file" case. A file nobody asked for is no longer silent, but it is also not yet excluded or flagged as suspicious; both remain open, and per-project toolchain versions (the root cause of the `pubspec.lock` case specifically) are still GAP-011's problem, unaddressed here.

---

### GAP-020 — The product's unit of work is one hand-written task; the real user's unit is a backlog
**Severity:** Blocker (for the intended use)

[PRODUCT_VISION.md](./PRODUCT_VISION.md) describes the experience as: pick a project, *write a task*, leave. The way real teams actually intend to use this is different: connect the repo, set up the workspace once, drop an entire QA sheet or backlog in at once — dozens of items, one branch each — press start, and come back to PRs. The user who owns this platform stated it plainly after the first two real tasks: the end user will not spend time deciding and hand-writing each task.

Today that flow does not exist. There is no import (CSV, spreadsheet, paste-a-list), no bulk creation, no "start all" — the API exposes only single-task create and single-task start. A 78-item QA sheet means 78 trips through the Create Task dialog and 78 Start clicks.

More importantly, every judgment call that made the first successful task possible was made by a human expert *outside* the product, and a backlog-scale user will not make any of them:

| What was done by hand for one task | What a backlog user needs the product to do |
|---|---|
| Split 78 items into backend / mobile UI / feature request; defer the features | Triage imported items into bug / feature / duplicate / needs-more-info, for the user to confirm |
| Merge 006 + 009 + 012 + 013 into one task (same root cause) | Detect duplicates and same-root-cause items and propose grouping |
| Read the code to find the real root cause before writing the task | Investigate first; only then implement |
| Rewrite the bug as a spec with concrete bad inputs | Turn "accepts special characters" into test inputs itself (see GAP-016, GAP-017) |
| Pick and test a validation command per stack on a clean clone | GAP-009 / GAP-001 / GAP-019 |
| Verify the PR independently before trusting it | GAP-016 |

**The loop itself was not the bottleneck** — PR #67 shows Implementer → validate → Reviewer → PR works. What stands between a user and "walk away" is everything before the loop (intake, triage, setup) and everything after it (an honest, scannable outcome).

**Direction:** a backlog import with a confirm-the-triage step; grouping; a single "start all" that respects dependencies and concurrency; and a batch-level outcome view — N PRs ready, N need input, N failed and why.

**Narrowed — Phase 4A (Backlog Intelligence Foundation).** *Solved:* a backlog now exists as a first-class, persisted, project-scoped concept separate from Task (`backlog_items`), and the "understand before executing" half of the table above has a foundation — a strictly schema-validated AI analysis per item (type, affected application, suspected area, candidate files *checked by the platform against a real repository listing*, missing information, acceptance criteria, validation), duplicate/dependency **proposals**, and a human-approved `TaskProposal` that converts into an ordinary Task through the existing `TaskService.create` (see [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md)). *Evidence:* `tests/backlog-{domain,service,persistence,api}.test.ts` — full item→analysis→proposal→approval→Task flow over service and HTTP, malformed-output and adversarial-boundary cases, and concurrency/idempotency. *Still open:* items are created one at a time by hand (no import — Phase 4B); analysis sees a file **listing**, not code, so it does not "read the code to find the real root cause" and cannot turn a vague bug into concrete test inputs (GAP-016/017); there is no confirm-the-triage/grouping workflow, no "start all", no dependency-aware scheduling, and no batch outcome view (4C/4E). *Next closure criteria:* bulk import of a real QA sheet ending in a reviewed set of proposals, and one approved batch executed with dependencies respected.

---

### GAP-021 — Parallel tasks on one repository have no awareness of each other
**Severity:** Friction → Trust at backlog scale

Each task branches independently from `main`. Nothing notices when two tasks will edit the same files. In the first real backlog, BUG-006, 009, 012 and 013 all touch the same three validator files; created as four tasks — which is exactly what a backlog user importing a sheet would do — they would produce four PRs that each conflict with the others after the first merge, or worse, four slightly different regexes.

At one task at a time this is invisible. At 78 tasks with two running concurrently it is the normal case, and it converts "come back to finished PRs" into "come back to a merge-conflict queue."

**Direction:** before starting, estimate each task's touched paths (the investigation step can produce this) and either serialize overlapping tasks, stack them, or propose merging them into one task. Surface the overlap in the batch view.

**Narrowed (proposal-only) — Phase 4A.** *Solved:* same-root-cause detection now has a place to live: each analysis can propose `POSSIBLE_DUPLICATE` relationships between backlog items (resolved only against real sibling items in the same project, deduplicated, persisted with confidence and rationale — never merged or deleted) and `DEPENDS_ON` proposals (cycle-checked, so the AI cannot propose a deadlock). *Evidence:* `tests/backlog-service.test.ts` (relationship proposals, cross-project isolation, cycle dropping) and `tests/backlog-domain.test.ts`. *Still open — the actual gap:* this is item-level, name-and-description-level detection; nothing estimates touched **paths** (analysis candidate files are hints from a listing), nothing serializes or stacks overlapping *tasks*, proposals are informational and never become task dependencies, and two tasks converted from overlapping items still run independently. *Next closure criteria:* touched-path overlap surfaced before Start, and confirmed dependencies enforced by the scheduler (Phase 4C/4E).

---

### GAP-022 — A forgotten password locks a user out of their projects permanently
**Severity:** Blocker

There is no account recovery of any kind. `src/api/routes/auth.ts` exposes only `/auth/register`, `/auth/login`, `/auth/logout` and `/auth/me` — no forgot-password, no password change, no email verification, no admin reset. Passwords are `crypto.scrypt` hashes ([`auth-service.ts`](../src/application/auth-service.ts)), so nothing can be recovered by design, which is correct.

The consequence is not a small inconvenience. Ownership is `User → owns → Project → tasks`, so losing the password means losing the connected repository, its validation commands, its project context manifest, its whole task history and backlog. The only way back is a developer with shell access editing the database directly — which is not a recovery mechanism, it is the absence of one.

Observed: the platform's own owner could not recall the password for their working account. It was recovered only because the browser had saved it. Nothing in the product would have helped.

This also blocks the multi-user future the data model is already built for: a second user whose password fails cannot be helped by the first, because no reset path exists at any level.

**Direction:** at minimum, a password change for a signed-in user (cheap, and it covers the "I want to rotate this" case), plus an operator-run reset for the single-tenant deployment. A real forgot-password flow needs email delivery, which [MVP_SCOPE.md](./MVP_SCOPE.md) should say explicitly is deferred rather than leaving the gap unstated.

---

### GAP-023 — A plainly-worded task can be answered in the wrong application entirely, and every gate still passes
**Severity:** Trust

Two tasks in the first real batch were deliberately written the way an ordinary user writes them — the QA report, verbatim, with no root cause, no file list and no test inputs. Both produced an approved pull request. Neither fixed the bug.

**"Add profile (+) still shown after the maximum is reached."** The report says "Open the Jinvani App → tap Profile". That is the Flutter mobile app. The change edited `frontend/web/src/components/modules/settings/ProfilesSection.tsx` and `frontend/web/src/app/settings/profiles/add/page.tsx` — the Next.js web application. Nothing in the mobile app was touched. The project context even instructs the agent to "determine which application within the monorepo is affected" first.

It then passed both declared checks, because the project's checks are a backend typecheck and `flutter analyze`: the backend was untouched so its typecheck passed trivially, the Flutter app was untouched so its analyze passed trivially, and **the code that was actually written was never compiled or checked by anything**. This is GAP-003's false green arriving in its worst form — not a weak signal, but a green light on an application no gate covers.

**"Finished video still appears in Continue Watching."** The change added a completion rule to the backend watch-history repository. But the mobile client sends an explicit `completed` boolean on every progress report, and the repository honours that flag before ever reaching the computed rule — so on the reported path the new code cannot execute. The change also left a `console.log` on every progress write, in a hot path, including profile and content ids.

**Direction:** derive the affected application from the task and refuse to let a task pass a gate that does not cover the code it changed — a check that ran against untouched code is not evidence. This is the single strongest argument for GAP-020's "investigate first": the loop currently starts implementing before it knows what it is fixing.

**Narrowed — V1.1 Slice 1 (Execution Integrity & Evidence).** Only the reporting seam this direction needs was built, deliberately not the automatic derivation or the refusal-to-pass gate (out of this slice's scope by design — see item 5's own scope note). `TaskReport`/the PR description now carry `gitEvidence.changedFiles` (real paths, from git) directly alongside which validation checks actually ran and their honest outcome (GAP-004's `ValidationOutcome`) — the data needed to see "these files changed, these checks ran, these did not cover the changed area" is now in one place. Nothing yet computes or acts on that mismatch automatically; a human (or a future slice) still has to notice it. Remains open.

---

### GAP-024 — Reports contain verification output that was never produced
**Severity:** Trust — this undermines every other report the product writes

Task summaries are the product's primary evidence surface. Three in one batch contained statements that are demonstrably false, and all three were approved by the Reviewer.

1. The validation-middleware task reported its verification output as `String must contain at least 1 character(s)` with a Zod v3 issue shape. That project runs **Zod 4.3.6**, which produces `Invalid input: expected string, received undefined`. Re-running the same scenarios against the real middleware gives the v4 messages. The reported output could not have come from this codebase.
2. The Continue Watching task presented a "Previously / Updated to" diff claiming it had changed `duration > 0` to `duration > 30`. The real diff shows it **added** the entire clause; the "previous" line it quoted never existed.
3. The profile-deletion task stated "the deleteProfile method already contained the logic required … it was failing the type check" — on a first run against untouched `main`, where that method had no checks at all.

The underlying code in cases 1 and 3 turned out to be correct when executed independently, which is what makes this dangerous: the fabrication is invisible precisely when the work is fine, so a user learns to trust the report, and is then wrong about the one case where it matters.

**Direction:** the platform, not the agent, must own evidence. Command output belongs in the report because the platform captured it — as it already does for declared checks — not because the agent transcribed it. Any output an agent produces inside its own summary should be labelled as the agent's claim, not presented as a result.

**Narrowed — V1.1 Slice 1 (Execution Integrity & Evidence).** The two structured fields these three fabrications exploited are now platform-owned rather than agent-transcribed: `filesChanged`/`TaskReport.gitEvidence` come from `git status --porcelain`, and `ValidationResult`'s checks/outcome have always come from a platform-spawned process, now with truthful `CheckOutcome`/`ValidationOutcome` values that can't be talked around. See [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) "AI claims are not execution evidence" for the full inventory of what changed. What is not done: the Implementer's/Reviewer's free-text summary itself (the "Previously / Updated to" style fabrication in case 2 above) still renders in the PR under "## Implementation summary" with no explicit "(unverified, written by the AI)" label — it is human-readable narrative, not structured evidence, but nothing marks the distinction for a reader skimming the PR. Remains open.

---

### GAP-025 — Correct waiting looks identical to being broken
**Severity:** Trust

Thirteen tasks sat in `REVIEW`. The user merged ten of their pull requests and the board did not move. Nothing in the UI changed, nothing explained why, and the reasonable conclusion — the one the user reached — was that the product was broken.

It was not. GitHub had rate-limited the account, and the platform did exactly the right thing: `checkHumanReviewFeedback` classified the failure, and `maybeExtendReviewBackoff` deferred every task's next check to GitHub's own reset time rather than hammering the API. The tell was that all thirteen tasks shared one `next_review_check_at` to the millisecond — a single rate-limit reset timestamp. Three seconds after that timestamp passed, ten tasks moved to `DONE` on their own.

So the mechanism worked perfectly and the user still lost confidence in it, because none of that reasoning was visible. The platform knew it was rate-limited, knew exactly when it would retry, and said none of it.

This gets worse at the scale the product is aimed at (GAP-020). Each `REVIEW` task polls GitHub on its own cadence, so the backlog-sized workload that motivates the product — dozens of tasks in review at once — is precisely what exhausts the rate limit, and therefore precisely when the silence appears.

Note also that a rate-limited read produces no event at all: `SOURCE_CONTROL_FAILED` is deliberately skipped for `rate_limited` and `retryable_transient` to avoid event spam. Reasonable for the log, but it means nothing anywhere records why the task is waiting.

**Direction:** give a task a visible "waiting to re-check, next attempt at HH:MM (rate-limited by GitHub)" state, shown on the task and summarised at the project level. Distinguish "waiting on a human" from "waiting on an external service" everywhere the status is rendered — they look the same today and mean very different things.

---

### GAP-026 — A rejected task can never end, and keeps costing you forever
**Severity:** Friction → Trust at backlog scale

Rejecting a task's work means closing its pull request without merging. `checkHumanReviewFeedback` handles that case deliberately — a PR closed unmerged must never become `DONE` — but the task then simply stays in `REVIEW`, with no event recorded and no way for the user to say "this one is finished, I rejected it."

Three consequences, all observed on a real board:

1. **The board lies.** Two tasks whose work was rejected and closed sit in `REVIEW` alongside tasks genuinely waiting for a human to look. They are indistinguishable, and there is no action anywhere that resolves them.
2. **They poll forever.** Every `REVIEW` task keeps its GitHub check cadence indefinitely. A rejected task therefore spends the account's rate limit, permanently, for a pull request that will never change again — feeding directly into GAP-025, whose symptom is other tasks silently stalling.
3. **A closed-by-mistake PR is invisible.** In the same session a correct, verified pull request was closed instead of merged. The product had no way to show that: "closed unmerged" and "still open, waiting" render identically. The user believed four bugs were fixed when they were not.

**Direction:** treat "PR closed without merge" as a real terminal outcome — a distinct status (rejected/abandoned) that stops the polling and is visible on the board, reachable both automatically from the closed PR and manually from the task. It should carry the PR link so a close-by-mistake is obvious and reversible.

---

### GAP-027 — A provider quota limit destroys the whole backlog, one task at a time
**Severity:** Blocker

Twelve tasks were released into the queue together. The coding engine's provider returned `HTTP 429 RESOURCE_EXHAUSTED` ("You exceeded your current quota"). The adapter retried four times, then raised `EngineExecutionError`, and the orchestrator recorded `TASK_FAILED`. Three tasks died this way within minutes; the remaining nine were queued behind them and would have died the same way.

The error is explicitly labelled *retryable* in the message the platform itself logs, and the platform then treats it as terminal.

Four separate problems sit on top of each other:

1. **A quota error is not a task failure.** Nothing is wrong with the task. Re-running the identical task an hour later would succeed. `FAILED` is reserved for work that cannot be completed, and this is not that.
2. **Retrying four times in a row does not help.** A quota reset is measured in hours, not seconds. The retry budget is spent instantly and adds nothing. This is the same shape as GAP-025, where the only backoff extension that exists applies to GitHub `rate_limited` and nothing else — the coding engine has no equivalent.
3. **The blast radius is the whole backlog.** Because the worker keeps claiming the next `TODO` task, an exhausted quota converts every queued task into a failure in the time it takes to poll. The one thing the product promises — fill a backlog, press start, walk away — is exactly what turns a provider limit into maximum damage.
4. **Completed work is lost with it.** One of the three had already been implemented and was inside its review fix cycle when the quota ran out. That code exists in the workspace, has no pull request, and the task is `FAILED` — see GAP-014.

There is also no retry action. A task that failed for a reason entirely outside itself can only be re-run by a human re-typing it as a new task.

**Direction:** classify engine errors, and treat an exhausted-quota or rate-limited response as a distinct outcome from a real failure. Such a task should return to the queue with a backoff long enough to matter, and the worker should stop claiming new tasks while the provider is known to be refusing — one probe, not one failure per queued task. A failed task needs a retry action that reuses its original specification, and work already committed in the workspace should survive the task that produced it.

**Narrowed — V1.1 Slice 4 (Failure Recovery / Resumability).** Items 1 and 2 are done: `orchestrator/failure-classifier.ts` gives quota exhaustion its own truthful category (`provider_quota_exhausted`, distinct from a plain `rate_limited`, detected from the provider's own `RESOURCE_EXHAUSTED`/"quota" wording), it is never reported as a task/code failure, and the orchestrator now retries the whole episode with bounded backoff (`OrchestratorConfig.maxInfrastructureRetries`, default 2 extra attempts) before ever reaching `TASK_FAILED` — see `tests/infrastructure-retry.test.ts`'s classifier tests and `tests/opencode-adapter.test.ts` test 24 for a real adapter-exhausted-then-episode-recovered case. Item 4 is also addressed as a side effect of how the retry works: a retried episode re-enters `runWorkingEpisode` from the top, which reuses the SAME idempotent step design (ready workspace reused, no duplicate commit, PR search-before-create) already relied on for crash recovery — work already committed/pushed in a prior attempt is never redone or lost, only the failed step is effectively retried. **Still open:** item 3, the cross-task circuit breaker ("the worker should stop claiming new tasks while the provider is known to be refusing") — each task still probes and retries independently; a quota outage still means every queued task pays its own retry budget rather than the worker recognizing the pattern once. Also still open: an explicit manual "retry" action for a task that exhausted its bounded retry budget and reached terminal `FAILED` — today that still requires a new task, exactly as before.

**Narrowed further — V1.1 Slice 5 (Hybrid Model Routing / Provider Resilience / Usage Foundation).** The cross-task circuit breaker item 3 asked for is now real, though scoped differently than "the worker stops claiming new tasks": `provider_health` (new table, migrations/012_model_routing.sql) persists provider cooldown state across tasks AND worker processes, and every routing decision (`routing/model-router.ts`'s `selectModel`) consults it before choosing a model — a provider that an earlier task's own failure just cooled down is skipped by a later task's own first attempt, without that later task ever having to independently discover and retry the same outage itself (see `tests/model-routing-integration.test.ts` tests I/J, which prove this across two genuinely separate, sequential tasks sharing one `ProviderHealthRepository`). This closes the "every queued task pays its own retry budget" half of item 3's complaint whenever more than one eligible model/provider is actually configured. **Still open, honestly:** with only one model realistically configured in this environment today (whatever `OPENCODE_MODEL` names), cooldown has nothing to fall back TO — a lone provider's outage still exhausts each task's own bounded retry budget and fails, exactly as before, until a second real provider is actually registered. The worker itself still doesn't pre-emptively stop claiming new tasks the instant an outage is detected (it relies on each task's own routing decision seeing the cooldown, not a worker-level circuit breaker) — a finer difference from item 3's literal wording, though it achieves the same practical effect once a fallback candidate exists. The manual-retry-action gap remains completely open, as does GAP-014/028's separate "was work already committed?" concern.

---

### GAP-028 — Infrastructure failures are terminal, and there is no retry anywhere
**Severity:** Blocker

Twelve tasks were released as one backlog. All twelve failed. Not one failure was caused by anything in the task, the repository, or the code the agent wrote:

| Cause | Tasks | What actually happened |
|---|---|---|
| Provider quota (`429 RESOURCE_EXHAUSTED`) | 4 | See GAP-027 |
| `EngineTimeoutError` after 600000ms | 5 | A single agent invocation exceeded the wall-clock cap |
| `git clone` aborted | 3 | `RPC failed; curl 18/56 … fatal: early EOF` — the clone of a large repository was cut off mid-transfer |

Three observations:

1. **A failed clone is not a failed task.** Three tasks died during provisioning, before an agent ran, before a branch had any content. The remedy is to clone again — which nothing does. There is no retry on the provisioning step at all, and `git clone --single-branch` fetches the full history of a large monorepo on every single task (GAP-010), making the fragile operation also the most frequent one.
2. **The timeout does not distinguish slow from stuck.** The recorded implementation phases for the timed-out tasks run to 10m, 20m and 31m against a nominal 600000ms cap, which means the cap is per invocation and retries stack on top of it. A task can therefore burn half an hour and produce nothing, with no partial result kept and no signal to the user that the cap — not the work — is what ended it.
3. **Nothing can be retried.** `FAILED` is terminal. A task that failed because a TCP connection dropped can only be resurrected by a human re-typing its entire specification as a new task. For a product whose premise is "fill a backlog and walk away", the recovery story for transient infrastructure failure is manual re-entry of every affected task.

Two of the twelve had already pushed a branch with passing checks when their final step failed; that work is on GitHub, attached to a task marked `FAILED`, with no pull request — GAP-014 again, now at backlog scale.

**Direction:** separate *task failed* from *execution could not complete*. Provisioning should retry with backoff before giving up. A timed-out invocation needs its own outcome, not a failure verdict. Every non-terminal failure needs a retry action that reuses the original specification and any work already pushed, and the worker should stop claiming new tasks while an infrastructure fault is known to be active rather than feeding the whole backlog into it.

**Narrowed — V1.1 Slice 4 (Failure Recovery / Resumability).** The core distinction this gap asked for — *task failed* vs. *execution could not complete* — now exists as a real, structured taxonomy (`orchestrator/failure-classifier.ts`'s `OrchestratorFailureCategory`: `timeout`, `network_failure`, `rate_limited`, `provider_quota_exhausted`, `workspace_provision_failure`, `source_control_failure`, `authentication_failure`, `permanent_configuration_failure`, `unknown_failure`, …), and `TASK_FAILED`'s own event payload now carries `category`/`retryable` rather than just a raw error string. Provisioning genuinely retries with bounded backoff now (`Orchestrator.runEpisodeWithInfrastructureRetry`, reused for both the AI-review loop and the human-review-feedback loop) — see `tests/infrastructure-retry.test.ts` test J, which reproduces a real transient `git clone` permission failure and confirms recovery. `EngineTimeoutError` gets its own `timeout` category and is retried the same way, distinct from a genuine implementation/validation failure. Cancellation (test K) and lease loss (test L) both still correctly stop a scheduled retry rather than completing it, two workers can never both perform the same retry (test N), and a worker crash mid-backoff is recovered by the existing, untouched crash-recovery machinery with no duplicated work (test M) — this slice's retry layer is explicitly documented as distinct from, and sharing only the lease-fencing primitive with, crash recovery (see `runEpisodeWithInfrastructureRetry`'s own doc comment). **Still open:** the cross-task circuit breaker (a worker recognizing "the provider itself is down" once, rather than every queued task independently discovering and retrying the same outage) and an explicit manual retry action once the bounded budget is exhausted — both exactly as GAP-027's own "Still open" note says.

**Narrowed further — V1.1 Slice 5.** See GAP-027's own Slice 5 note directly above — the same persisted `provider_health` mechanism applies here too, since both gaps shared the identical underlying complaint. Not closed for the same reason: only one model/provider is realistically configured in this environment today, so there is nothing to fall back to when it fails.

---

### GAP-029 — A superseded task keeps a live, mergeable pull request
**Severity:** Trust

When a task produces the wrong fix, the only way forward is to write a new task. The original stays exactly as it was: `REVIEW`, with an open pull request against the default branch, sitting on the board next to the redo that replaced it. Nothing records that one supersedes the other.

Observed on a real board. Two tasks had already been re-done and merged correctly, yet their originals were still in `REVIEW` and still had open pull requests:

- One changed a backend completion rule that the client never exercises, and added an unconditional `console.log` of profile id, content id and progress on every write — a production log line, on a hot path, containing user identifiers.
- One answered a mobile bug by editing the web application instead (GAP-023), so the reported defect stayed live while the pull request claimed a fix.

Both were one click from being merged. The user asked, reasonably, whether to merge everything sitting in `REVIEW` — the board gave them no reason to think two of the five were dead work, because a superseded task and a correct task waiting for a human look identical.

The risk compounds with GAP-026: neither could be resolved on the board even after being identified, since there is no terminal state for "this work was rejected."

**Direction:** let a task be created as a replacement for another, and make that link visible on both. A superseded task should leave `REVIEW`, stop polling, and have its pull request closed as part of the same action — never left open, never merge-ready.

---

### GAP-030 — Quota exhaustion left the user no better option than to route around the product entirely
**Severity:** Blocker — the most serious finding in this log

The clearest single fact from this run: of roughly 60 real bugs fixed against Jinvani_OTT, the first ~20 went through CodeForge's task pipeline. The remaining ~40 did not.

This was a deliberate, sensible call by the user, not a breakdown they were caught in. After GAP-027 (quota exhaustion) and GAP-028 (infrastructure failures with no retry) took out twelve queued tasks in one sitting, continuing to wait on CodeForge — with no visibility into when the quota would clear, no partial credit for the two tasks that had already produced working, reviewed code before failing, and no way to resume a failed task rather than re-typing it — was the worse option on time alone. Switching the remaining work to a plain Claude Code session in the connected repository was the rational move, and it worked: it delivered the other 40 bugs correctly. The gap is not the decision. The gap is that the product gave a competent user, using it exactly as intended, no better option than to leave it.

Once that decision was made, the rest followed from it: work moved to a hand-written specification file committed to the *connected project's own repository* and handed to that separate Claude Code session, entirely outside any task, workspace, orchestrator, or worker this product owns. Every remaining PR was written there and merged after review in a plain chat conversation, not through the product's REVIEW state, its independent-review agent, or its board.

Nothing about that second half was a fallback the product offered. It was the user reconstructing, by hand, what the product was supposed to do:

- **A backlog** — one file (`BUGS_TO_FIX.md`) listing every remaining item, root cause, and constraint, playing the role GAP-020 already named as missing: the product's unit is a task, the user's unit is a backlog.
- **Dependency ordering between tasks** — decided by a human before work started, because GAP-021 (parallel tasks unaware of each other) has no answer inside the product either.
- **Merge conflict resolution** — three separate real git conflicts arose between branches produced by that session, because two of them touched the same file in the same region. Each had to be fetched, merged, and hand-resolved outside the product, then re-verified with `flutter analyze` and pushed. A platform whose own worker runs tasks in parallel against one repository (GAP-021) will produce exactly this shape of conflict at scale, and today has nothing that detects, orders, or resolves it — a human filled that role for thirteen branches in a row.
- **Release readiness** — building the actual Android APK surfaced a Gradle/Kotlin JVM-target failure that `flutter analyze` (the only check ever configured) could not have caught, because it only compiles Dart. Diagnosing and fixing it took three iterations outside the product. Nothing in the product's validation model runs a real release build; GAP-003 and GAP-004 already describe why a declared check can be too shallow to mean anything, and this is a concrete instance at the point that matters most — the artifact that actually ships.

None of this required a new failure to discover. It is what GAP-020, GAP-021, GAP-027 and GAP-028 already predicted, observed in sequence on one project: the moment execution got hard, the product's actual role shrank to "a place two of the many PRs came from," and the rest of a real delivery — sequencing, conflict resolution, and shipping the built artifact — happened around it, not through it.

**Direction:** this is not one fix. It is the argument for treating GAP-020/021/027/028 as one connected priority rather than four independent backlog items — a backlog-native task model, cross-task awareness on one repository, and resilient execution are the same feature looked at from different angles, and none of the other gaps in this file matter at production scale until it exists.

### GAP-031 — Token usage and cost are never recorded on `AgentRun`, so per-task cost cannot be reported
**Severity:** Medium — blocks any honest cost-per-task or model-comparison claim

Asked for cost per task on the completed Jinvani_OTT work, the platform could not answer: all 75 Jinvani `agent_runs` rows have `cost_json` NULL. `OpenCodeAdapter` (`parseResult` / `extractFromJsonRecord`) only reads legacy flat fields (`input_tokens`, `output_tokens`, `cost_usd`), which OpenCode's real event stream does not emit. The real numbers exist only in OpenCode's own `~/.local/share/opencode/opencode.db` (`session` table, joinable to a task by workspace directory), and had to be recovered by hand. OpenCode's `cost` is its own estimate, not provider-billed.

**Update — Phase 4A.1 real-provider run:** the same gap applies to backlog analysis (`analysis.cost` is `null`) even though OpenCode's own database recorded that run's real usage (12,446 input / 349 output / 1,150 reasoning tokens, ≈ US$0.005). Still open.

**Direction:** capture usage (input, output, reasoning, cache read/write, cost) from OpenCode's step-finish events or its session record into `AgentRun.cost` at run end, and roll it up per task in the report. Failed tasks must be included: on Jinvani, 10 matched FAILED tasks still consumed ~$1.49, about 58% on top of the cost of the 19 that completed.

**Narrowed — Phase 4A.2 (not closed).** *Solved:* the OpenCode adapter now parses OpenCode's real per-step `step_finish` events (shape captured live) into a provider-agnostic, normalized `CostMetadata` — input, output, reasoning, cache-read and cache-write tokens — with an engine-reported cost kept as a **separate** `estimatedCost { amount, currency, pricingSource, pricingVersion }`. It is persisted on backlog analyses (with provider/model/engine) and, through the same adapter code and unchanged `AgentRun` persistence, on coding runs. Unavailable stays `null`/absent (never `0`; a reported cost of `0` beside real tokens is treated as "no price known"), and the API/UI show usage and cost only when present, labelled as an estimate with its source. *Evidence:* `tests/engine-usage.test.ts` (accumulator rules; the adapter fed the real captured event shape; persistence; DTO nulls) and `tests/backlog-api.test.ts` (HTTP contract); real runs recorded e.g. 7,499 in / 519 out / 1,507 reasoning / 8,157 cache-read tokens and an OpenCode estimate of US$0.0051. *Still open:* (1) the task report does not yet roll up reasoning/cache tokens or estimated cost per task (it sums input/output only); (2) capture for a real **task** run (Implementer/Reviewer) is verified by adapter tests but was not observed in a live task; (3) the only price is the engine's own estimate — there is no platform price table, so cost cannot be computed for an engine that reports none, and it is not provider-billed. *Closure criteria:* a per-task cost/usage roll-up in the report, verified on one real task, with the estimate's provenance shown.

### GAP-032 — Backlog analysis sees a file listing, not code
**Severity:** Friction

Phase 4A's analysis ([BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md)) receives the item, the project's context, sibling items and a bounded *listing* of file paths — never file contents. "Affected area" and "candidate files" are educated guesses from names. The platform labels each candidate as present-in-repository or not, but it cannot verify a file is *relevant*, and root-cause investigation is still left to the Implementer. The first real-provider run (Phase 4A.1, §12 of that document) showed the effect concretely: every candidate file was real, yet a summary asserted a limiter was *missing* while the listing it had been given contained `otpThrottle.ts` — the fix had already landed — and it reported `high` confidence.

**Status — execution half CLOSED in Phase 4A.1; the entry stays open for the listing-only limitation.** This entry originally also recorded that analysis ran unqueued inside the API process. That is closed, on evidence, against every criterion set for it: analysis is a persisted **job** claimed and executed by the **worker** (`BacklogAnalysisRunner` on the existing `Worker` loop); the API process holds no analyzer/engine and calls no model (`BacklogService` has no such dependency; asserted in `tests/backlog-analysis-worker.test.ts`); a **global concurrency cap** (`MAX_BACKLOG_ANALYSIS_CONCURRENCY`, default 2) is enforced by the database claim across processes — three platform instances, six jobs, cap 2, never more than two live model calls; crash recovery via lease expiry with a bounded attempt count; retries reuse the existing failure classifier, backoff and provider health and are bounded (malformed output and permanent errors are never retried); worker/lease/fencing/duplicate-claim/multi-worker tests exist; configuration is validated at startup and documented (`.env.example`, DEPLOYMENT.md, INTERNAL_ALPHA.md). It was also validated with a real separate `run-worker` process and the real model. *Still true:* there is no cost/usage figure on the analysis (GAP-031), and with no worker running analyses simply wait.

**Direction (remaining):** let the context builder consume a real repository index (the `RepositoryStructureProvider` seam exists for exactly this), and add platform-side "claim vs evidence" checks — e.g. flag when a candidate file's own name suggests the mitigation already exists — before Phase 4B makes bulk analysis routine. *Closure criteria:* an analysis grounded in file *contents* for the candidate files, with the platform contradicting or flagging claims the evidence disagrees with.

---

**Further narrowed — Phase 4A.2.** Analysis is no longer names-only: the platform now reads a bounded amount of real file content (≤12 files, 64 KiB per file, 256 KiB total, 30 s; never secret files — see [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md) §4a), excerpts the ≤6 most name-relevant files into the prompt, and checks the model's structured claims against listing and content evidence — a contradiction is detected deterministically and a confident contradicted claim forces `NEEDS_CLARIFICATION`. Real runs showed the model grounding on actual code (citing real behaviour of the throttle service and a real mobile file) once it could see content. *Still true, and why this stays open:* analysis is **not code-aware** — file selection is by *name relevance* (the relevant file can be missed entirely), search is term-based (no index, no symbols, no call graph), a bounded search can never prove absence, and behaviour can never be established (GAP-033). *Closure criteria:* selection driven by a real repository index rather than filename overlap, with the platform flagging claims that the code it read disagrees with — measured on a set of real backlog items, not single runs.


### GAP-033 — Backlog analysis cannot obtain executed evidence, so behaviour claims are never settled
**Severity:** Friction

Phase 4A.2's evidence types are the ones the platform can obtain by *reading*: `FILE_EXISTS`, `FILE_NOT_FOUND`, `PATH_MATCH`, `CONTENT_MATCH`. Nothing in analysis runs a command, so `TEST_RESULT` (and richer types such as symbol or config presence) does not exist. The consequence is designed-in and honest — a `BEHAVIOR_CORRECT` / `BEHAVIOR_INCORRECT` claim is always `UNRESOLVED`, a `FEATURE_ABSENT` claim with no match is at best `UNRESOLVED`, and "SUPPORTED" only ever means "something matching exists" — but it means an analysis can tell a developer *what exists*, never *whether it works*. Two related soft spots: the model chooses each claim's `kind`, so a behavioural sentence can be mislabelled as an existence claim (mitigated by the platform-set `establishes` scope, a prompt instruction, and prominent UI labelling — not eliminated; observed once in a real run); and claim search needs ≥ min(2, n) distinct terms, so a claim with a single good term can neither contradict nor be supported by a match.

**Direction:** when execution is in scope (the reproduce/verify contract of GAP-016 already runs project-configured checks under platform control), allow analysis to request one of the project's own approved checks and record its captured result as `TEST_RESULT` evidence, exactly as reviewer verification does — never a model-supplied command. *Closure criteria:* a behaviour claim settled by platform-captured check output on a real item.

---

## Closed

### GAP-015 — The agent can move off the task branch, and the platform pushes the wrong one
**Severity:** Trust — the most serious gap found so far

**What happened.** The task was provisioned on branch `mobile-app-bug-fiixes`. During its run the coding engine executed its own `git checkout -b fix/name-validation` and committed there. The platform never noticed:

1. `commitAll` ([`git-commit.ts`](../src/source-control/git-commit.ts)) commits on whatever `HEAD` is — so the platform's own commit landed on the agent's branch too.
2. `push` ([`github-source-control-provider.ts`](../src/source-control/github-source-control-provider.ts)) runs `git push -u origin <workspace.branch>` **by name**. That pushed `mobile-app-bug-fiixes`, which still pointed at the original, untouched commit. Git answered "Everything up-to-date", exit code 0.
3. The platform recorded `BRANCH_PUSHED` — twice — for pushes that published nothing.
4. The Reviewer approved the (correct) diff, which had never left the machine.
5. Pull request creation then asked GitHub for a PR from a branch with zero commits ahead of `main`, and got a `422`.

Final state, verified on GitHub: the branch is 10 behind, 0 ahead, no PR. The approved work lived only on a local branch nobody told the user about.

The OpenCode adapter's own header comment ([`opencode-adapter.ts`](../src/coding-engine/opencode-adapter.ts)) lists as a security-boundary property: "Does not perform git commit/push/PR creation; those remain platform-owned." That is a description of intent, not something enforced — the engine runs with full access to the workspace's `git`, and in this task it created a branch and made its own commit (`890483b`, authored as a conventional-commit message, before the platform's `[task …]` commit on top of it).

**Why the agent did it.** The connected project's own context manifest said "Always create and work on task-specific feature or fix branches." That is a sensible rule for a human developer in that repository and an actively harmful one for an agent running inside this platform, which already owns branching. Nothing in the platform's prompt told the agent that git branch management is off-limits, so project context won the conflict.

**Why this is the worst entry in this file.** Every step reported success. No check failed, no error was raised, the event log shows a clean commit → push → review → approve sequence. The only symptom arrived at the very end, as an unreadable `422` (GAP-013), on a step that had nothing to do with the actual fault. Without that final PR step — for example on a provider where PR creation is optional — this would have been silently lost work reported as done.

**Direction:**
- Assert before every commit and every push that `HEAD` is on the workspace's recorded branch; if not, fail loudly with both branch names, never commit or push anyway.
- Push by explicit refspec (`HEAD:refs/heads/<branch>`) after that assertion, and verify afterwards that the remote ref equals local `HEAD` before recording `BRANCH_PUSHED`.
- State in the platform-owned part of the prompt that branch creation, checkout, commit and push belong to the platform, and that platform instructions take precedence over project context on git operations. Project context is data, not policy — [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) already says so for the manifest; the prompt needs to enforce it.

**Closed — V1.1 Slice 1 (Execution Integrity & Evidence).** Every item in Direction above is implemented and covered by tests against real git, not mocks (`tests/git-commit.test.ts`, `tests/branch-integrity.test.ts`): `git-commit.ts`'s `assertOnExpectedBranch` refuses to commit or push when the workspace's actual branch disagrees with the task's recorded one (`BranchMismatchError`, carrying both branch names as structured fields, not just prose); both `GitHubSourceControlProvider.push` and `LocalGitSourceControlProvider.push` push by explicit refspec (`HEAD:refs/heads/<branch>`) and read the remote ref back afterward, throwing `PushVerificationError` if it disagrees, before `BRANCH_PUSHED` is ever recorded; and `buildImplementerPrompt` now explicitly forbids the agent from running git branch/checkout/commit/push itself and states that project context does not override this. See [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) "Project context is data, not policy" for the two-layer explanation (prompt instruction + independent enforcement).

---

## Source of these entries

GAP-001 through GAP-012 were recorded while connecting and preparing a real production monorepo (a Node/Express + Next.js + Flutter application) and planning a batch of bug-fix tasks against it, in September 2026. GAP-013 through GAP-016 came from the first real task executed against that repository, and were verified against the task's event log, its leftover workspace's git state, and the repository's branch list on GitHub. They are user-observed, not speculative.

Worth recording alongside them: on that same run the core loop did exactly what it was designed to do. The Implementer fixed two validator files; the Reviewer, in a fresh context, rejected the work because a third file carried the same bug; the Implementer fixed that too; the second review approved. Independent verification caught a real miss that the Implementer had reported as complete. Every gap above is in the machinery around that loop, not in the loop itself.

The retry of that task (PR #67 on the connected repository) succeeded end to end, and is evidence for two of the proposed directions. With the project context's git-branching line replaced by "the platform owns branches; never run git yourself," the agent stayed on the task branch and the push published the real commit — at the time, that was a workaround relying on user-authored context rather than a platform guarantee. It no longer is: GAP-015 is now closed by an actual assertion the platform enforces regardless of what any project context says (see the Closed section above and [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) "Project context is data, not policy"). And with the task explicitly asking the agent to execute a throwaway check and report its output, it did, and the result was correct: an independent run of the real Zod schemas against all seventeen inputs matched on every field. Executable verification works when requested; GAP-016 is about making it the default rather than something the user must know to ask for — the Reviewer now at least says plainly which one it did (V1.1 Slice 1), but nothing yet makes "executed" the default the way this one manual retry was.

---

### Phase 4A.3 status updates

**GAP-031 — CLOSED (Phase 4A.3), on evidence.** Real task usage capture and a task-level roll-up are both demonstrated: a real OpenCode task (real model, no fixture) produced 3 AgentRuns whose persisted `cost_json` equals OpenCode's own raw `step_finish` events and the `TaskReport.usage` totals exactly — twice (see [BACKLOG_INTELLIGENCE.md](./BACKLOG_INTELLIGENCE.md) §14). The roll-up counts each AgentRun once, keeps null ≠ 0, separates the engine's estimate from a never-computed CodeForge cost, and distinguishes implementation / fix / review / verification-follow-up runs. Residual, tracked separately: GAP-034.

**GAP-032 — still open, narrowed again.** A revision-bound, platform-generated index (symbols, routes, feature/application, roles, resolved imports; TS/JS/Dart) now drives file selection and existence evidence, and found files a name search cannot. *Not closed because:* selection is a regex-extracted shortlist, not code understanding; in real runs generic words still pulled irrelevant files to the top and the file containing the real fix was often not excerpted; the index is partial for large repos (`complete: false`); no call graph; behaviour is still not established; and the claim of improvement rests on a handful of non-independent observations, not a measured set. *Closure criteria (unchanged in spirit):* selection quality measured on a set of real backlog items, and evidence able to answer the model's own questions.

**GAP-033 — OPEN.** A platform-owned verification seam exists (`planVerification`/`runVerification`/`applyVerification`, reusing the approved-check machinery, revision-bound before *and after* the run, model cannot name a command) and is tested against real git workspaces — but it is **disabled** for analysis, and a passing check is not bound to a specific claim, so no behaviour claim can be settled. Closure needs analysis-time execution turned on under policy plus per-claim check binding.

**GAP-034 — Usage of an engine invocation that fails before returning is not recorded** *(Low–Medium)*. The OpenCode adapter parses usage only from a completed run's output. A timeout/kill/non-zero exit records `cost: null`, and tokens spent in earlier failed attempts inside one run's internal retries are not added, so failed/interrupted runs are under-counted (the original GAP-031 measurement found failed Jinvani tasks ≈ +58% cost). The roll-up is honest about it (such runs show no usage) but cannot include what was never captured. *Direction:* attach partial usage parsed from captured stdout to the thrown engine error and persist it on the failed AgentRun; sum across internal retry attempts.

**GAP-020 / GAP-021** — unchanged (open/narrowed): no bulk analysis, and relationship proposals are still not enforced.

---

### Phase 4A.4 status updates

**GAP-034 — CLOSED (Phase 4A.4), on real evidence.** Usage emitted before a timeout, cancellation or non-zero exit is captured and persisted as `usageStatus: "partial"` on the failed/cancelled `AgentRun` (and on a failed backlog analysis); nothing emitted stays `null` (never zero); the roll-up reports `partial`/`unavailable`/`complete`. Demonstrated with real OpenCode: a run killed by its timeout after 2 `step_finish` events persisted exactly the emitted usage (5,999 in / 125 out …, US$0.0022337) and the report reconciled; success-path reconciliation unchanged (86,369 in / 957 out …). *Residual (not a reason to keep this open):* a job-level backlog-analysis retry writes no row for its failed attempt, so that attempt's usage is not recorded.

**GAP-032 — still OPEN, narrowed by measurement.** A deterministic benchmark now exists and measured **16 real items / 38 expected files**: the index lifts candidate recall 60.5% → 84.2% and items with an excerpted expected file 37.5% → 50%, but median rank is unchanged (~10–11), half the items still show the model none of the files the real fix touched, and the index made excerpt recall *worse* on items whose symptom already names files. Not closed because the sample is small (17 merged fixes were available, 16 usable), ground truth is fix-modified files (a lower bound, not independently adjudicated), and selection quality is plainly insufficient for bulk analysis.

**GAP-033 — OPEN.** Reconciliation makes conflicts between an absence claim and repository evidence visible (`IMPLEMENTATION_PRESENT`/`POSSIBLE`, never "fixed"), and defines `CHECK_VERIFIED`, but no platform-owned behavioural execution is bound to any claim, so behaviour is never verified during analysis. (Also: in every real run the model produced behaviour claims, so even the conflict signal has not fired with a real model.)

**GAP-031** — CLOSED (Phase 4A.3), unchanged. **GAP-020 / GAP-021** — unchanged.
