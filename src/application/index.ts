import type { Platform } from "../platform.js";
import { ProjectService } from "./project-service.js";
import { TaskService } from "./task-service.js";
import { HumanInputService } from "./human-input-service.js";
import { AuthService } from "./auth-service.js";
import { GitHubIntegrationService } from "./github-integration-service.js";
import { ClaimVerifier } from "./claim-verifier.js";
import { BacklogService } from "./backlog-service.js";
import { BacklogBulkService } from "./backlog-bulk-service.js";
import { BacklogAdjudicationService } from "./backlog-adjudication-service.js";
import { ChatService } from "./chat-service.js";
import { ContextLayerService } from "./context-layer.js";
import { ActionLayerService } from "./action-layer.js";
import { loadEncryptionKey } from "../auth/credential-encryption.js";
import type { ModelGatewayService } from "./model-gateway-service.js";

export interface ApplicationServices {
  auth: AuthService;
  github: GitHubIntegrationService;
  projects: ProjectService;
  tasks: TaskService;
  humanInput: HumanInputService;
  backlog: BacklogService;
  /** Phase 4B: import, bulk analysis grouping, bulk review, relationship review, low-risk bulk actions. */
  bulk: BacklogBulkService;
  /** Phase 4B.1: human ground-truth adjudication — a separate layer; never overwrites AI/platform state. */
  adjudication: BacklogAdjudicationService;
  /** Enqueues/cancels worker jobs that execute a project's approved claim checks (Phase 4A.6). */
  claimVerifier: ClaimVerifier;
  /** Phase 4C — project-aware Chat inside Overview. Reuses `bulk` and the existing BacklogAnalyzer; never a second analysis/task-creation path. */
  chat: ChatService;
  /** Model Gateway — see application/model-gateway-service.ts. The SAME instance the Orchestrator/BacklogAnalyzer already resolve every AI execution through (platform.modelGateway) — never a second instance/config. */
  modelGateway: ModelGatewayService;
}

/** The only place application services are constructed from a Platform's repositories. */
export function buildApplicationServices(platform: Platform): ApplicationServices {
  const github = new GitHubIntegrationService(platform.githubCredentials, () => loadEncryptionKey());
  const tasks = new TaskService(
    platform.tasks,
    platform.taskEvents,
    platform.agentRuns,
    platform.projects,
    platform.orchestrator,
    platform.sourceControlProviders,
    platform.taskDependencies,
  );
  const backlog = new BacklogService({
      db: platform.db,
      items: platform.backlogItems,
      analyses: platform.backlogAnalyses,
      relationships: platform.backlogRelationships,
      proposals: platform.taskProposals,
      events: platform.backlogEvents,
      jobs: platform.backlogJobs,
      projects: platform.projects,
      tasks: platform.tasks,
      taskService: tasks,
      claimVerifications: platform.claimVerifications,
      options: platform.backlogOptions,
    });
  const bulk = new BacklogBulkService({
      db: platform.db,
      items: platform.backlogItems,
      analyses: platform.backlogAnalyses,
      jobs: platform.backlogJobs,
      relationships: platform.backlogRelationships,
      proposals: platform.taskProposals,
      events: platform.backlogEvents,
      bulk: platform.backlogBulk,
      projects: platform.projects,
      claimVerifications: platform.claimVerifications,
      backlog,
    });
  const projects = new ProjectService(platform.projects, platform.projectWorkspaces, platform.projectWorkspaceFs, platform.projectContext, github, platform.tasks);
  // Phase 4D — the Context Layer is a thin, read-only adapter over TaskService/ProjectService — never a
  // second task database. See docs/CHAT.md "Context Layer".
  const contextLayer = new ContextLayerService({ projects: platform.projects, tasks, projectService: projects, bulkService: bulk });
  // Phase 4D.2 — the Action Layer is the ONLY way Chat may mutate state; it delegates every mutation to
  // this SAME `tasks` (TaskService) instance the Tasks UI/API use — never a second task-creation/state path.
  const actionLayer = new ActionLayerService({ tasks, taskEvents: platform.taskEvents });
  return {
    auth: new AuthService(platform.users, platform.sessions),
    github,
    projects,
    tasks,
    humanInput: new HumanInputService(platform.humanInput, platform.tasks, platform.projects, platform.orchestrator),
    // Phase 4A — conversion goes through the SAME TaskService instance the routes use (no second task-creation path).
    backlog,
    bulk,
    // Phase 4C — Chat reuses `bulk` (the SAME bulk-import/analysis/bulkAction service Issues & Requests uses) and
    // `platform.backlogAnalyzer` (the SAME model-call path backlog analysis uses) — never a second version of either.
    chat: new ChatService({
      chatMessages: platform.chatMessages,
      projects: platform.projects,
      projectService: projects,
      bulk,
      analyzer: platform.backlogAnalyzer,
      contextLayer,
      actionLayer,
    }),
    adjudication: new BacklogAdjudicationService({
      items: platform.backlogItems,
      analyses: platform.backlogAnalyses,
      relationships: platform.backlogRelationships,
      projects: platform.projects,
      judgments: platform.backlogAdjudication,
      baselines: platform.backlogAdjudicationBaselines,
      bulk,
    }),
    claimVerifier: new ClaimVerifier({
      items: platform.backlogItems,
      analyses: platform.backlogAnalyses,
      projects: platform.projects,
      jobs: platform.claimVerificationJobs,
      events: platform.backlogEvents,
    }),
    // Model Gateway — the SAME instance already wired into the Orchestrator/BacklogAnalyzer at
    // platform-build time (see platform.ts), never a second one constructed here.
    modelGateway: platform.modelGateway,
  };
}

export { ProjectService, TaskService, HumanInputService, AuthService, GitHubIntegrationService, BacklogService };
export * from "./errors.js";
