import { z } from "zod";

/**
 * Request-body validation at the API boundary — the domain remains
 * authoritative for anything state-related (see /docs/API.md "Validation").
 * These schemas only shape *input*; they never accept status, ids the
 * server should assign, or anything else the client shouldn't control.
 */

const CommandsShape = z.object({
  build: z.string().trim().min(1).optional(),
  test: z.string().trim().min(1).optional(),
  lint: z.string().trim().min(1).optional(),
  typecheck: z.string().trim().min(1).optional(),
});

const CommandsSchema = CommandsShape.optional();

/**
 * `PATCH /projects/:projectId/commands` — lets an owner declare/edit the build/test/lint/typecheck
 * commands after a project already exists, not just at creation time. See
 * ProjectRepository.updateCommands (previously unused — every check `runValidation` doesn't have a
 * declared command for is silently *skipped*, not failed, so a project connected with no commands at
 * all currently gets no automated validation whatsoever on any task). A field omitted here clears
 * that check (declared, not merged) — the request body is the new, complete `commands` object, not a
 * partial patch of individual keys.
 */
export const UpdateProjectCommandsSchema = z.object({ commands: CommandsShape });

// GitHub's own rules: owners/orgs are alphanumeric-and-hyphens, max 39 chars, no leading/trailing
// hyphen; repo names are alphanumeric/._- , max 100 chars. Validated here — before either string
// ever reaches a shell command or a URL — so an unexpected character is a 400, not a surprise
// three layers down. See /docs/GITHUB_INTEGRATION.md "Repository connection".
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

// Matches an https/ssh/git remote pointed at github.com (or *.github.com, e.g. a GitHub
// Enterprise-style subdomain) in any of its common forms: https://github.com/o/r.git,
// git@github.com:o/r.git, ssh://git@github.com/o/r.git. A `local-git` project's `repoUrl`
// resolves credential-free (LocalGitSourceControlProvider.resolveCloneCredential always returns
// null — see /docs/GITHUB_INTEGRATION.md "Local git / plain-git testing"), so pointing it at a
// real GitHub remote would push using whatever ambient git credentials happen to be configured on
// the host (an SSH agent, a credential helper, ~/.netrc) — silently bypassing this platform's
// per-user encrypted PAT storage and PR-based review workflow entirely. Rejected here, mirroring
// the client-side "looks like a URL not a repo name" heuristic already used for the `github`
// branch's `repo` field (see web/src/components/projects/CreateProjectDialog.tsx).
const GITHUB_HOST_IN_URL = /(^|[/@.])github\.com([/:]|$)/i;

function isGitHubLookingUrl(value: string): boolean {
  return GITHUB_HOST_IN_URL.test(value.trim());
}

/**
 * Parses a pasted GitHub repository URL into `{ owner, repo }` — the
 * server-side counterpart to the "paste a URL" project-connection flow (see
 * /docs/GITHUB_INTEGRATION.md "Repository connection"). Deliberately never
 * trusts client-side parsing alone: this is the single source of truth,
 * called from the `POST /projects/verify-github-repo` handler. Accepts the
 * common forms a user might paste:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo/ (trailing slash)
 *   - git@github.com:owner/repo.git (SSH shorthand)
 *   - ssh://git@github.com/owner/repo.git
 * Returns null for anything else (not a github.com host, missing owner/repo,
 * extra path segments, or an owner/repo that doesn't pass GitHub's own
 * naming rules) rather than throwing — the caller turns that into a clear
 * 400, never a raw regex-failure message.
 */
export function parseGitHubRepoUrl(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // Normalize the SSH shorthand ("git@github.com:owner/repo.git") to a URL-parseable form before
  // handing it to the WHATWG URL parser, which doesn't understand that syntax on its own.
  const normalized = /^git@github\.com:/i.test(trimmed) ? trimmed.replace(/^git@github\.com:/i, "https://github.com/") : trimmed;

  let url: URL;
  try {
    // A bare "owner/repo" or "ssh://git@github.com/owner/repo.git" both parse fine here.
    url = new URL(normalized.includes("://") || /^git@/i.test(normalized) ? normalized : `https://${normalized}`);
  } catch {
    return null;
  }

  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) return null;

  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, "");
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo)) return null;

  return { owner, repo };
}

/**
 * Safe charset for a user-supplied git branch name — reused for both a
 * custom "new branch" name and an "existing branch" selection (see
 * /docs/TASK_LIFECYCLE.md "Branch modes" and CreateTaskDialog). Deliberately
 * conservative rather than matching git's full (permissive, foot-gun-prone)
 * ref-name grammar: alphanumerics, `.`, `_`, `-`, `/` only; must start with
 * an alphanumeric (rules out a leading `-`, which git could otherwise
 * misinterpret as a flag — see git-commit.ts/local-git-workspace-provider.ts,
 * every git invocation already uses execFile with an argv array, never shell
 * interpolation, but a leading `-` is still rejected here as defense in
 * depth). No ".." (path-traversal-shaped, and invalid in a git ref regardless),
 * no trailing "/" or ".lock", no "//".
 */
const BRANCH_NAME_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isSafeBranchName(value: string): boolean {
  if (!BRANCH_NAME_CHARSET.test(value)) return false;
  if (value.includes("..")) return false;
  if (value.includes("//")) return false;
  if (value.endsWith("/") || value.endsWith(".lock")) return false;
  return true;
}

const BranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isSafeBranchName, {
    message:
      "Branch name may only contain letters, numbers, '.', '_', '-', '/' — no leading '-', no '..', no trailing '/' or '.lock'.",
  });

export const CreateProjectSchema = z.discriminatedUnion("sourceControlProvider", [
  z.object({
    sourceControlProvider: z.literal("github"),
    name: z.string().trim().min(1).max(200),
    owner: z.string().trim().regex(GITHUB_OWNER, "Not a valid GitHub owner/organization name"),
    repo: z.string().trim().regex(GITHUB_REPO, "Not a valid GitHub repository name"),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    codingEngine: z.string().trim().min(1).max(100).optional(),
    commands: CommandsSchema,
  }),
  z.object({
    sourceControlProvider: z.literal("local-git"),
    name: z.string().trim().min(1).max(200),
    repoUrl: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((v) => !isGitHubLookingUrl(v), {
        message:
          "A local-git project's repository URL cannot point at github.com — that would push real commits " +
          "using ambient host git credentials, bypassing GitHub authentication and Pull Request review entirely. " +
          "Use the \"GitHub repository\" source control option instead.",
      }),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    codingEngine: z.string().trim().min(1).max(100).optional(),
    commands: CommandsSchema,
  }),
]);

export const ConnectGitHubSchema = z.object({
  token: z.string().trim().min(1).max(4000),
});

/** POST /projects/verify-github-repo — see ProjectService.verifyRepositoryUrl. */
export const VerifyGitHubRepositorySchema = z.object({
  repoUrl: z.string().trim().min(1).max(2000),
});

/**
 * Branch-mode task creation (see /docs/TASK_LIFECYCLE.md "Branch modes").
 * `branchMode` defaults to "new" — every pre-existing client that only ever
 * sent `{ title, description }` keeps working unchanged. `existingBranch` is
 * required (and only meaningful) when `branchMode === "existing"`;
 * `branchName`/`baseBranch` are only meaningful for `branchMode === "new"`
 * and are both optional (auto-derive / project default respectively).
 */
export const CreateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(10_000),
    branchMode: z.enum(["new", "existing"]).optional(),
    branchName: BranchNameSchema.optional(),
    baseBranch: z.string().trim().min(1).max(200).optional(),
    existingBranch: BranchNameSchema.optional(),
    /**
     * Explicit, user-selected dependency task ids (see /docs/TASK_LIFECYCLE.md "Task
     * dependencies") — deterministic, user-defined only, never AI-inferred. Optional and only
     * meaningful at creation; TaskService.editBacklogTask ignores this field entirely (dependency
     * edits go through the dedicated POST/DELETE /tasks/:taskId/dependencies endpoints instead —
     * see EditTaskSchema's own doc comment below for why the field still shows up there).
     */
    dependencyIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  })
  .refine((data) => (data.branchMode ?? "new") !== "existing" || !!data.existingBranch, {
    message: 'existingBranch is required when branchMode is "existing"',
    path: ["existingBranch"],
  });

/**
 * POST /tasks/:taskId/edit — editing a BACKLOG task's configuration (see
 * TaskService.editBacklogTask). Deliberately the exact same field set and
 * validation rules as task creation (title/description/branch selection) —
 * an edit is "redo the same choices a human made at creation time," never a
 * status write (the server-side BACKLOG-only guard lives in the service
 * layer, not here). Reusing CreateTaskSchema outright keeps the
 * branch-name/base-branch validation logic in exactly one place. `dependencyIds`, if present, is
 * simply ignored by TaskService.editBacklogTask — dependency edits are their own dedicated
 * POST/DELETE /tasks/:taskId/dependencies operations (see tasks.ts), so a client that happens to
 * resend the field it read from GET /tasks/:taskId/dependencies is harmless, not double-applied.
 */
export const EditTaskSchema = CreateTaskSchema;

/** POST /tasks/:taskId/dependencies — adds one explicit dependency edge. See TaskService.addDependency. */
export const AddDependencySchema = z.object({
  dependsOnTaskId: z.string().trim().min(1).max(200),
});

export const SubmitInputSchema = z.object({
  selectedOption: z.string().trim().min(1).max(300).nullable().optional(),
  freeText: z.string().trim().min(1).max(10_000),
});

export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  // A length floor, not a "strength" policy (composition rules push people toward predictable
  // patterns more than they help) — see /docs/AUTHENTICATION.md "Password security".
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(200),
});

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});
