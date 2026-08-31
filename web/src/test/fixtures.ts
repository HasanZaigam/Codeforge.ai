import type { HumanInputRequestDTO, ProjectDTO, TaskDTO, TaskEventDTO, TaskReport } from "../api/index.js";

export function makeProject(overrides: Partial<ProjectDTO> = {}): ProjectDTO {
  return {
    id: "project-1",
    name: "OTT",
    repoUrl: "https://github.com/example/ott.git",
    defaultBranch: "main",
    codingEngine: "claude-code",
    sourceControlProvider: "github",
    owner: "example",
    repo: "ott",
    commandsDeclared: ["test"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeTask(overrides: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Fix OTP timeout login",
    description: "Client reports that OTP login fails after session timeout.",
    status: "TODO",
    currentActivity: "Waiting to start",
    selfFixAttempts: 0,
    branchName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    cancelledBy: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    commitSha: null,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<TaskEventDTO> = {}): TaskEventDTO {
  return {
    id: "event-1",
    type: "TASK_CREATED",
    payload: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeInputRequest(overrides: Partial<HumanInputRequestDTO> = {}): HumanInputRequestDTO {
  return {
    id: "input-1",
    status: "open",
    discovered: "Two equally plausible fixes exist for the expired session.",
    attempted: ["Read the auth module", "Ran the failing test"],
    blocker: "Nothing in the repo disambiguates the correct approach.",
    question: "Should the session refresh automatically, or force re-login?",
    options: [
      { label: "Auto-refresh", description: "Refresh the session automatically." },
      { label: "Force re-login", description: "Require the user to log in again." },
    ],
    answer: null,
    askedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: null,
    ...overrides,
  };
}

export function makeReport(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    title: "Fix OTP timeout login",
    whatWasWrong: "Client reports that OTP login fails after session timeout.",
    whatChanged: "Updated session timeout handling.",
    filesChanged: 5,
    checks: [
      { name: "build", passed: true },
      { name: "test", passed: true },
    ],
    reviewFindings: [],
    confidence: "high",
    status: "Ready for review",
    pullRequest: null,
    commitSha: null,
    ...overrides,
  };
}
