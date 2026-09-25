import type {
  AgentRunHistoryItemDTO,
  BacklogAnalysisDTO,
  EvidenceAssessment,
  BacklogAnalysisJobDTO,
  BacklogItemDetailDTO,
  BacklogItemDTO,
  BacklogItemSummaryDTO,
  BacklogRelationshipDTO,
  TaskProposalContent,
  TaskProposalDTO,
  HumanInputRequestDTO,
  ProjectContextDTO,
  ProjectDTO,
  ProjectWorkspaceDTO,
  TaskDTO,
  TaskEventDTO,
  TaskReport,
} from "../api/index.js";

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
    commands: { test: "npm test" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<ProjectWorkspaceDTO> = {}): ProjectWorkspaceDTO {
  return {
    id: "workspace-1",
    projectId: "project-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeProjectContext(overrides: Partial<ProjectContextDTO> = {}): ProjectContextDTO {
  return {
    version: 1,
    revision: 1,
    project: { name: "OTT" },
    instructions: [],
    architecture: [],
    conventions: [],
    validation: { commands: [] },
    constraints: [],
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
    branchMode: "new",
    workingBranch: null,
    baseBranch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    cancelledBy: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    commitSha: null,
    dependencies: [],
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

export function makeAgentRunHistoryItem(overrides: Partial<AgentRunHistoryItemDTO> = {}): AgentRunHistoryItemDTO {
  return {
    id: "run-1",
    role: "implementer",
    attemptNumber: 1,
    status: "completed",
    trigger: "initial",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:30.000Z",
    summary: "Fixed the bug.",
    filesChanged: ["src/add.js"],
    confidence: "high",
    findings: null,
    verdict: null,
    error: null,
    humanReviewFeedback: null,
    resumedAfterInterruption: false,
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
    reviewSummary: null,
    confidence: "high",
    status: "Ready for review",
    pullRequest: null,
    commitSha: null,
    failureReason: null,
    agentRuns: [],
    durations: { totalMs: null, implementationMs: null, reviewMs: null, validationMs: null, waitingForHumanReviewMs: null },
    recoveredFromCrash: false,
    failureContext: null,
    ...overrides,
  };
}

export function makeBacklogItem(overrides: Partial<BacklogItemDTO> = {}): BacklogItemDTO {
  return {
    id: "item-1",
    projectId: "p1",
    externalRef: "BUG-002",
    title: "Login fails after timeout",
    description: "Users are logged out and cannot log back in.",
    source: "manual",
    status: "NEW",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeBacklogSummary(overrides: Partial<BacklogItemSummaryDTO> = {}): BacklogItemSummaryDTO {
  return { ...makeBacklogItem(), latestAnalysis: null, proposal: null, ...overrides };
}

export function makeAnalysis(overrides: Partial<BacklogAnalysisDTO> = {}): BacklogAnalysisDTO {
  return {
    id: "analysis-1",
    backlogItemId: "item-1",
    status: "succeeded",
    failureCategory: null,
    failureReason: null,
    result: {
      summary: "The session refresh path drops the token.",
      issueType: "bug",
      affectedApplication: "web",
      suspectedArea: "auth",
      candidateFiles: [
        { path: "src/auth/session.ts", reason: "Handles refresh" },
        { path: "src/auth/ghost.ts", reason: "Maybe" },
      ],
      duplicateCandidates: [],
      dependencyCandidates: [],
      missingInformation: [
        { question: "Which browsers are affected?", blocking: true },
        { question: "Is there a log?", blocking: false },
      ],
      suggestedAcceptanceCriteria: ["User stays logged in"],
      suggestedValidation: ["npm test"],
      confidence: { overall: "medium", uncertainties: ["Root cause unclear"] },
    },
    platformChecks: {
      candidateFiles: [
        { path: "src/auth/session.ts", existsInRepository: true },
        { path: "src/auth/ghost.ts", existsInRepository: false },
      ],
      unresolvedReferences: [],
      droppedRelationships: [],
      context: {
        projectContextIncluded: true,
        repositoryStructure: "included",
        repositoryFileCount: 120,
        repositoryPathsIncluded: 120,
        siblingItemsIncluded: 3,
        siblingItemsOmitted: 0,
        promptChars: 5000,
      },
    },
    diagnostics: null,
    modelId: "model-x",
    providerId: "provider-y",
    engineKey: "opencode",
    fallbackIndex: 0,
    routingReason: null,
    usage: null,
    estimatedCost: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
    ...overrides,
  };
}

/** An analysis carrying claims plus the platform's evidence and per-claim assessment. */
export function makeAssessedAnalysis(assessmentOverrides: Partial<EvidenceAssessment> = {}, overrides: Partial<BacklogAnalysisDTO> = {}): BacklogAnalysisDTO {
  const base = makeAnalysis();
  const assessment: EvidenceAssessment = {
    evidence: [
      { id: "E1", type: "FILE_EXISTS", source: "repository_listing", path: "backend/otpThrottle.ts", detail: null, matchedTerms: [] },
      { id: "E2", type: "CONTENT_MATCH", source: "repository_content", path: "src/auth/session.ts", detail: "L12: const refreshToken = await rotate(token)", matchedTerms: ["refreshToken"] },
    ],
    claims: [
      { claimIndex: 0, statement: "OTP throttle file exists", kind: "FILE_EXISTS", aiConfidence: "high", status: "SUPPORTED", evidenceIds: ["E1"], reason: "The repository listing contains this path." },
      { claimIndex: 1, statement: "Nothing rotates refresh tokens", kind: "FEATURE_ABSENT", aiConfidence: "high", status: "CONTRADICTED", evidenceIds: ["E2"], reason: "Repository content matches the search terms." },
      { claimIndex: 2, statement: "Rotation is implemented correctly", kind: "BEHAVIOR_CORRECT", aiConfidence: "medium", status: "UNRESOLVED", evidenceIds: [], reason: "Inspection cannot establish behavior." },
      { claimIndex: 3, statement: "Billing module exists", kind: "FEATURE_PRESENT", aiConfidence: "low", status: "NOT_CHECKED", evidenceIds: [], reason: "No repository access." },
    ],
    summary: { supported: 1, contradicted: 1, unresolved: 1, notChecked: 1 },
    confidenceOverridden: false,
    inspection: { listing: "complete", filesRead: 2, bytesRead: 2048, filesSkipped: [], limits: { maxFiles: 20, maxFileBytes: 65536, maxTotalBytes: 262144 } },
    ...assessmentOverrides,
  };
  return makeAnalysis({
    result: {
      ...base.result!,
      claims: [
        { statement: "OTP throttle file exists", kind: "FILE_EXISTS", path: "backend/otpThrottle.ts", searchTerms: [], confidence: "high" },
        { statement: "Nothing rotates refresh tokens", kind: "FEATURE_ABSENT", path: null, searchTerms: ["refreshToken"], confidence: "high" },
        { statement: "Rotation is implemented correctly", kind: "BEHAVIOR_CORRECT", path: null, searchTerms: [], confidence: "medium" },
        { statement: "Billing module exists", kind: "FEATURE_PRESENT", path: null, searchTerms: [], confidence: "low" },
      ],
    },
    platformChecks: { ...base.platformChecks!, assessment },
    ...overrides,
  });
}

export function makeProposalContent(overrides: Partial<TaskProposalContent> = {}): TaskProposalContent {
  return {
    title: "Fix session refresh",
    goal: "GOAL TEXT for the task",
    summary: "Proposal summary",
    issueType: "bug",
    affectedApplication: "web",
    suspectedArea: "auth",
    candidateFiles: [{ path: "src/auth/session.ts", reason: "Handles refresh", existsInRepository: true }],
    acceptanceCriteria: ["User stays logged in"],
    validation: ["npm test"],
    dependencies: [],
    duplicateWarnings: [],
    uncertainty: { overall: "medium", uncertainties: [], missingInformation: [] },
    ...overrides,
  };
}

export function makeProposal(overrides: Partial<TaskProposalDTO> = {}): TaskProposalDTO {
  return {
    id: "proposal-1",
    backlogItemId: "item-1",
    analysisId: "analysis-1",
    status: "PENDING",
    content: makeProposalContent(),
    decidedAt: null,
    taskId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeRelationship(overrides: Partial<BacklogRelationshipDTO> = {}): BacklogRelationshipDTO {
  return {
    id: "rel-1",
    kind: "POSSIBLE_DUPLICATE",
    status: "PROPOSED",
    direction: "outgoing",
    confidence: "high",
    rationale: "Same symptom",
    other: { id: "item-2", ref: "BUG-003", title: "Other login bug", status: "NEW" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeBacklogDetail(overrides: Partial<BacklogItemDetailDTO> = {}): BacklogItemDetailDTO {
  return { item: makeBacklogItem(), latestAnalysis: null, analysisJob: null, analysisCount: 0, relationships: [], proposal: null, events: [], ...overrides };
}

export function makeAnalysisJob(overrides: Partial<BacklogAnalysisJobDTO> = {}): BacklogAnalysisJobDTO {
  return {
    id: "job-1",
    status: "QUEUED",
    attemptCount: 0,
    maxAttempts: 3,
    availableAt: "2026-01-01T00:00:00.000Z",
    cancelRequested: false,
    failureCategory: null,
    failureReason: null,
    modelId: null,
    providerId: null,
    analysisId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}
