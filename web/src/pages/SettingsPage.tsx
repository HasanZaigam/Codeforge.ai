import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.js";
import { githubIntegrationApi, type GitHubConnectionDTO } from "../api/index.js";
import { GitHubConnectDialog } from "../components/settings/GitHubConnectDialog.js";
import { AiModelsCard } from "../components/settings/AiModelsCard.js";
import { TokenUsageCard } from "../components/settings/TokenUsageCard.js";
import { LoadingState } from "../components/common/LoadingState.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { formatAbsolute } from "../lib/time.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { Section } from "../components/common/Section.js";
import { ToneBadge } from "../components/common/ToneBadge.js";
import { GitPullRequestIcon, KeyRoundIcon, PlugIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" subtitle="Your account, connected services, and the AI that powers CodeForge." />

      <div className="flex flex-col gap-5">
        <Section title={<span className="flex items-center gap-2"><UserRoundIcon className="size-4 text-muted-foreground" aria-hidden="true" />Account</span>}>
          <p className="text-sm text-muted-foreground">
            Signed in as {user?.name} ({user?.email}).
          </p>
        </Section>

        <Section
          title={<span className="flex items-center gap-2"><GitPullRequestIcon className="size-4 text-muted-foreground" aria-hidden="true" />GitHub</span>}
          actions={status?.connected && <ToneBadge tone="success">Connected</ToneBadge>}
        >
          {status === undefined && !error && <LoadingState label="Checking your GitHub connection…" />}
          {error && <ErrorState message={error} onRetry={load} />}
          {status && (
            <div className="flex flex-col gap-3 text-sm">
              {status.connected ? (
                <>
                  <p className="text-muted-foreground">
                    Connected as <strong className="text-foreground">{status.githubLogin}</strong>
                    {status.connectedAt && ` since ${formatAbsolute(status.connectedAt)}`}. The platform can commit, push, and open
                    Pull Requests on GitHub projects using this account.
                  </p>
                  <p className="text-muted-foreground">
                    For security, the connected token itself is never shown again once saved — only its status above. To rotate it,
                    add a new one below; it immediately replaces the old one.
                  </p>
                  <p className="text-muted-foreground">
                    "Connected" above only means this platform has a stored token — it can't tell on its own if GitHub has since
                    revoked or expired it. Use "Verify connection" to check for real, right now.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="outline" type="button" onClick={handleVerify} disabled={verifying}>
                      <ShieldCheckIcon data-icon="inline-start" />
                      {verifying ? "Verifying…" : "Verify connection"}
                    </Button>
                    <Button variant="outline" type="button" onClick={() => setDialogMode("replace")}>
                      <KeyRoundIcon data-icon="inline-start" />
                      Add new token
                    </Button>
                    <Button variant="destructive" type="button" onClick={handleDisconnect} disabled={disconnecting}>
                      {disconnecting ? "Disconnecting…" : "Disconnect GitHub account"}
                    </Button>
                  </div>
                  {verifyResult === "valid" && (
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <ToneBadge tone="success">Verified</ToneBadge> This token still works on GitHub.
                    </p>
                  )}
                  {verifyResult === "invalid" && (
                    <div
                      className="flex flex-col gap-3 rounded-2xl border border-tone-attention/30 bg-tone-attention/10 p-4 sm:flex-row sm:items-center"
                      role="alert"
                    >
                      <div className="flex-1">
                        <strong className="text-tone-attention">This token no longer works on GitHub</strong>
                        <p className="text-muted-foreground">It was likely revoked or has expired. Add a new token to keep using this connection.</p>
                      </div>
                      <Button variant="outline" type="button" onClick={() => setDialogMode("replace")}>
                        Add new token
                      </Button>
                    </div>
                  )}
                  {verifyError && <ErrorState message={verifyError} onRetry={handleVerify} />}
                </>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Connect a GitHub account to create projects backed by a real repository. Without this, only local-git projects
                    (used for testing) are available.
                  </p>
                  <div>
                    <Button type="button" onClick={() => setDialogMode("connect")}>
                      <GitPullRequestIcon data-icon="inline-start" />
                      Connect GitHub account
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </Section>

        <AiModelsCard />

        <TokenUsageCard />

        <Section
          title={<span className="flex items-center gap-2"><PlugIcon className="size-4 text-muted-foreground" aria-hidden="true" />Integrations</span>}
          description="Future ways to bring work into CodeForge. None of these are required for Chat or Tasks."
        >
          <ul className="divide-y rounded-2xl border">
            {FUTURE_INTEGRATIONS.map((i) => (
              <li key={i.name} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <strong className="text-sm font-medium">{i.name}</strong>
                  <p className="text-sm text-muted-foreground">{i.description}</p>
                </div>
                <ToneBadge tone="neutral">Coming soon</ToneBadge>
              </li>
            ))}
          </ul>
        </Section>
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
