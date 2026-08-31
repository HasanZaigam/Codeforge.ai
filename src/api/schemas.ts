import { z } from "zod";

/**
 * Request-body validation at the API boundary — the domain remains
 * authoritative for anything state-related (see /docs/API.md "Validation").
 * These schemas only shape *input*; they never accept status, ids the
 * server should assign, or anything else the client shouldn't control.
 */

const CommandsSchema = z
  .object({
    build: z.string().trim().min(1).optional(),
    test: z.string().trim().min(1).optional(),
    lint: z.string().trim().min(1).optional(),
    typecheck: z.string().trim().min(1).optional(),
  })
  .optional();

// GitHub's own rules: owners/orgs are alphanumeric-and-hyphens, max 39 chars, no leading/trailing
// hyphen; repo names are alphanumeric/._- , max 100 chars. Validated here — before either string
// ever reaches a shell command or a URL — so an unexpected character is a 400, not a surprise
// three layers down. See /docs/GITHUB_INTEGRATION.md "Repository connection".
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

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
    repoUrl: z.string().trim().min(1).max(2000),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    codingEngine: z.string().trim().min(1).max(100).optional(),
    commands: CommandsSchema,
  }),
]);

export const ConnectGitHubSchema = z.object({
  token: z.string().trim().min(1).max(4000),
});

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(10_000),
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
