import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.js";
import { githubIntegrationApi, type GitHubConnectionDTO } from "../api/index.js";
import { GitHubConnectDialog } from "../components/settings/GitHubConnectDialog.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { formatAbsolute } from "../lib/time.js";

/** See /docs/AUTHENTICATION.md for the account section and /docs/GITHUB_INTEGRATION.md for the GitHub connection. */
export function SettingsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<GitHubConnectionDTO>();
  const [error, setError] = useState<string>();
  const [dialogMode, setDialogMode] = useState<"connect" | "replace">();
  const [disconnecting, setDisconnecting] = useState(false);

  function load() {
    setError(undefined);
    githubIntegrationApi
      .getStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load your GitHub connection status."));
  }

  useEffect(load, []);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await githubIntegrationApi.disconnect();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect your GitHub account.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="stack" style={{ gap: 20 }}>
        <div className="card card-padded stack" style={{ gap: 4 }}>
          <h3>Account</h3>
          <p className="text-muted">
            Signed in as {user?.name} ({user?.email}).
          </p>
        </div>

        <div className="card card-padded stack" style={{ gap: 8 }}>
          <div className="page-header" style={{ marginBottom: 0 }}>
            <h3>GitHub</h3>
            {status?.connected && <span className="status-badge tone-success">Connected</span>}
          </div>
          {status === undefined && !error && <LoadingState label="Checking your GitHub connection…" />}
          {error && <ErrorState message={error} onRetry={load} />}
          {status && (
            <div className="stack" style={{ gap: 8 }}>
              {status.connected ? (
                <>
                  <p className="text-muted">
                    Connected as <strong>{status.githubLogin}</strong>
                    {status.connectedAt && ` since ${formatAbsolute(status.connectedAt)}`}. The platform can commit, push, and open
                    Pull Requests on GitHub projects using this account.
                  </p>
                  <p className="field-hint">
                    For security, the connected token itself is never shown again once saved — only its status above. To rotate it,
                    add a new one below; it immediately replaces the old one.
                  </p>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <button className="btn btn-secondary" onClick={() => setDialogMode("replace")}>
                      Add new token
                    </button>
                    <button className="btn btn-secondary" onClick={handleDisconnect} disabled={disconnecting}>
                      {disconnecting ? "Disconnecting…" : "Disconnect GitHub account"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-muted">
                    Connect a GitHub account to create projects backed by a real repository. Without this, only local-git projects
                    (used for testing) are available.
                  </p>
                  <div>
                    <button className="btn btn-primary" onClick={() => setDialogMode("connect")}>
                      Connect GitHub account
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {dialogMode && (
        <GitHubConnectDialog
          variant={dialogMode}
          onClose={() => setDialogMode(undefined)}
          onConnected={(newStatus) => {
            setStatus(newStatus);
            setDialogMode(undefined);
          }}
        />
      )}
    </div>
  );
}
