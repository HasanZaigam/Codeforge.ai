import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.js";
import { githubIntegrationApi, type GitHubConnectionDTO } from "../api/index.js";
import { GitHubConnectDialog } from "../components/settings/GitHubConnectDialog.js";
import { AiModelsCard } from "../components/settings/AiModelsCard.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { formatAbsolute } from "../lib/time.js";

const FUTURE_INTEGRATIONS = [
  { name: "Jira", description: "Connect project work from Jira." },
  { name: "Slack", description: "Receive engineering requests from Slack." },
  { name: "Jenkins", description: "Connect CI/CD workflows." },
  { name: "MCP", description: "Connect external tools and context servers." },
];

/** See /docs/AUTHENTICATION.md for the account section and /docs/GITHUB_INTEGRATION.md for the GitHub connection. */
export function SettingsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<GitHubConnectionDTO>();
  const [error, setError] = useState<string>();
  const [dialogMode, setDialogMode] = useState<"connect" | "replace">();
  const [disconnecting, setDisconnecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<"valid" | "invalid">();
  const [verifyError, setVerifyError] = useState<string>();

  function load() {
    setError(undefined);
    setVerifyResult(undefined);
    setVerifyError(undefined);
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

  /**
   * `status.connected` alone only means "this platform has a stored credential" — it's a cheap
   * local read (see GitHubIntegrationService.getStatus) that can never notice a token revoked or
   * expired entirely on GitHub's own side. This is the only thing that makes a real GitHub API
   * call to actually confirm the stored token still works, on demand rather than on every page
   * load (see githubIntegrationApi.verify).
   */
  async function handleVerify() {
    setVerifying(true);
    setVerifyError(undefined);
    setVerifyResult(undefined);
    try {
      const { valid } = await githubIntegrationApi.verify();
      setVerifyResult(valid ? "valid" : "invalid");
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Couldn't verify the connection right now. Please try again.");
    } finally {
      setVerifying(false);
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
                  <p className="field-hint">
                    "Connected" above only means this platform has a stored token — it can't tell on its own if GitHub has since
                    revoked or expired it. Use "Verify connection" to check for real, right now.
                  </p>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <button className="btn btn-secondary" onClick={handleVerify} disabled={verifying}>
                      {verifying ? "Verifying…" : "Verify connection"}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setDialogMode("replace")}>
                      Add new token
                    </button>
                    <button className="btn btn-secondary" onClick={handleDisconnect} disabled={disconnecting}>
                      {disconnecting ? "Disconnecting…" : "Disconnect GitHub account"}
                    </button>
                  </div>
                  {verifyResult === "valid" && (
                    <p className="text-muted">
                      <span className="status-badge tone-success">Verified</span> This token still works on GitHub.
                    </p>
                  )}
                  {verifyResult === "invalid" && (
                    <div className="field-warning" role="alert">
                      <div>
                        <strong>This token no longer works on GitHub</strong>
                        <p>It was likely revoked or has expired. Add a new token to keep using this connection.</p>
                      </div>
                      <button type="button" className="btn btn-secondary" onClick={() => setDialogMode("replace")}>
                        Add new token
                      </button>
                    </div>
                  )}
                  {verifyError && <ErrorState message={verifyError} onRetry={handleVerify} />}
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

        <AiModelsCard />

        <div className="card card-padded stack" style={{ gap: 8 }}>
          <h3>Integrations</h3>
          <p className="field-hint">Future ways to bring work into CodeForge. None of these are required for Chat or Tasks.</p>
          <div className="stack" style={{ gap: 8 }}>
            {FUTURE_INTEGRATIONS.map((i) => (
              <div key={i.name} className="page-header" style={{ marginBottom: 0 }}>
                <div>
                  <strong>{i.name}</strong>
                  <p className="field-hint" style={{ margin: 0 }}>
                    {i.description}
                  </p>
                </div>
                <span className="status-badge tone-neutral">Coming soon</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {dialogMode && (
        <GitHubConnectDialog
          variant={dialogMode}
          onClose={() => setDialogMode(undefined)}
          onConnected={(newStatus) => {
            setStatus(newStatus);
            setDialogMode(undefined);
            // A new token just replaced the old one — any earlier verify result no longer describes it.
            setVerifyResult(undefined);
            setVerifyError(undefined);
          }}
        />
      )}
    </div>
  );
}
