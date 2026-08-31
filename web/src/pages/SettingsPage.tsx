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
  const [showConnect, setShowConnect] = useState(false);
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
      <div className="card card-padded stack">
        <div>
          <h3 style={{ marginBottom: 4 }}>Account</h3>
          <p className="text-muted">
            Signed in as {user?.name} ({user?.email}). This is a single-tenant MVP — there's no team/org management yet, and no
            self-service password reset (see <code>docs/AUTHENTICATION.md</code> "Known limitations").
          </p>
        </div>
        <div>
          <h3 style={{ marginBottom: 4 }}>GitHub</h3>
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
                  <div>
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
                    <button className="btn btn-primary" onClick={() => setShowConnect(true)}>
                      Connect GitHub account
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {showConnect && (
        <GitHubConnectDialog
          onClose={() => setShowConnect(false)}
          onConnected={(newStatus) => {
            setStatus(newStatus);
            setShowConnect(false);
          }}
        />
      )}
    </div>
  );
}
