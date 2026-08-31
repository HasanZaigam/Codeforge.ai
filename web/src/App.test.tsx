import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App.js";
import { AuthProvider } from "./auth/AuthContext.js";
import { authApi, projectsApi } from "./api/index.js";
import { ApiError } from "./api/errors.js";
import { emitUnauthenticated } from "./auth/auth-events.js";
import { makeProject } from "./test/fixtures.js";

vi.mock("./api/auth.js", () => ({
  authApi: { me: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
}));

vi.mock("./api/projects.js", () => ({
  projectsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
  },
}));

const mockedAuthApi = vi.mocked(authApi);
const mockedProjectsApi = vi.mocked(projectsApi);

function renderFullApp(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("App (session bootstrap, login, logout)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedProjectsApi.list.mockResolvedValue([]);
  });

  it("shows a loading state before the session bootstrap resolves, never the dashboard or login prematurely", async () => {
    let rejectMe!: (err: unknown) => void;
    mockedAuthApi.me.mockReturnValue(new Promise((_resolve, reject) => (rejectMe = reject)));

    renderFullApp("/");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();

    rejectMe(new ApiError(401, "UNAUTHENTICATED", "Sign in required"));
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it("redirects to the login screen when there is no valid session", async () => {
    mockedAuthApi.me.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Sign in required"));

    renderFullApp("/");
    await waitFor(() => expect(screen.getByRole("heading", { name: "AI Developer" })).toBeInTheDocument());
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("a successful login shows the authenticated app shell (projects, nav, user indicator)", async () => {
    mockedAuthApi.me.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Sign in required"));
    mockedAuthApi.login.mockResolvedValue({ id: "u1", email: "dev@example.com", name: "Dev User", createdAt: "2026-01-01T00:00:00.000Z" });

    renderFullApp("/");
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/email/i), "dev@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Dev User")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(mockedAuthApi.login).toHaveBeenCalledWith({ email: "dev@example.com", password: "correct horse battery staple" });
  });

  it("a failed login shows an error and stays on the login screen", async () => {
    mockedAuthApi.me.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Sign in required"));
    mockedAuthApi.login.mockRejectedValue(new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password"));

    renderFullApp("/");
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/email/i), "dev@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Invalid email or password")).toBeInTheDocument());
    // Still on the login screen — no dashboard leaked through.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it("logout clears the session and returns to the login screen", async () => {
    mockedAuthApi.me.mockResolvedValue({ id: "u1", email: "dev@example.com", name: "Dev User", createdAt: "2026-01-01T00:00:00.000Z" });
    mockedAuthApi.logout.mockResolvedValue(undefined);

    renderFullApp("/");
    await waitFor(() => expect(screen.getByText("Dev User")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    expect(mockedAuthApi.logout).toHaveBeenCalled();
  });

  it("an authenticated session bootstraps straight into the app shell without showing login", async () => {
    mockedAuthApi.me.mockResolvedValue({ id: "u1", email: "dev@example.com", name: "Dev User", createdAt: "2026-01-01T00:00:00.000Z" });

    renderFullApp("/");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument());
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it("a session that expires mid-use (any API call returning 401) redirects to login", async () => {
    mockedAuthApi.me.mockResolvedValue({ id: "u1", email: "dev@example.com", name: "Dev User", createdAt: "2026-01-01T00:00:00.000Z" });
    mockedProjectsApi.list.mockResolvedValue([makeProject()]);

    renderFullApp("/");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument());

    // Simulate what apiClient does internally when any protected request comes back 401.
    emitUnauthenticated();

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
  });
});
