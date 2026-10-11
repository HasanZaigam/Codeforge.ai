import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext.js";
import { SettingsPage } from "./SettingsPage.js";
import { authApi, githubIntegrationApi, modelGatewayApi } from "../api/index.js";

vi.mock("../api/auth.js", () => ({
  authApi: { me: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
}));

vi.mock("../api/integrations.js", () => ({
  githubIntegrationApi: { getStatus: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), verify: vi.fn() },
}));

vi.mock("../api/model-gateway.js", () => ({
  modelGatewayApi: { listConnections: vi.fn(), getConfig: vi.fn(), getUsage: vi.fn(), connect: vi.fn(), testConnection: vi.fn(), disconnect: vi.fn(), setConfig: vi.fn() },
}));

const mockedAuthApi = vi.mocked(authApi);
const mockedGithubApi = vi.mocked(githubIntegrationApi);
const mockedModelGatewayApi = vi.mocked(modelGatewayApi);

const DISCONNECTED_CONNECTIONS = [
  { provider: "google" as const, connected: false, model: null, status: "disconnected" as const, lastVerifiedAt: null, lastError: null },
  { provider: "anthropic" as const, connected: false, model: null, status: "disconnected" as const, lastVerifiedAt: null, lastError: null },
  { provider: "openai" as const, connected: false, model: null, status: "disconnected" as const, lastVerifiedAt: null, lastError: null },
];
const AUTO_CONFIG_NONE_CONNECTED = {
  mode: "auto" as const,
  fixedProvider: null,
  fixedModel: null,
  autoAllowed: [
    { provider: "google" as const, allowed: false, connected: false },
    { provider: "anthropic" as const, allowed: false, connected: false },
    { provider: "openai" as const, allowed: false, connected: false },
  ],
};

function renderSettings() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuthApi.me.mockResolvedValue({ id: "u1", email: "dev@example.com", name: "Dev User", createdAt: "2026-01-01T00:00:00.000Z" });
    mockedModelGatewayApi.listConnections.mockResolvedValue({ connections: DISCONNECTED_CONNECTIONS });
    mockedModelGatewayApi.getConfig.mockResolvedValue(AUTO_CONFIG_NONE_CONNECTED);
    mockedModelGatewayApi.getUsage.mockResolvedValue({ usage: [] });
  });

  it("AI / Models defaults to Auto and lists every provider as not-yet-connected", async () => {
    mockedGithubApi.getStatus.mockResolvedValue({ connected: false, githubLogin: null, connectedAt: null });
    renderSettings();

    await waitFor(() => expect(screen.getByDisplayValue("Auto — CodeForge decides")).toBeInTheDocument());
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(3);
  });

  it("AI / Models shows a connected provider's real model and offers Test/Manage/Disconnect, never a fabricated status", async () => {
    mockedGithubApi.getStatus.mockResolvedValue({ connected: false, githubLogin: null, connectedAt: null });
    mockedModelGatewayApi.listConnections.mockResolvedValue({
      connections: [
        { provider: "google", connected: true, model: "gemini-2.0-flash", status: "connected", lastVerifiedAt: "2026-01-01T00:00:00.000Z", lastError: null },
        { provider: "anthropic", connected: false, model: null, status: "disconnected", lastVerifiedAt: null, lastError: null },
        { provider: "openai", connected: false, model: null, status: "disconnected", lastVerifiedAt: null, lastError: null },
      ],
    });
    mockedModelGatewayApi.getConfig.mockResolvedValue({
      mode: "auto",
      fixedProvider: null,
      fixedModel: null,
      autoAllowed: [
        { provider: "google", allowed: true, connected: true },
        { provider: "anthropic", allowed: false, connected: false },
        { provider: "openai", allowed: false, connected: false },
      ],
    });
    renderSettings();

    await waitFor(() => expect(screen.getByText(/Model: gemini-2.0-flash/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2);
  });

  it("Integrations shows Jira/Slack/Jenkins/MCP as Coming soon only — no connect buttons or fake status", async () => {
    mockedGithubApi.getStatus.mockResolvedValue({ connected: false, githubLogin: null, connectedAt: null });
    renderSettings();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument());
    for (const name of ["Jira", "Slack", "Jenkins", "MCP"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Coming soon")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /connect jira/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect slack/i })).not.toBeInTheDocument();
  });

  it("when not connected, shows a Connect action and no token-management actions", async () => {
    mockedGithubApi.getStatus.mockResolvedValue({ connected: false, githubLogin: null, connectedAt: null });
    renderSettings();

    await waitFor(() => expect(screen.getByRole("button", { name: "Connect GitHub account" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Add new token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });

  it("when connected, shows the connection status plus both 'Add new token' and 'Disconnect'", async () => {
    mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
    renderSettings();

    await waitFor(() => expect(screen.getByText(/Connected as/)).toBeInTheDocument());
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add new token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect github account/i })).toBeInTheDocument();
  });

  it("'Add new token' opens a replace-flavored dialog and connecting a new token updates the shown login", async () => {
    mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
    mockedGithubApi.connect.mockResolvedValue({ connected: true, githubLogin: "octocat-new", connectedAt: "2026-01-01T00:00:00.000Z" });
    renderSettings();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add new token" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Add new token" }));

    expect(screen.getByRole("heading", { name: "Add a new GitHub token" })).toBeInTheDocument();
    expect(screen.getByText(/replaces the token currently on file/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/personal access token/i), "ghp_newtoken");
    await userEvent.click(screen.getByRole("button", { name: "Save new token" }));

    expect(mockedGithubApi.connect).toHaveBeenCalledWith("ghp_newtoken");
    await waitFor(() => expect(screen.getByText("octocat-new")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a GitHub status load failure shows a useful error with retry, without breaking the Account card", async () => {
    mockedGithubApi.getStatus.mockRejectedValue(new Error("boom"));
    renderSettings();

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(screen.getByText(/Signed in as Dev User/)).toBeInTheDocument();
  });

  describe("Verify connection", () => {
    beforeEach(() => {
      mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
    });

    it("a valid token shows a clear 'Verified' confirmation", async () => {
      mockedGithubApi.verify.mockResolvedValue({ valid: true });
      renderSettings();

      await waitFor(() => expect(screen.getByRole("button", { name: "Verify connection" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));

      expect(mockedGithubApi.verify).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());
      expect(screen.getByText(/still works on GitHub/)).toBeInTheDocument();
    });

    it("a revoked/expired token — still shown as 'Connected' by the cheap status check — is caught by Verify and offers Add new token", async () => {
      mockedGithubApi.verify.mockResolvedValue({ valid: false });
      renderSettings();

      await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));

      await waitFor(() => expect(screen.getByText("This token no longer works on GitHub")).toBeInTheDocument());
      expect(screen.getAllByRole("button", { name: "Add new token" }).length).toBeGreaterThan(0);
    });

    it("a transient verify failure shows a retryable error, not a false invalid-token verdict", async () => {
      mockedGithubApi.verify.mockRejectedValue(new Error("network down"));
      renderSettings();

      await waitFor(() => expect(screen.getByRole("button", { name: "Verify connection" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));

      await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
      expect(screen.queryByText("This token no longer works on GitHub")).not.toBeInTheDocument();

      mockedGithubApi.verify.mockResolvedValue({ valid: true });
      await userEvent.click(screen.getByRole("button", { name: /try again/i }));
      await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());
    });

    it("adding a new token clears a stale verify result", async () => {
      mockedGithubApi.verify.mockResolvedValue({ valid: false });
      mockedGithubApi.connect.mockResolvedValue({ connected: true, githubLogin: "octocat-new", connectedAt: "2026-01-01T00:00:00.000Z" });
      renderSettings();

      await waitFor(() => expect(screen.getByRole("button", { name: "Verify connection" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));
      await waitFor(() => expect(screen.getByText("This token no longer works on GitHub")).toBeInTheDocument());

      await userEvent.click(screen.getAllByRole("button", { name: "Add new token" })[0]!);
      await userEvent.type(screen.getByLabelText(/personal access token/i), "ghp_newtoken");
      await userEvent.click(screen.getByRole("button", { name: "Save new token" }));

      await waitFor(() => expect(screen.getByText("octocat-new")).toBeInTheDocument());
      expect(screen.queryByText("This token no longer works on GitHub")).not.toBeInTheDocument();
    });
  });
});
