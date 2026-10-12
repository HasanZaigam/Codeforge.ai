### Token usage & budgets *(TD-63)*
- `GET /projects/:projectId/token-usage` → `{ usage }`: this calendar month (UTC) — `used`, `estimatedTokens` (the estimated part), `unreportedOperations`, `budget`, `remaining`, `percentUsed`, and `breakdown.{tasks,analyses,chat}` (`tokens`, `estimatedTokens`, `unreported`, `operations`).
- `PUT /projects/:projectId/token-budget` — `{ monthlyTokens: number | null }` (positive integer, or null to remove). Display only; nothing is ever blocked.
- `GET /settings/token-usage` → `{ usage }`: the same meter across every project the user owns, plus `projects[]` (`projectId`, `name`, `used`, `estimatedTokens`, `budget`). `PUT /settings/token-budget` — `{ monthlyTokens }` for the account.
- Chat messages carry `tokens` (assistant replies: 0 = answered without a model call; null = unknown) and `tokensEstimated`. `TaskReport.usage.totalTokens` = input + output + reasoning over the runs that reported usage. `BacklogAnalysisDTO.tokenCount` = `{ tokens, estimated }` or null.

### Projects & repositories *(multi-repository projects — TD-62)*
- `POST /projects` — `{ name }` creates a project with no repository yet; the original `{ name, sourceControlProvider, owner+repo | repoUrl, defaultBranch?, commands? }` shape still creates it with its first repository. `ProjectDTO` gains `repositories: ProjectRepoDTO[]` (primary first); its top-level `repoUrl`/`defaultBranch`/`sourceControlProvider`/`owner`/`repo`/`commands` describe the primary repository (empty when there is none).
- `GET /projects/:projectId/repositories` → `{ repositories }`.
- `POST /projects/:projectId/repositories` — `{ sourceControlProvider: "github", name?, owner, repo, defaultBranch? }` or `{ sourceControlProvider: "local-git", name?, repoUrl, defaultBranch? }` → `201 { repository }`. GitHub repositories are verified with a real API call first. `name` (default: the repository's own name) is unique per project — `409 DUPLICATE_REPOSITORY_NAME`; the same repository URL twice is `400 INVALID_REPOSITORY`.
- `PATCH /projects/:projectId/repositories/:repositoryId` — `{ name?, defaultBranch? }` (a GitHub branch is checked to exist).
- `PATCH /projects/:projectId/repositories/:repositoryId/commands` — `{ commands }`, full replacement, same semantics as the project-level endpoint.
- `DELETE /projects/:projectId/repositories/:repositoryId` → `204`, or `409 REPOSITORY_IN_USE` while any task or backlog item targets it.
- `GET /projects/:projectId/branches?repositoryId=` — branches of one repository.
- `POST /projects/:projectId/tasks` / `POST /tasks/:taskId/edit` accept `repositoryId`: optional with one repository, required with several (`400 REPOSITORY_REQUIRED`, `details.available` = the names). `TaskDTO` carries `repositoryId`; `GET /tasks/:taskId` also `repositoryName`.
- Backlog: `POST /projects/:projectId/backlog` and `PATCH /backlog/:itemId` accept `repositoryId` (create: default primary; changing it resets the item to NEW); `POST /projects/:projectId/backlog/imports` accepts `repositoryId` for every imported row. `BacklogItemDTO` carries `repositoryId`.



### Run-scoped sampling *(Phase 4B.4)*
`GET .../adjudication/sample/*` accepts an optional `runId` (a `backlog_bulk_jobs` id) restricting the sample to that run's own successfully-analysed members; `POST .../adjudication/baselines` accepts the same field. Every response/record also carries `infrastructureFailures` (failed/skipped run members, reported, never sampled). A `runId` from another project, or one that does not exist, is refused before any sampling happens.

### Chat *(Phase 4C — see docs/CHAT.md)*
- `GET /projects/:projectId/chat/messages` — returns `{ messages, pendingAction }`: the caller's one conversation for this project, oldest first, plus the mutation (if any) Chat has proposed and is waiting on an explicit yes/no reply for — a bulk mutation (Phase 4D.3 — `{ kind: "BULK_CANCEL" | "BULK_START", status, taskIds, titles, createdAt }`) or a single-task human-confirmed completion (Phase 4D.4 — `{ kind: "HUMAN_MARK_DONE", taskId, taskTitle, observedStatus, createdAt }`), or `null`.
- `POST /projects/:projectId/chat/messages` — `{ text, attachment?: { filename, mimeType, contentBase64 } }`. `text` may be empty only if an attachment is present. Returns `{ userMessage, assistantMessage, pendingAction }` — the assistant's reply is always present in the SAME response (no polling for a reply); `pendingAction` is the SAME shape as above, reflecting the conversation's state immediately after this turn. An assistant message that started a real bulk analysis run carries `bulkJobId`. A `.csv`/`.xlsx` attachment reuses the existing import pipeline (`400` on an unsupported/oversized/mistyped attachment); a `.txt`/`.md` attachment is folded into the prompt as reference text; a `.png`/`.jpg`/`.jpeg`/`.webp` attachment is accepted and validated (real magic bytes) but Chat truthfully reports that image analysis isn't available (Phase 4D.2 — no multimodal model in this stack). Confirming/declining ANY pending action (bulk or human-completion) is NOT a separate endpoint — send the plain text `"yes"`/`"no"` through this same route.
- `GET /projects/:projectId/chat/suggestions/:bulkJobId` — reuses `BacklogBulkService.reviewRows`, filtered to items with something to act on. `404` if the run doesn't belong to the caller's project.
- `POST /projects/:projectId/chat/create-tasks` — `{ itemIds: string[] }` (1–50). Reuses the existing generate→approve→convert bulk-action chain; returns `{ createdTaskIds, results }`. Every created task starts in `BACKLOG`, never started.

### AI / Models *(Phase 4C)*
`GET /settings/ai-model` — read-only, global (not project-scoped): `{ configured, models: [{ modelId, providerId, engineKey }], autoDescription }`, reflecting the platform's real `ModelRegistry` state. Deliberately narrow — see `src/api/routes/ai-model.ts`'s own doc comment for why it never reports a provider the backend can't actually execute.
