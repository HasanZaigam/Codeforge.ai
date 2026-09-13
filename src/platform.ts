import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./persistence/db.js";
import { TaskRepository } from "./persistence/repositories/task-repository.js";
import { TaskDependencyRepository } from "./persistence/repositories/task-dependency-repository.js";
import { TaskEventRepository } from "./persistence/repositories/task-event-repository.js";
import { ProjectRepository } from "./persistence/repositories/project-repository.js";
import { ProjectWorkspaceRepository } from "./persistence/repositories/project-workspace-repository.js";
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
  agentRuns: AgentRunRepository;
  workspaces: WorkspaceRepository;
  humanInput: HumanInputRepository;
  users: UserRepository;
  sessions: SessionRepository;
  githubCredentials: GitHubCredentialRepository;
  orchestrator: Orchestrator;
  /** Exposed so the application layer can resolve a project's provider for read-only operations (e.g. TaskService.listBranches) without duplicating the registry. */
  sourceControlProviders: SourceControlProviderRegistry;
}

export interface BuildPlatformOptions {
  dbPath: string;
  workspacesRoot: string;
  engine: CodingEngine;
  additionalCodingEngines?: CodingEngine[];
  ownerId?: string;
  orchestratorConfig?: Partial<OrchestratorConfig>;
  /**
   * Test-only escape hatch: registered after the default providers, so a
   * test can substitute a deterministic fake for "github" (or add its own
   * key) without a live GitHub credential. Never used in production wiring
   * (cli/server.ts never sets this). See tests/helpers/fake-source-control-provider.ts.
   */
  additionalSourceControlProviders?: SourceControlProvider[];
}

export function buildPlatform(options: BuildPlatformOptions): Platform {
  const db = openDatabase(options.dbPath);

  const tasks = new TaskRepository(db);
  const taskDependencies = new TaskDependencyRepository(db);
  const taskEvents = new TaskEventRepository(db);
  const projects = new ProjectRepository(db);
  const projectWorkspaces = new ProjectWorkspaceRepository(db);
  const agentRuns = new AgentRunRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const humanInput = new HumanInputRepository(db);
  const users = new UserRepository(db);
  const sessions = new SessionRepository(db);
  const githubCredentials = new GitHubCredentialRepository(db);

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
    options.ownerId ?? `worker-${randomUUID().slice(0, 8)}`,
    { ...DEFAULT_ORCHESTRATOR_CONFIG, ...options.orchestratorConfig },
  );

  return {
    db,
    tasks,
    taskDependencies,
    taskEvents,
    projects,
    projectWorkspaces,
    agentRuns,
    workspaces,
    humanInput,
    users,
    sessions,
    githubCredentials,
    orchestrator,
    sourceControlProviders,
  };
}
