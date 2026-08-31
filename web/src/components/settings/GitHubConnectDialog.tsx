import { useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { githubIntegrationApi, type GitHubConnectionDTO } from "../../api/index.js";

/**
 * Deliberately simple: a personal access token pasted into a form, verified
 * against the real GitHub API before it's stored — no OAuth app flow, no
 * popup/redirect dance. See /docs/GITHUB_INTEGRATION.md "Platform auth vs.
 * GitHub authorization" for why a PAT is an explicit, documented dev-only
 * boundary rather than a production-grade GitHub App integration.
 */
export function GitHubConnectDialog({ onClose, onConnected }: { onClose: () => void; onConnected: (status: GitHubConnectionDTO) => void }) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const status = await githubIntegrationApi.connect(token.trim());
      onConnected(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect this token. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Connect your GitHub account" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="github-token">Personal access token</label>
          <input
            id="github-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_…"
            required
            maxLength={4000}
            autoComplete="off"
          />
          <p className="field-hint">
            Needs <code>repo</code> scope so the platform can commit, push, and open Pull Requests on your behalf. The token is
            encrypted at rest and never shown again, sent to the AI developer, or logged.
          </p>
        </div>
        {error && <ErrorState message={error} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !token.trim()}>
            {submitting ? "Connecting…" : "Connect account"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
