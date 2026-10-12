import type { ProjectRepo } from "../domain/types.js";
import { InvalidRepositoryError, RepositoryRequiredError } from "./errors.js";

/**
 * Which repository a work item targets (TD-62): the explicitly named one (must belong to the project),
 * else the project's only repository. A project with none — or with several and no choice made — is a
 * RepositoryRequiredError: the platform asks rather than guessing which codebase to change.
 */
export function resolveRepositoryFor(repos: ProjectRepo[], requestedId: string | null | undefined): ProjectRepo {
  if (requestedId) {
    const match = repos.find((r) => r.id === requestedId);
    if (!match) throw new InvalidRepositoryError("That repository doesn't belong to this project.");
    return match;
  }
  if (repos.length === 1) return repos[0]!;
  throw new RepositoryRequiredError(repos.map((r) => r.name));
}

/**
 * The one repository whose name appears as a whole word in what the user wrote ("fix login in backend",
 * "these are the admin bugs"). Deterministic — no model call. Returns null for a project with fewer than
 * two repositories, or when zero or several names match, so callers fall back to their own rule (the
 * only repository, the primary one, or asking) instead of guessing.
 */
export function repositoryNamedIn(repos: ProjectRepo[], text: string): ProjectRepo | null {
  if (repos.length < 2 || !text) return null;
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = repos.filter((r) => new RegExp(`(^|[^\\w-])${escape(r.name)}($|[^\\w-])`, "i").test(text));
  return matches.length === 1 ? matches[0]! : null;
}
