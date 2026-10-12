import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { LoadingState } from "../common/LoadingState.js";
import { GitHubConnectDialog } from "../settings/GitHubConnectDialog.js";
import {
  projectsApi,
  githubIntegrationApi,
  ApiError,
  type ProjectRepoDTO,
  type GitHubConnectionDTO,
  type VerifyGitHubRepositoryResult,
} from "../../api/index.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

type Provider = "github" | "local-git";

/** Zod's `.flatten()` shape — see /docs/API.md "Error format" (`INVALID_REQUEST`'s `details`). */
interface ValidationDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}

/** Human labels for backend field names, used when turning a raw validation error into a readable message. */
const FIELD_LABELS: Record<string, string> = {
  name: "Repository name",
  repoUrl: "Repository URL",
  defaultBranch: "Base branch",
};

/**
 * Turns a raw API error into a message a first-time user can act on,
 * without ever exposing the backend's raw "Request body failed validation"
 * wrapper or its internals. Falls back to the server's own message for
 * anything this doesn't specifically recognize.
 */
function friendlyErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === "INVALID_REQUEST") {
    const fieldErrors = (err.details as ValidationDetails | undefined)?.fieldErrors;
    const firstField = fieldErrors && Object.keys(fieldErrors)[0];
    const firstMessage = firstField && fieldErrors[firstField]?.[0];
    if (firstField && firstMessage) {
      return `${FIELD_LABELS[firstField] ?? firstField}: ${firstMessage}`;
    }
  }
  return err instanceof Error ? err.message : "Could not connect this repository. Please try again.";
}

/**
 * Connects one repository to an existing project — a real GitHub repository or, for local
 * development/testing, a plain local-git repo URL. A project can hold several (frontend, backend,
 * admin …) or exactly one for a monorepo; every task then targets one of them (TD-62).
 *
 * GitHub flow (see /docs/GITHUB_INTEGRATION.md "Repository connection"): the
 * user pastes a full repository URL and clicks "Validate repository" — a
 * real GitHub API check (repository access + branch existence), never just
 * URL-shape validation, and the UI says so explicitly. On success it shows
 * the derived owner/repository/default branch (not editable — they're a
 * fact about the repository, not a choice) plus an editable, auto-suggested
 * repository name (the short label tasks and Chat use) and an editable
 * default-branch field. Editing the URL after a successful validation
 * invalidates it — the previous result no longer describes what's in the
 * field, so "Connect repository" is disabled again until it's re-validated.
 */
export function ConnectRepositoryDialog({
  projectId,
  onClose,
  onConnected,
}: {
  projectId: string;
  onClose: () => void;
  onConnected: (repository: ProjectRepoDTO) => void;
}) {
  const [provider, setProvider] = useState<Provider>("github");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const [verified, setVerified] = useState<VerifyGitHubRepositoryResult>();
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string>();

  const [githubStatus, setGithubStatus] = useState<GitHubConnectionDTO>();
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    githubIntegrationApi.getStatus().then(setGithubStatus).catch(() => setGithubStatus({ connected: false, githubLogin: null, connectedAt: null }));
  }, []);

  function handleGithubUrlChange(value: string) {
    setGithubUrl(value);
    // Editing the URL invalidates any prior validation — the derived owner/repo/branch no longer
    // describe what's actually in the field, so the user must re-validate before submitting.
    if (verified) setVerified(undefined);
    setVerifyError(undefined);
  }

  async function handleValidate() {
    setVerifying(true);
    setVerifyError(undefined);
    try {
      const result = await projectsApi.verifyGitHubRepo(githubUrl.trim());
      setVerified(result);
      setDefaultBranch(result.defaultBranch);
      // Auto-suggested, never forced: only fills the name if the user hasn't already typed one.
      if (!nameEdited) setName(result.suggestedName);
    } catch (err) {
      setVerifyError(friendlyErrorMessage(err));
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const repository = await projectsApi.addRepository(
        projectId,
        provider === "github"
          ? {
              sourceControlProvider: "github",
              name: name.trim(),
              owner: verified!.owner,
              repo: verified!.repo,
              defaultBranch: defaultBranch.trim() || undefined,
            }
          : { sourceControlProvider: "local-git", name: name.trim(), repoUrl: repoUrl.trim() },
      );
      onConnected(repository);
    } catch (err) {
      setError(friendlyErrorMessage(err));
      setSubmitting(false);
    }
  }

  const canValidate = provider === "github" && !!githubUrl.trim() && !verifying;
  const canSubmit =
    provider === "github" ? !!(verified && name.trim()) : !!(name.trim() && repoUrl.trim());

  const dialogDescription =
    provider === "github"
      ? "Connect a GitHub repository of this project so AI agents can work on tasks in it."
      : "Point at a plain local/self-hosted git repository for evaluation or testing — no GitHub account, no Pull Request.";

  return (
    <Dialog title="Connect a repository" description={dialogDescription} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="project-provider">Source control</Label>
          <NativeSelect className="w-full" id="project-provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="github">GitHub repository</option>
            <option value="local-git">Local / plain-git testing (no PR)</option>
          </NativeSelect>
        </div>

        {provider === "github" ? (
          <>
            {githubStatus === undefined && <LoadingState label="Checking your GitHub connection…" />}
            {githubStatus && !githubStatus.connected && (
              <div className="mb-4 flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Connect a GitHub account before connecting a GitHub repository — the platform needs it to verify the
                  repository and later commit/push/open a Pull Request.
                </p>
                <Button variant="outline" type="button" onClick={() => setShowConnect(true)}>
                  Connect GitHub account
                </Button>
              </div>
            )}
            {githubStatus?.connected && (
              <>
                <div className="mb-4 flex flex-col gap-2">
                  <Label htmlFor="project-github-url">
                    GitHub repository URL <span className="text-destructive">*</span>
                  </Label>
                  <p className="text-sm text-muted-foreground">Paste the repository's GitHub URL — https:// or git@ form both work.</p>
                  <Input
                    id="project-github-url"
                    value={githubUrl}
                    onChange={(e) => handleGithubUrlChange(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    required
                    maxLength={2000}
                  />
                  <div>
                    <Button variant="outline" type="button" onClick={handleValidate} disabled={!canValidate}>
                      {verifying ? "Validating…" : "Validate repository"}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Validating checks that the URL is a well-formed GitHub repository AND confirms — with a real GitHub API
                    call using your connected account — that the repository exists, is accessible, and its base branch
                    exists. Nothing is connected until you click "Connect repository".
                  </p>
                </div>

                {verifying && <LoadingState label="Checking repository access on GitHub…" />}
                {verifyError && <ErrorState message={verifyError} />}

                {verified && (
                  <>
                    <div className="info-callout mb-4 rounded-2xl bg-tone-info/10 px-4 py-3 text-sm text-tone-info">
                      <div className="mb-1 font-semibold">Repository verified</div>
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-foreground">
                        <dt className="text-muted-foreground">Owner / organization</dt>
                        <dd>{verified.owner}</dd>
                        <dt className="text-muted-foreground">Repository</dt>
                        <dd>{verified.repo}</dd>
                        <dt className="text-muted-foreground">Default branch</dt>
                        <dd>{verified.defaultBranch}</dd>
                      </dl>
                    </div>

                    <div className="mb-4 flex flex-col gap-2">
                      <Label htmlFor="project-name">
                        Repository name <span className="text-destructive">*</span>
                      </Label>
                      <p className="text-sm text-muted-foreground">A short label for this repository inside the project — e.g. "frontend", "backend" or "admin". Tasks and Chat refer to it by this name.</p>
                      <Input
                        id="project-name"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setNameEdited(true);
                        }}
                        required
                        maxLength={60}
                      />
                    </div>
                    <div className="mb-4 flex flex-col gap-2">
                      <Label htmlFor="project-branch">Default branch</Label>
                      <p className="text-sm text-muted-foreground">The branch AI agents start from in this repository. Defaults to the repository's own default branch — change it if you want a different one.</p>
                      <Input id="project-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} maxLength={200} />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="info-callout mb-4 rounded-2xl bg-tone-info/10 px-4 py-3 text-sm text-tone-info">
              <div className="mb-1 font-semibold">How it works</div>
              <p>
                No GitHub account is needed, and no Pull Request is ever created. Work is committed and pushed to
                this repository using plain git — the task never receives a GitHub merge signal, so it stays in
                "Review" once the agent finishes. This mode is for evaluation and testing, not the normal
                production workflow.
              </p>
            </div>
            <div className="mb-4 flex flex-col gap-2">
              <Label htmlFor="project-name">
                Repository name <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground">A short label for this repository inside the project — e.g. "frontend" or "backend".</p>
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="backend" required maxLength={60} />
            </div>
            <div className="mb-4 flex flex-col gap-2">
              <Label htmlFor="project-repo-url">
                Repository URL <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground">A local filesystem path or a plain git remote URL — not a GitHub repository.</p>
              <Input
                id="project-repo-url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="/path/to/local/repo or a git URL"
                required
                maxLength={2000}
              />
            </div>
          </>
        )}

        {error && <ErrorState message={error} />}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !canSubmit || (provider === "github" && !githubStatus?.connected)}>
            {submitting ? "Connecting…" : "Connect repository"}
          </Button>
        </div>
      </form>

      {showConnect && (
        <GitHubConnectDialog
          onClose={() => setShowConnect(false)}
          onConnected={(status) => {
            setGithubStatus(status);
            setShowConnect(false);
          }}
        />
      )}
    </Dialog>
  );
}
