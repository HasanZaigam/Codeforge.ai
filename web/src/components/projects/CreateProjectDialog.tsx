import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { LoadingState } from "../common/LoadingState.js";
import { GitHubConnectDialog } from "../settings/GitHubConnectDialog.js";
import {
  projectsApi,
  githubIntegrationApi,
  ApiError,
  type ProjectDTO,
  type GitHubConnectionDTO,
  type VerifyGitHubRepositoryResult,
} from "../../api/index.js";

type Provider = "github" | "local-git";

/** Zod's `.flatten()` shape — see /docs/API.md "Error format" (`INVALID_REQUEST`'s `details`). */
interface ValidationDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}

/** Human labels for backend field names, used when turning a raw validation error into a readable message. */
const FIELD_LABELS: Record<string, string> = {
  name: "Project name",
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
  return err instanceof Error ? err.message : "Could not connect this project. Please try again.";
}

/**
 * Connects a project either to a real GitHub repository or, for local
 * development/testing, a plain local-git repo URL.
 *
 * GitHub flow (see /docs/GITHUB_INTEGRATION.md "Repository connection"): the
 * user pastes a full repository URL and clicks "Validate repository" — a
 * real GitHub API check (repository access + branch existence), never just
 * URL-shape validation, and the UI says so explicitly. On success it shows
 * the derived owner/repository/default branch (not editable — they're a
 * fact about the repository, not a choice) plus an editable, auto-suggested
 * project name and an editable base-branch selector. Editing the URL after a
 * successful validation invalidates it — the previous result no longer
 * describes what's in the field, so "Connect project" is disabled again
 * until it's re-validated.
 */
export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: ProjectDTO) => void }) {
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
      const project = await projectsApi.create(
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
      onCreated(project);
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
      ? "Connect an existing GitHub repository so AI agents can work on tasks in it."
      : "Point at a plain local/self-hosted git repository for evaluation or testing — no GitHub account, no Pull Request.";

  return (
    <Dialog title="Connect a project" description={dialogDescription} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="project-provider">Source control</label>
          <select id="project-provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="github">GitHub repository</option>
            <option value="local-git">Local / plain-git testing (no PR)</option>
          </select>
        </div>

        {provider === "github" ? (
          <>
            {githubStatus === undefined && <LoadingState label="Checking your GitHub connection…" />}
            {githubStatus && !githubStatus.connected && (
              <div className="field">
                <p className="field-hint">
                  Connect a GitHub account before creating a GitHub-backed project — the platform needs it to verify the
                  repository and later commit/push/open a Pull Request.
                </p>
                <button type="button" className="btn btn-secondary" onClick={() => setShowConnect(true)}>
                  Connect GitHub account
                </button>
              </div>
            )}
            {githubStatus?.connected && (
              <>
                <div className="field">
                  <label htmlFor="project-github-url">
                    GitHub repository URL <span className="field-required">*</span>
                  </label>
                  <p className="field-hint">Paste the repository's GitHub URL — https:// or git@ form both work.</p>
                  <input
                    id="project-github-url"
                    value={githubUrl}
                    onChange={(e) => handleGithubUrlChange(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    required
                    maxLength={2000}
                  />
                  <div className="dialog-actions" style={{ justifyContent: "flex-start", padding: 0, border: "none", marginTop: 8 }}>
                    <button type="button" className="btn btn-secondary" onClick={handleValidate} disabled={!canValidate}>
                      {verifying ? "Validating…" : "Validate repository"}
                    </button>
                  </div>
                  <p className="field-hint">
                    Validating checks that the URL is a well-formed GitHub repository AND confirms — with a real GitHub API
                    call using your connected account — that the repository exists, is accessible, and its base branch
                    exists. Nothing is created until you click "Connect project".
                  </p>
                </div>

                {verifying && <LoadingState label="Checking repository access on GitHub…" />}
                {verifyError && <ErrorState message={verifyError} />}

                {verified && (
                  <>
                    <div className="info-callout">
                      <div className="info-callout-title">Repository verified</div>
                      <dl>
                        <dt>Owner / organization</dt>
                        <dd>{verified.owner}</dd>
                        <dt>Repository</dt>
                        <dd>{verified.repo}</dd>
                        <dt>Default branch</dt>
                        <dd>{verified.defaultBranch}</dd>
                      </dl>
                    </div>

                    <div className="field">
                      <label htmlFor="project-name">
                        Project name <span className="field-required">*</span>
                      </label>
                      <p className="field-hint">A friendly name for this project inside AI Task Manager — it doesn't need to match the GitHub repository name.</p>
                      <input
                        id="project-name"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setNameEdited(true);
                        }}
                        required
                        maxLength={200}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="project-branch">Base branch</label>
                      <p className="field-hint">The branch AI agents start from. Defaults to the repository's own default branch — change it if you want a different one.</p>
                      <input id="project-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} maxLength={200} />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="info-callout">
              <div className="info-callout-title">How it works</div>
              <p style={{ margin: 0 }}>
                No GitHub account is needed, and no Pull Request is ever created. Work is committed and pushed to
                this repository using plain git — the task never receives a GitHub merge signal, so it stays in
                "Review" once the agent finishes. This mode is for evaluation and testing, not the normal
                production workflow.
              </p>
            </div>
            <div className="field">
              <label htmlFor="project-name">
                Project name <span className="field-required">*</span>
              </label>
              <p className="field-hint">A friendly name for this project inside AI Task Manager.</p>
              <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Testing Repo" required maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="project-repo-url">
                Repository URL <span className="field-required">*</span>
              </label>
              <p className="field-hint">A local filesystem path or a plain git remote URL — not a GitHub repository.</p>
              <input
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
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit || (provider === "github" && !githubStatus?.connected)}>
            {submitting ? "Connecting…" : "Connect project"}
          </button>
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
