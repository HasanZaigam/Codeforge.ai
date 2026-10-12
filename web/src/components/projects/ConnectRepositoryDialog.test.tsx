import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { projectsApi, githubIntegrationApi, ApiError } from "../../api/index.js";
import { makeProject } from "../../test/fixtures.js";

vi.mock("../../api/projects.js", () => ({
  projectsApi: { create: vi.fn(), list: vi.fn(), get: vi.fn(), listTasks: vi.fn(), createTask: vi.fn(), verifyGitHubRepo: vi.fn(), listBranches: vi.fn() },
}));
vi.mock("../../api/integrations.js", () => ({
  githubIntegrationApi: { getStatus: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));

const mockedProjectsApi = vi.mocked(projectsApi);
const mockedGithubApi = vi.mocked(githubIntegrationApi);

const VERIFIED = { repoUrl: "https://github.com/HasanZaigam/testing-repo-.git", owner: "HasanZaigam", repo: "testing-repo-", defaultBranch: "main", suggestedName: "testing-repo-" };

async function renderConnected() {
  mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const view = render(<CreateProjectDialog onClose={onClose} onCreated={onCreated} />);
  await waitFor(() => expect(screen.getByLabelText(/GitHub repository URL/)).toBeInTheDocument());
  return { onCreated, onClose, container: view.container };
}

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("the GitHub flow explains what pasting a URL and validating actually checks", async () => {
    await renderConnected();
    expect(screen.getByText(/Paste the repository's GitHub URL/i)).toBeInTheDocument();
    expect(screen.getByText(/confirms — with a real GitHub API call/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is created until you click "Connect project"/i)).toBeInTheDocument();
  });

  test("Connect project is disabled until a repository URL has been successfully validated", async () => {
    await renderConnected();
    const submit = screen.getByRole("button", { name: /Connect project/i });
    expect(submit).toBeDisabled();

    const validate = screen.getByRole("button", { name: /Validate repository/i });
    expect(validate).toBeDisabled(); // no URL typed yet
  });

  test("validating a repository URL shows a loading state, then the derived owner/repo/default branch and an editable, auto-suggested project name", async () => {
    const user = userEvent.setup();
    // Held open by a promise this test resolves (a real 10 ms timer could expire before the loading assertion under load).
    let resolveVerify!: (v: typeof VERIFIED) => void;
    mockedProjectsApi.verifyGitHubRepo.mockImplementation(() => new Promise((resolve) => (resolveVerify = resolve)));
    await renderConnected();

    await user.type(screen.getByLabelText(/GitHub repository URL/), "https://github.com/HasanZaigam/testing-repo-.git");
    await user.click(screen.getByRole("button", { name: /Validate repository/i }));

    expect(screen.getByText(/Checking repository access on GitHub/i)).toBeInTheDocument();

    resolveVerify(VERIFIED);
    await waitFor(() => expect(screen.getByText("Repository verified")).toBeInTheDocument());
    expect(screen.getByText("HasanZaigam")).toBeInTheDocument();
    expect(screen.getByText("testing-repo-")).toBeInTheDocument();

    const nameInput = screen.getByLabelText("Project name *") as HTMLInputElement;
    expect(nameInput.value).toBe("testing-repo-"); // auto-suggested…
    await user.clear(nameInput);
    await user.type(nameInput, "My Own Name");
    expect(nameInput).toHaveValue("My Own Name"); // …but never forced/locked

    const branchInput = screen.getByLabelText("Base branch") as HTMLInputElement;
    expect(branchInput.value).toBe("main");

    expect(mockedProjectsApi.verifyGitHubRepo).toHaveBeenCalledWith("https://github.com/HasanZaigam/testing-repo-.git");
  });

  test("a failed validation (e.g. inaccessible repository) shows a clear error and never enables Connect project", async () => {
    const user = userEvent.setup();
    mockedProjectsApi.verifyGitHubRepo.mockRejectedValue(new ApiError(400, "INVALID_REPOSITORY", "Repository acme/does-not-exist does not exist"));
    await renderConnected();

    await user.type(screen.getByLabelText(/GitHub repository URL/), "https://github.com/acme/does-not-exist");
    await user.click(screen.getByRole("button", { name: /Validate repository/i }));

    await waitFor(() => expect(screen.getByText("Repository acme/does-not-exist does not exist")).toBeInTheDocument());
    expect(screen.queryByText("Repository verified")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect project/i })).toBeDisabled();
  });

  test("editing the URL after a successful validation invalidates it — Connect project is disabled again until re-validated", async () => {
    const user = userEvent.setup();
    mockedProjectsApi.verifyGitHubRepo.mockResolvedValue(VERIFIED);
    await renderConnected();

    const urlInput = screen.getByLabelText(/GitHub repository URL/);
    await user.type(urlInput, "https://github.com/HasanZaigam/testing-repo-.git");
    await user.click(screen.getByRole("button", { name: /Validate repository/i }));
    await waitFor(() => expect(screen.getByText("Repository verified")).toBeInTheDocument());

    await user.type(urlInput, "x");
    expect(screen.queryByText("Repository verified")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect project/i })).toBeDisabled();
  });

  test("submitting after validation sends the derived owner/repo and the (possibly edited) name/base branch — never the raw pasted URL", async () => {
    const user = userEvent.setup();
    mockedProjectsApi.verifyGitHubRepo.mockResolvedValue(VERIFIED);
    const project = makeProject({ name: "testing-repo-", owner: "HasanZaigam", repo: "testing-repo-" });
    mockedProjectsApi.create.mockResolvedValue(project);
    const { onCreated } = await renderConnected();

    await user.type(screen.getByLabelText(/GitHub repository URL/), "https://github.com/HasanZaigam/testing-repo-.git");
    await user.click(screen.getByRole("button", { name: /Validate repository/i }));
    await waitFor(() => expect(screen.getByText("Repository verified")).toBeInTheDocument());

    const submit = screen.getByRole("button", { name: /Connect project/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project));
    expect(mockedProjectsApi.create).toHaveBeenCalledWith({
      sourceControlProvider: "github",
      name: "testing-repo-",
      owner: "HasanZaigam",
      repo: "testing-repo-",
      defaultBranch: "main",
    });
  });

  test("a server-side error on submission (after validation passed) still surfaces a labeled, readable message", async () => {
    const user = userEvent.setup();
    mockedProjectsApi.verifyGitHubRepo.mockResolvedValue(VERIFIED);
    mockedProjectsApi.create.mockRejectedValue(
      new ApiError(400, "INVALID_REQUEST", "Request body failed validation", { fieldErrors: { name: ["Required"] } }),
    );
    await renderConnected();

    await user.type(screen.getByLabelText(/GitHub repository URL/), "https://github.com/HasanZaigam/testing-repo-.git");
    await user.click(screen.getByRole("button", { name: /Validate repository/i }));
    await waitFor(() => expect(screen.getByText("Repository verified")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Connect project/i }));

    await waitFor(() => expect(screen.getByText(/Project name: Required/)).toBeInTheDocument());
    expect(screen.queryByText("Request body failed validation")).not.toBeInTheDocument();
  });

  test("the dialog description explains the GitHub credentials/PR workflow when GitHub is selected", async () => {
    await renderConnected();
    expect(screen.getByText(/Connect an existing GitHub repository so AI agents can work on tasks in it\./i)).toBeInTheDocument();
  });

  test("local-git provider still submits a single required Repository URL field, unchanged from the existing request shape", async () => {
    const user = userEvent.setup();
    mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
    const project = makeProject({ sourceControlProvider: "local-git", owner: null, repo: null, repoUrl: "/tmp/repo" });
    mockedProjectsApi.create.mockResolvedValue(project);
    const onCreated = vi.fn();
    render(<CreateProjectDialog onClose={vi.fn()} onCreated={onCreated} />);

    await user.selectOptions(screen.getByLabelText("Source control"), "local-git");
    await user.type(screen.getByLabelText("Project name *"), "Local test");
    await user.type(screen.getByLabelText("Repository URL *"), "/tmp/repo");
    await user.click(screen.getByRole("button", { name: /Connect project/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project));
    expect(mockedProjectsApi.create).toHaveBeenCalledWith({ sourceControlProvider: "local-git", name: "Local test", repoUrl: "/tmp/repo" });
  });

  test("the Local Git option is labeled to signal it does not open a Pull Request", async () => {
    await renderConnected();
    expect(screen.getByRole("option", { name: /Local \/ plain-git testing \(no PR\)/i })).toBeInTheDocument();
    // The old, unqualified label must be gone — it didn't signal the no-PR behavior at all.
    expect(screen.queryByText("Local git (dev/testing)")).not.toBeInTheDocument();
  });

  test("switching to Local Git swaps the dialog description and shows a plain-language 'no PR' explanation callout", async () => {
    const user = userEvent.setup();
    mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
    render(<CreateProjectDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("Source control"), "local-git");

    // The GitHub-only top description is gone, replaced by one that doesn't promise a PR workflow.
    expect(screen.queryByText(/Connect an existing GitHub repository so AI agents can work on tasks in it\./i)).not.toBeInTheDocument();
    expect(screen.getByText(/evaluation or testing/i)).toBeInTheDocument();

    // The existing info-callout/field-hint pattern is reused, not a new UI pattern, and states the
    // no-GitHub-account / no-PR / no-merge-signal facts plainly.
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByText(/No GitHub account is needed/i)).toBeInTheDocument();
    expect(screen.getByText(/no Pull Request is ever created/i)).toBeInTheDocument();
    expect(screen.getByText(/task never receives a GitHub merge signal/i)).toBeInTheDocument();
    expect(screen.getByText(/for evaluation and testing, not the normal production workflow/i)).toBeInTheDocument();
  });

  test("a production-disabled local-git submission surfaces the server's explanatory error message", async () => {
    const user = userEvent.setup();
    mockedGithubApi.getStatus.mockResolvedValue({ connected: true, githubLogin: "octocat", connectedAt: "2026-01-01T00:00:00.000Z" });
    mockedProjectsApi.create.mockRejectedValue(
      new ApiError(
        403,
        "LOCAL_GIT_PROJECTS_DISABLED",
        "Local git / plain-git testing projects are disabled in production. Set ALLOW_LOCAL_GIT_PROJECTS=true to explicitly enable it.",
      ),
    );
    render(<CreateProjectDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("Source control"), "local-git");
    await user.type(screen.getByLabelText("Project name *"), "Local test");
    await user.type(screen.getByLabelText("Repository URL *"), "/tmp/repo");
    await user.click(screen.getByRole("button", { name: /Connect project/i }));

    await waitFor(() => expect(screen.getByText(/disabled in production/i)).toBeInTheDocument());
  });
});
