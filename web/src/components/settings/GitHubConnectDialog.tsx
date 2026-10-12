import { useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { githubIntegrationApi, type GitHubConnectionDTO } from "../../api/index.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Deliberately simple: a personal access token pasted into a form, verified
 * against the real GitHub API before it's stored — no OAuth app flow, no
 * popup/redirect dance. See /docs/GITHUB_INTEGRATION.md "Platform auth vs.
 * GitHub authorization" for why a PAT is an explicit, documented dev-only
 * boundary rather than a production-grade GitHub App integration.
 */
export function GitHubConnectDialog({
  onClose,
  onConnected,
  variant = "connect",
}: {
  onClose: () => void;
  onConnected: (status: GitHubConnectionDTO) => void;
  /** "replace" reuses the exact same POST /integrations/github (it's already an upsert — see
   *  GitHubIntegrationService.connect) for a user who is already connected and wants to swap in a
   *  new/rotated token — only the copy changes, never the request. */
  variant?: "connect" | "replace";
}) {
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

  const isReplace = variant === "replace";

  return (
    <Dialog
      title={isReplace ? "Add a new GitHub token" : "Connect your GitHub account"}
      description={isReplace ? "This replaces the token currently on file — the old one stops working here immediately." : undefined}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="github-token">Personal access token</Label>
          <Input
            id="github-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_…"
            required
            maxLength={4000}
            autoComplete="off"
          />
          <p className="text-sm text-muted-foreground">
            Needs <code>repo</code> scope so the platform can commit, push, and open Pull Requests on your behalf. The token is
            encrypted at rest and never shown again, sent to the AI developer, or logged — this platform cannot show you back a
            token you already connected, only replace it with a new one.
          </p>
        </div>
        {error && <ErrorState message={error} />}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !token.trim()}>
            {submitting ? "Connecting…" : isReplace ? "Save new token" : "Connect account"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
