import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./persistence/db.js";
import { TaskRepository } from "./persistence/repositories/task-repository.js";
import { TaskDependencyRepository } from "./persistence/repositories/task-dependency-repository.js";
import { TaskEventRepository } from "./persistence/repositories/task-event-repository.js";
import { ProjectRepository } from "./persistence/repositories/project-repository.js";
import { ProjectWorkspaceRepository } from "./persistence/repositories/project-workspace-repository.js";
import { ProjectWorkspaceFsManager } from "./project-workspace/project-workspace-fs-manager.js";
import { ProjectContextService } from "./project-workspace/project-context-service.js";
import { AgentRunRepository } from "./persistence/repositories/agent-run-repository.js";
import { WorkspaceRepository } from "./persistence/repositories/workspace-repository.js";
import { HumanInputRepository } from "./persistence/repositories/human-input-repository.js";
import { UserRepository } from "./persistence/repositories/user-repository.js";
import { SessionRepository } from "./persistence/repositories/session-repository.js";
import { GitHubCredentialRepository } from "./persistence/repositories/github-credential-repository.js";
import { CodingEngineRegistry, type CodingEngine } from "./coding-engine/coding-engine.js";
import { ClaudeCodeAdapter } from "./coding-engine/claude-code-adapter.js";
import { OpenCodeAdapter } from "./coding-engine/opencode-adapter.js";
import { LocalGitWorkspaceProvider } from "./workspace/local-git-workspace-provider.js";
import { LocalGitSourceControlProvider } from "./source-control/local-git-source-control-provider.js";
import { GitHubSourceControlProvider } from "./source-control/github-source-control-provider.js";
import { SourceControlProviderRegistry, type SourceControlProvider } from "./source-control/source-control-provider.js";
import { loadEncryptionKey } from "./auth/credential-encryption.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "./orchestrator/config.js";
import { ProviderHealthRepository } from "./persistence/repositories/provider-health-repository.js";
import { ModelRegistry } from "./routing/model-registry.js";
import { ProviderConnectionRepository } from "./persistence/repositories/provider-connection-repository.js";
import { GlobalAiConfigRepository } from "./persistence/repositories/global-ai-config-repository.js";
import { ModelGatewayService } from "./application/model-gateway-service.js";
import { BacklogItemRepository } from "./persistence/repositories/backlog-item-repository.js";
import { ChatRepository } from "./persistence/repositories/chat-repository.js";
import { BacklogAnalysisRepository } from "./persistence/repositories/backlog-analysis-repository.js";
import { BacklogRelationshipRepository } from "./persistence/repositories/backlog-relationship-repository.js";
import { TaskProposalRepository } from "./persistence/repositories/task-proposal-repository.js";
import { BacklogEventRepository } from "./persistence/repositories/backlog-event-repository.js";
import { BacklogAnalyzer } from "./backlog/backlog-analyzer.js";
import { BacklogContextBuilder } from "./backlog/context-builder.js";
import { GitRepositoryStructureProvider, type RepositoryStructureProvider } from "./backlog/repository-structure.js";
import type { BacklogServiceOptions } from "./application/backlog-service.js";
import { BacklogAnalysisJobRepository } from "./persistence/repositories/backlog-analysis-job-repository.js";
import { BacklogAnalysisExecutor } from "./application/backlog-analysis-executor.js";
import { RepositoryIndexRepository } from "./persistence/repositories/repository-index-repository.js";
import { BacklogBulkRepository } from "./persistence/repositories/backlog-bulk-repository.js";
import { BacklogAdjudicationRepository } from "./persistence/repositories/backlog-adjudication-repository.js";
import { BacklogAdjudicationBaselineRepository } from "./persistence/repositories/backlog-adjudication-baseline-repository.js";
import { ClaimVerificationRepository } from "./persistence/repositories/claim-verification-repository.js";
import { RepositoryIndexService, type RepositoryIndexServiceOptions } from "./backlog/repository-index-service.js";
import { ClaimVerificationJobRepository } from "./persistence/repositories/claim-verification-job-repository.js";
import { ClaimVerificationExecutor, type WorkspaceFactory } from "./application/claim-verification-executor.js";
import { ClaimVerificationRunner, DEFAULT_MAX_VERIFICATION_CONCURRENCY, DEFAULT_VERIFICATION_HEARTBEAT_MS, DEFAULT_VERIFICATION_LEASE_MS } from "./worker/claim-verification-runner.js";
import { CompositeRunner } from "./worker/worker.js";
import { BacklogAnalysisRunner, DEFAULT_ANALYSIS_HEARTBEAT_MS, DEFAULT_ANALYSIS_LEASE_MS, DEFAULT_MAX_ANALYSIS_CONCURRENCY } from "./worker/backlog-analysis-runner.js";

/**
 * Wires the concrete MVP implementations behind each abstraction (local
 * SQLite, local-git/GitHub source control, a pluggable CodingEngine) into
 * one Orchestrator instance. This is the only place that knows about
 * concrete providers — see /docs/INTEGRATION_ARCHITECTURE.md.
 */
export interface Platform {
  db: DatabaseSync;
  tasks: TaskRepository;
  taskDependencies: TaskDependencyRepository;
  taskEvents: TaskEventRepository;
  projects: ProjectRepository;
  projectWorkspaces: ProjectWorkspaceRepository;
  projectWorkspaceFs: ProjectWorkspaceFsManager;
  projectContext: ProjectContextService;
  agentRuns: AgentRunRepository;
  workspaces: WorkspaceRepository;
  humanInput: HumanInputRepository;
  users: UserRepository;
  sessions: SessionRepository;
  githubCredentials: GitHubCredentialRepository;
  orchestrator: Orchestrator;
  /** Exposed so the application layer can resolve a project's provider for read-only operations (e.g. TaskService.listBranches) without duplicating the registry. */
  sourceControlProviders: SourceControlProviderRegistry;
  /** V1.1 Slice 5 — see routing/model-registry.ts. Exposed for read-only inspection (e.g. a future "which models are configured" admin view) — the Orchestrator holds its own reference for actual routing decisions. */
  modelRegistry: ModelRegistry;
  /** V1.1 Slice 5 — see persistence/repositories/provider-health-repository.ts. */
  providerHealth: ProviderHealthRepository;
  /** Model Gateway — see application/model-gateway-service.ts. */
  providerConnections: ProviderConnectionRepository;
  globalAiConfig: GlobalAiConfigRepository;
  /** Model Gateway — the single account-scoped model/provider resolution point every AI execution
   *  (Orchestrator, BacklogAnalyzer/Chat) goes through. Exposed here (rather than only inside
   *  application/index.ts) for the SAME reason `backlogAnalyzer` is: it must be constructed once and
   *  handed to both the Orchestrator and BacklogAnalyzer at THEIR construction time, below. */
  modelGateway: ModelGatewayService;
  /** Phase 4A — Backlog Intelligence (see /docs/BACKLOG_INTELLIGENCE.md). Consumed only by BacklogService (application/backlog-service.ts). */
  backlogItems: BacklogItemRepository;
  backlogAnalyses: BacklogAnalysisRepository;
  backlogRelationships: BacklogRelationshipRepository;
  taskProposals: TaskProposalRepository;
  backlogEvents: BacklogEventRepository;
  backlogJobs: BacklogAnalysisJobRepository;
  claimVerifications: ClaimVerificationRepository;
  backlogBulk: BacklogBulkRepository;
  backlogAdjudication: BacklogAdjudicationRepository;
  backlogAdjudicationBaselines: BacklogAdjudicationBaselineRepository;
  backlogAnalyzer: BacklogAnalyzer;
  backlogContextBuilder: BacklogContextBuilder;
  /** Phase 4C — project-aware Chat (see /docs/CHAT.md). Reuses this same engine/model registry via backlogAnalyzer; never a second call path to a model. */
  chatMessages: ChatRepository;
  /** Phase 4A.1 — executes one claimed analysis job. Used ONLY by the runner below (worker process); the API process never touches it. */
  backlogExecutor: BacklogAnalysisExecutor;
  /**
   * Phase 4A.1 — the worker-side driver for backlog analysis (claim, lease, heartbeat, global cap).
   * The standalone worker hands it to `Worker`; the API process never ticks it, so no model call ever
   * happens inside an HTTP request.
   */
  backlogRunner: BacklogAnalysisRunner;
  /** Phase 4A.6 — claim-bound verification jobs (same worker, same DB; the API process only enqueues). */
  claimVerificationJobs: ClaimVerificationJobRepository;
  claimVerificationExecutor: ClaimVerificationExecutor;
  claimVerificationRunner: ClaimVerificationRunner;
  /** What the ONE worker loop drives: backlog analysis + claim verification. */
  backgroundRunner: CompositeRunner;
  /** The RESOLVED options (defaults filled in). */
  backlogOptions: BacklogServiceOptions;
}

export interface BuildPlatformOptions {
  dbPath: string;
  workspacesRoot: string;
  /**
   * Root for persistent, project-scoped ProjectWorkspace directories (Phase 3, Slice 3) — always a
   * separate directory from `workspacesRoot` (the existing, unrelated per-task execution
   * Workspace), never a subdirectory of it. Optional so the 30+ existing call sites that don't
   * exercise ProjectWorkspace filesystem behavior at all need no change: defaults to a
   * `project-workspaces` directory alongside `workspacesRoot`'s own parent, which for every test
   * harness already keeps it inside that test's own isolated temp root.
   */
  projectWorkspacesRoot?: string;
  engine: CodingEngine;
  additionalCodingEngines?: CodingEngine[];
  ownerId?: string;
  /** Phase 4A.6 test seams for claim verification (production: a SHA-pinned throwaway checkout, the check's own timeout). */
  verification?: { workspaceFactory?: WorkspaceFactory; checkTimeoutMsOverride?: number; leaseMs?: number; heartbeatMs?: number; maxConcurrency?: number; maxAttempts?: number; retryBaseDelayMs?: number };
  orchestratorConfig?: Partial<OrchestratorConfig>;
  /**
   * Test-only escape hatch: registered after the default providers, so a
   * test can substitute a deterministic fake for "github" (or add its own
   * key) without a live GitHub credential. Never used in production wiring
   * (cli/server.ts never sets this). See tests/helpers/fake-source-control-provider.ts.
   */
  additionalSourceControlProviders?: SourceControlProvider[];
  /**
   * V1.1 Slice 5 — the model/provider catalog this platform instance routes against (see
   * routing/model-registry.ts). Optional: omitted (or an empty registry) means no routing at
   * all — every invocation falls back to whatever model the coding engine would have used before
   * this slice existed (see EngineInvocationRequest.modelSelection's own doc comment). Production
   * wiring (env-platform.ts's `buildPlatformFromEnv`) derives one real profile from
   * `OPENCODE_MODEL` when it's set; tests that want to exercise routing/fallback construct their
   * own registry directly (see this slice's brief, item 25, on why that's not "a fake provider").
   */
  modelRegistry?: ModelRegistry;
  /**
   * Phase 4A — how backlog analysis sees the repository (see backlog/repository-structure.ts). Omitted
   * (production) means the real deterministic git-tree listing over the project's own
   * SourceControlProvider; `null` means "no repository listing" (analysis then says so); tests
   * inject a deterministic fake. Never an AI-facing capability — it only produces a bounded file listing.
   */
  repositoryStructureProvider?: RepositoryStructureProvider | null;
  /** Phase 4A — lease/limit tuning for BacklogService (tests shorten the leases). */
  backlogOptions?: BacklogServiceOptions;
  /** Repository-index tuning (limits, leases) — tests only. `false` disables the index entirely (selection by file name only). */
  repositoryIndex?: RepositoryIndexServiceOptions | false;
}

export function buildPlatform(options: BuildPlatformOptions): Platform {
  const db = openDatabase(options.dbPath);

  const tasks = new TaskRepository(db);
  const taskDependencies = new TaskDependencyRepository(db);
  const taskEvents = new TaskEventRepository(db);
  const projects = new ProjectRepository(db);
  const projectWorkspaces = new ProjectWorkspaceRepository(db);
  const projectWorkspaceFs = new ProjectWorkspaceFsManager(
    options.projectWorkspacesRoot ?? join(dirname(options.workspacesRoot), "project-workspaces"),
  );
  const projectContext = new ProjectContextService(projectWorkspaceFs);
  const agentRuns = new AgentRunRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const humanInput = new HumanInputRepository(db);
  const users = new UserRepository(db);
  const sessions = new SessionRepository(db);
  const githubCredentials = new GitHubCredentialRepository(db);
  const providerHealth = new ProviderHealthRepository(db);
  const modelRegistry = options.modelRegistry ?? new ModelRegistry();
  const providerConnections = new ProviderConnectionRepository(db);
  const globalAiConfig = new GlobalAiConfigRepository(db);

  const engines = new CodingEngineRegistry();
  engines.register(new OpenCodeAdapter());
  engines.register(new ClaudeCodeAdapter());
  engines.register(options.engine);
  for (const eng of options.additionalCodingEngines ?? []) {
    engines.register(eng);
  }

  const workspaceProvider = new LocalGitWorkspaceProvider(options.workspacesRoot, workspaces);

  const sourceControlProviders = new SourceControlProviderRegistry();
  sourceControlProviders.register(new LocalGitSourceControlProvider());
  // The encryption key is resolved lazily (only when a "github" project actually executes a task
  // or connects a repository) — building the platform must not require CREDENTIAL_ENCRYPTION_KEY
  // to be set for deployments that never use the GitHub integration. See auth/credential-encryption.ts.
  sourceControlProviders.register(new GitHubSourceControlProvider(githubCredentials, () => loadEncryptionKey()));
  for (const provider of options.additionalSourceControlProviders ?? []) {
    sourceControlProviders.register(provider);
  }

  const orchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...options.orchestratorConfig };
  const ownerId = options.ownerId ?? `worker-${randomUUID().slice(0, 8)}`;

  // Phase 4A — Backlog Intelligence. The analyzer reuses the SAME engine registry, model registry and
  // provider-health repository as task execution (no second way to call a model); the context builder
  // reuses the SAME project-context loader.
  const backlogItems = new BacklogItemRepository(db);
  const chatMessages = new ChatRepository(db);
  const backlogAnalyses = new BacklogAnalysisRepository(db);
  const backlogRelationships = new BacklogRelationshipRepository(db);
  const taskProposals = new TaskProposalRepository(db);
  const backlogEvents = new BacklogEventRepository(db);
  // Model Gateway — built once, shared by the Orchestrator (task execution) and BacklogAnalyzer
  // (Chat/backlog analysis) below, exactly the way `modelRegistry`/`providerHealth` already were —
  // never a second, divergent resolution path for either call site.
  const modelGateway = new ModelGatewayService(providerConnections, globalAiConfig, providerHealth, agentRuns, () => loadEncryptionKey());
  const backlogAnalyzer = new BacklogAnalyzer(
    engines,
    modelRegistry,
    providerHealth,
    {
      timeoutMs: orchestratorConfig.agentInvocationTimeoutMs,
      cooldown: { defaultCooldownMs: orchestratorConfig.providerCooldownDefaultMs, maxCooldownMs: orchestratorConfig.providerCooldownMaxMs },
    },
    modelGateway,
  );
  const structureProvider =
    options.repositoryStructureProvider === undefined ? new GitRepositoryStructureProvider(sourceControlProviders) : options.repositoryStructureProvider;
  const backlogContextBuilder = new BacklogContextBuilder(projectWorkspaces, projectContext);
  const backlogJobs = new BacklogAnalysisJobRepository(db);
  const claimVerifications = new ClaimVerificationRepository(db);
  const backlogBulk = new BacklogBulkRepository(db);
  const backlogAdjudication = new BacklogAdjudicationRepository(db);
  const backlogAdjudicationBaselines = new BacklogAdjudicationBaselineRepository(db);
  const backlogOptions: BacklogServiceOptions = {
    analysisLeaseMs: DEFAULT_ANALYSIS_LEASE_MS,
    analysisHeartbeatMs: DEFAULT_ANALYSIS_HEARTBEAT_MS,
    // Same bounded-retry budget as episode-level infrastructure retry: `maxInfrastructureRetries` EXTRA attempts.
    analysisMaxAttempts: orchestratorConfig.maxInfrastructureRetries + 1,
    maxAnalysisConcurrency: DEFAULT_MAX_ANALYSIS_CONCURRENCY,
    ...options.backlogOptions,
  };
  const backlogExecutor = new BacklogAnalysisExecutor({
    db,
    items: backlogItems,
    analyses: backlogAnalyses,
    relationships: backlogRelationships,
    events: backlogEvents,
    jobs: backlogJobs,
    projects,
    analyzer: backlogAnalyzer,
    contextBuilder: backlogContextBuilder,
    repository: structureProvider,
    repositoryIndex: structureProvider && options.repositoryIndex !== false ? new RepositoryIndexService(new RepositoryIndexRepository(db), options.repositoryIndex ?? {}) : null,
    options: {
      retryBaseDelayMs: orchestratorConfig.infrastructureRetryBaseDelayMs,
      retryMaxDelayMs: orchestratorConfig.infrastructureRetryMaxDelayMs,
      cooldownMaxMs: orchestratorConfig.providerCooldownMaxMs,
    },
  });
  const backlogRunner = new BacklogAnalysisRunner(backlogJobs, backlogExecutor, {
    ownerId,
    maxConcurrency: backlogOptions.maxAnalysisConcurrency!,
    leaseMs: backlogOptions.analysisLeaseMs!,
    heartbeatMs: backlogOptions.analysisHeartbeatMs!,
  });
  const claimVerificationJobs = new ClaimVerificationJobRepository(db);
  const claimVerificationExecutor = new ClaimVerificationExecutor({
    db,
    items: backlogItems,
    analyses: backlogAnalyses,
    projects,
    jobs: claimVerificationJobs,
    claimVerifications,
    events: backlogEvents,
    sourceControlProviders,
    workspaceFactory: options.verification?.workspaceFactory,
    checkTimeoutMsOverride: options.verification?.checkTimeoutMsOverride,
    retryBaseDelayMs: options.verification?.retryBaseDelayMs ?? orchestratorConfig.infrastructureRetryBaseDelayMs,
  });
  const claimVerificationRunner = new ClaimVerificationRunner(claimVerificationJobs, claimVerificationExecutor, {
    ownerId,
    maxConcurrency: options.verification?.maxConcurrency ?? DEFAULT_MAX_VERIFICATION_CONCURRENCY,
    leaseMs: options.verification?.leaseMs ?? DEFAULT_VERIFICATION_LEASE_MS,
    heartbeatMs: options.verification?.heartbeatMs ?? DEFAULT_VERIFICATION_HEARTBEAT_MS,
  });
  const backgroundRunner = new CompositeRunner([backlogRunner, claimVerificationRunner]);

  const orchestrator = new Orchestrator(
    tasks,
    taskEvents,
    projects,
    agentRuns,
    humanInput,
    workspaces,
    engines,
    workspaceProvider,
    sourceControlProviders,
    taskDependencies,
    ownerId,
    orchestratorConfig,
    projectWorkspaces,
    projectContext,
    modelRegistry,
    providerHealth,
    modelGateway,
  );

  return {
    db,
    tasks,
    taskDependencies,
    taskEvents,
    projects,
    projectWorkspaces,
    projectWorkspaceFs,
    projectContext,
    agentRuns,
    workspaces,
    humanInput,
    users,
    sessions,
    githubCredentials,
    orchestrator,
    sourceControlProviders,
    modelRegistry,
    providerHealth,
    providerConnections,
    globalAiConfig,
    modelGateway,
    backlogItems,
    chatMessages,
    backlogAnalyses,
    backlogRelationships,
    taskProposals,
    backlogEvents,
    backlogJobs,
    claimVerifications,
    backlogBulk,
    backlogAdjudication,
    backlogAdjudicationBaselines,
    backlogAnalyzer,
    backlogContextBuilder,
    backlogExecutor,
    backlogRunner,
    claimVerificationJobs,
    claimVerificationExecutor,
    claimVerificationRunner,
    backgroundRunner,
    backlogOptions,
  };
}
