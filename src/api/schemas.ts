import { z } from "zod";

/**
 * Request-body validation at the API boundary — the domain remains
 * authoritative for anything state-related (see /docs/API.md "Validation").
 * These schemas only shape *input*; they never accept status, ids the
 * server should assign, or anything else the client shouldn't control.
 */

const Term = z.string().trim().toLowerCase().regex(/^[a-z0-9]{2,30}$/, "binding terms are single lowercase words");

/** An approved, claim-bindable behaviour check (Phase 4A.5) — declared by the project OWNER, never by a model. Strict: an unknown key is a 400. */
const ClaimCheckShape = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, "check ids are lowercase letters, digits and hyphens"),
    description: z.string().trim().min(1).max(300),
    command: z.string().trim().min(1).max(2000),
    timeoutMs: z.number().int().min(1000).max(900_000).optional(),
    application: z.string().trim().min(1).max(100).optional(),
    requiresFiles: z.array(z.string().trim().min(1).max(400).regex(/^(?!\/)(?!.*\.\.)[^\\\0]+$/, "repo-relative paths only")).max(10).optional(),
    establishes: z
      .object({
        behavior: z.string().trim().min(1).max(300),
        claimTerms: z.array(z.array(Term).min(1).max(8)).min(1).max(6),
        claimKinds: z.array(z.enum(["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"])).min(1).max(2).optional(),
        scope: z
          .object({
            level: z.enum(["mechanism", "flow"]),
            application: z.string().trim().min(1).max(100),
            mechanism: z.string().trim().regex(/^[A-Za-z_$][\w$]{1,80}$/, "a symbol name"),
            entryPoint: z.string().trim().regex(/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/, 'like "POST /request-otp"').optional(),
            behaviors: z.array(z.object({ id: z.string().trim().regex(/^[a-z0-9-]{2,40}$/), terms: z.array(Term).min(1).max(16) }).strict()).min(1).max(8),
          })
          .strict()
          .refine((sc) => sc.level !== "flow" || !!sc.entryPoint, "a flow-level scope needs an entryPoint")
          .optional(),
      })
      .strict(),
    passMeans: z.literal("behavior_holds"),
  })
  .strict();

const CommandsShape = z.object({
  build: z.string().trim().min(1).optional(),
  test: z.string().trim().min(1).optional(),
  lint: z.string().trim().min(1).optional(),
  typecheck: z.string().trim().min(1).optional(),
  claimChecks: z
    .array(ClaimCheckShape)
    .max(30)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "claim check ids must be unique")
    .optional(),
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

// ---------------------------------------------------------------------------
// Phase 4A — Backlog Intelligence (see /docs/BACKLOG_INTELLIGENCE.md, /docs/API.md "Backlog").
// Every body is `.strict()`: an unexpected key — `status`, `projectId`, `taskId`, `approved`, … — is
// a 400, never silently ignored, so a client cannot even ATTEMPT to set platform-owned state.
// ---------------------------------------------------------------------------

const BacklogExternalRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/, "may contain letters, digits and . _ : / # - only");

export const CreateBacklogItemSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(10_000),
    externalRef: BacklogExternalRefSchema.nullish(),
  })
  .strict();

export const UpdateBacklogItemSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(10_000).optional(),
    externalRef: BacklogExternalRefSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.description !== undefined || v.externalRef !== undefined, {
    message: "Provide at least one of title, description, externalRef",
  });

/** For action endpoints (analyze / reject / approve / convert): no body content is meaningful, and none is accepted. */
export const EmptyActionBodySchema = z.object({}).strict();


// ---------------------------------------------------------------------------
// Phase 4B — bulk backlog. Every body is strict; nothing here can set a status, an approval or a command.
// ---------------------------------------------------------------------------

const CanonicalFieldKeys = ["bugId", "title", "description", "steps", "expected", "actual", "severity", "priority", "module", "platform", "environment", "reporter", "status"] as const;

export const ImportBodySchema = z
  .object({
    csv: z.string().min(1).max(600_000),
    sourceName: z.string().trim().min(1).max(100),
    mapping: z.record(z.enum(CanonicalFieldKeys), z.string().trim().min(1).max(60)).optional(),
  })
  .strict();

export const StartBulkAnalysisSchema = z
  .object({
    importId: z.string().uuid().optional(),
    itemIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => (b.importId ? 1 : 0) + (b.itemIds ? 1 : 0) === 1, "give exactly one of importId or itemIds");

export const ReviewRelationshipSchema = z.object({ decision: z.enum(["confirm", "dismiss"]) }).strict();

export const BulkActionSchema = z
  .object({
    action: z.enum(["generate_proposals", "approve_proposals", "reject_proposals", "convert_proposals", "dismiss_duplicates"]),
    itemIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 4B.1 — human ground-truth adjudication. Bodies never accept an analysisId or revision: the server always binds a
// judgment to whatever is CURRENT for the target at write time, so a client can never forge one onto a different
// analysis/revision than the one actually reviewed.
// ---------------------------------------------------------------------------

export const RelationshipJudgmentSchema = z
  .object({
    label: z.enum(["CONFIRMED_DUPLICATE", "RELATED_NOT_DUPLICATE", "REJECTED"]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export const ItemJudgmentSchema = z
  .object({
    category: z.enum(["CLARIFICATION", "PROPOSAL_READINESS"]),
    label: z.string().trim().min(1).max(40),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const allowed = b.category === "CLARIFICATION" ? ["CORRECT_CLARIFICATION", "SHOULD_BE_PROPOSAL_READY", "INSUFFICIENT_ANALYSIS", "OTHER"] : ["CORRECT_PROPOSAL_READY", "NEEDS_CLARIFICATION", "INSUFFICIENT_ANALYSIS", "OTHER"];
    if (!allowed.includes(b.label)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `label must be one of ${allowed.join(", ")} for ${b.category}` });
  });

export const AdjudicationSampleQuerySchema = z.object({
  seed: z.string().trim().min(1).max(100),
  size: z.coerce.number().int().min(1).max(500),
  /** Phase 4B.4 — scopes the sample to one specific bulk analysis run (its members only), so it can never mix with a different run's items. */
  runId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Phase 4B.2 — human-filled CSV import and baseline snapshots.
// ---------------------------------------------------------------------------

export const AdjudicationImportSchema = z
  .object({
    csv: z.string().min(1).max(400_000),
  })
  .strict();

export const CreateBaselineSchema = z
  .object({
    seed: z.string().trim().min(1).max(100),
    duplicateSize: z.number().int().min(1).max(500),
    clarificationSize: z.number().int().min(1).max(500),
    proposalReadySize: z.number().int().min(1).max(500),
    sourceName: z.string().trim().min(1).max(100).optional(),
    runId: z.string().uuid().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 4C — Chat.
// ---------------------------------------------------------------------------

/** Base64 can be up to ~33% larger than the raw bytes it encodes; ChatService enforces the real byte-size cap on the decoded buffer — this is just a shape/length sanity bound at the API boundary. */
export const SendChatMessageSchema = z
  .object({
    text: z.string().max(4_000).default(""),
    attachment: z
      .object({
        filename: z.string().trim().min(1).max(200),
        mimeType: z.string().trim().min(1).max(100),
        contentBase64: z.string().min(1).max(700_000),
      })
      .strict()
      .optional(),
    /** Phase 4D.7 — reference to a binary attachment uploaded via POST /projects/:projectId/chat/attachments.
     *  When present, ChatService resolves the pending upload by ID instead of decoding inline base64. */
    attachmentId: z.string().uuid().optional(),
  })
  .strict();

export const CreateTasksFromChatSchema = z
  .object({
    itemIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

// ---------------------------------------------------------------------------
// Model Gateway — Settings -> AI / Models
// ---------------------------------------------------------------------------

export const AiProviderIdSchema = z.enum(["google", "anthropic", "openai"]);

export const ConnectAiProviderSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(4000),
    model: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListAiProviderModelsSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(4000),
  })
  .strict();

export const SetGlobalAiConfigSchema = z
  .object({
    mode: z.enum(["auto", "fixed"]),
    fixedProvider: AiProviderIdSchema.optional(),
    fixedModel: z.string().trim().min(1).max(200).optional(),
    autoAllowedProviders: z.array(AiProviderIdSchema).max(3).optional(),
  })
  .strict();
