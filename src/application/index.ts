import type { Platform } from "../platform.js";
import { ProjectService } from "./project-service.js";
import { TaskService } from "./task-service.js";
import { HumanInputService } from "./human-input-service.js";
import { AuthService } from "./auth-service.js";
import { GitHubIntegrationService } from "./github-integration-service.js";
import { BacklogService } from "./backlog-service.js";
import { loadEncryptionKey } from "../auth/credential-encryption.js";

export interface ApplicationServices {
  auth: AuthService;
  github: GitHubIntegrationService;
  projects: ProjectService;
  tasks: TaskService;
  humanInput: HumanInputService;
  backlog: BacklogService;
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
  return {
    auth: new AuthService(platform.users, platform.sessions),
    github,
    projects: new ProjectService(platform.projects, platform.projectWorkspaces, platform.projectWorkspaceFs, platform.projectContext, github, platform.tasks),
    tasks,
    humanInput: new HumanInputService(platform.humanInput, platform.tasks, platform.projects, platform.orchestrator),
    // Phase 4A — conversion goes through the SAME TaskService instance the routes use (no second task-creation path).
    backlog: new BacklogService({
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
      options: platform.backlogOptions,
    }),
  };
}

export { ProjectService, TaskService, HumanInputService, AuthService, GitHubIntegrationService, BacklogService };
export * from "./errors.js";
