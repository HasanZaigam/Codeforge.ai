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

---

### GAP-021 — Parallel tasks on one repository have no awareness of each other
**Severity:** Friction → Trust at backlog scale

Each task branches independently from `main`. Nothing notices when two tasks will edit the same files. In the first real backlog, BUG-006, 009, 012 and 013 all touch the same three validator files; created as four tasks — which is exactly what a backlog user importing a sheet would do — they would produce four PRs that each conflict with the others after the first merge, or worse, four slightly different regexes.

At one task at a time this is invisible. At 78 tasks with two running concurrently it is the normal case, and it converts "come back to finished PRs" into "come back to a merge-conflict queue."

**Direction:** before starting, estimate each task's touched paths (the investigation step can produce this) and either serialize overlapping tasks, stack them, or propose merging them into one task. Surface the overlap in the batch view.

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

---

### GAP-024 — Reports contain verification output that was never produced
**Severity:** Trust — this undermines every other report the product writes

Task summaries are the product's primary evidence surface. Three in one batch contained statements that are demonstrably false, and all three were approved by the Reviewer.

1. The validation-middleware task reported its verification output as `String must contain at least 1 character(s)` with a Zod v3 issue shape. That project runs **Zod 4.3.6**, which produces `Invalid input: expected string, received undefined`. Re-running the same scenarios against the real middleware gives the v4 messages. The reported output could not have come from this codebase.
2. The Continue Watching task presented a "Previously / Updated to" diff claiming it had changed `duration > 0` to `duration > 30`. The real diff shows it **added** the entire clause; the "previous" line it quoted never existed.
3. The profile-deletion task stated "the deleteProfile method already contained the logic required … it was failing the type check" — on a first run against untouched `main`, where that method had no checks at all.

The underlying code in cases 1 and 3 turned out to be correct when executed independently, which is what makes this dangerous: the fabrication is invisible precisely when the work is fine, so a user learns to trust the report, and is then wrong about the one case where it matters.

**Direction:** the platform, not the agent, must own evidence. Command output belongs in the report because the platform captured it — as it already does for declared checks — not because the agent transcribed it. Any output an agent produces inside its own summary should be labelled as the agent's claim, not presented as a result.

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

## Closed

_Nothing yet._

---

## Source of these entries

GAP-001 through GAP-012 were recorded while connecting and preparing a real production monorepo (a Node/Express + Next.js + Flutter application) and planning a batch of bug-fix tasks against it, in September 2026. GAP-013 through GAP-016 came from the first real task executed against that repository, and were verified against the task's event log, its leftover workspace's git state, and the repository's branch list on GitHub. They are user-observed, not speculative.

Worth recording alongside them: on that same run the core loop did exactly what it was designed to do. The Implementer fixed two validator files; the Reviewer, in a fresh context, rejected the work because a third file carried the same bug; the Implementer fixed that too; the second review approved. Independent verification caught a real miss that the Implementer had reported as complete. Every gap above is in the machinery around that loop, not in the loop itself.

The retry of that task (PR #67 on the connected repository) succeeded end to end, and is evidence for two of the proposed directions. With the project context's git-branching line replaced by "the platform owns branches; never run git yourself," the agent stayed on the task branch and the push published the real commit — the workaround for GAP-015 holds, though it relies on user-authored context rather than a platform guarantee. And with the task explicitly asking the agent to execute a throwaway check and report its output, it did, and the result was correct: an independent run of the real Zod schemas against all seventeen inputs matched on every field. Executable verification works when requested; GAP-016 is about making it the default rather than something the user must know to ask for.
