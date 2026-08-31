import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { LoadingState } from "../common/LoadingState.js";
import { GitHubConnectDialog } from "../settings/GitHubConnectDialog.js";
import { projectsApi, githubIntegrationApi, type ProjectDTO, type GitHubConnectionDTO } from "../../api/index.js";

type Provider = "github" | "local-git";

/**
 * Connects a project either to a real GitHub repository (validated against
 * the GitHub API before creation — see /docs/GITHUB_INTEGRATION.md
 * "Repository connection") or, for local development/testing, a plain
 * local-git repo URL exactly as before Step 7.
 */
export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: ProjectDTO) => void }) {
  const [provider, setProvider] = useState<Provider>("github");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const [githubStatus, setGithubStatus] = useState<GitHubConnectionDTO>();
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    githubIntegrationApi.getStatus().then(setGithubStatus).catch(() => setGithubStatus({ connected: false, githubLogin: null, connectedAt: null }));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const project = await projectsApi.create(
        provider === "github"
          ? { sourceControlProvider: "github", name: name.trim(), owner: owner.trim(), repo: repo.trim(), defaultBranch: defaultBranch.trim() || undefined }
          : { sourceControlProvider: "local-git", name: name.trim(), repoUrl: repoUrl.trim() },
      );
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect this project. Please try again.");
      setSubmitting(false);
    }
  }

  const canSubmit = provider === "github" ? !!(name.trim() && owner.trim() && repo.trim()) : !!(name.trim() && repoUrl.trim());

  return (
    <Dialog title="Connect a project" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="project-provider">Source control</label>
          <select id="project-provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="github">GitHub repository</option>
            <option value="local-git">Local git (dev/testing)</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="project-name">Project name</label>
          <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OTT" required maxLength={200} />
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
                  <label htmlFor="project-owner">Owner / organization</label>
                  <input id="project-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="acme" required maxLength={39} />
                </div>
                <div className="field">
                  <label htmlFor="project-repo">Repository</label>
                  <input id="project-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="widgets" required maxLength={100} />
                </div>
                <div className="field">
                  <label htmlFor="project-branch">Base branch (optional)</label>
                  <input
                    id="project-branch"
                    value={defaultBranch}
                    onChange={(e) => setDefaultBranch(e.target.value)}
                    placeholder="defaults to the repository's default branch"
                    maxLength={200}
                  />
                </div>
              </>
            )}
          </>
        ) : (
          <div className="field">
            <label htmlFor="project-repo-url">Repository URL</label>
            <input
              id="project-repo-url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="/path/to/local/repo or a git URL"
              required
              maxLength={2000}
            />
          </div>
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
