import type { Task, TaskEvent } from "../domain/types.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { TaskEventRepository } from "../persistence/repositories/task-event-repository.js";
import type { AgentRunRepository } from "../persistence/repositories/agent-run-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { createTask } from "../orchestrator/task-factory.js";
import { buildTaskReport, type TaskReport } from "../reporting/task-report.js";
import { assertProjectAccess, assertTaskAccess } from "./authorization.js";

export interface CreateTaskInput {
  projectId: string;
  title: string;
  /** Plain-language description — the API never requires a technical prompt. See PRODUCT_REQUIREMENTS.md FR-3. */
  description: string;
}

/**
 * Translates task requests into domain operations. Task *creation* is the
 * only write this service performs directly (inserting a TODO task is not
 * an orchestration decision); everything that moves a task forward —
 * claiming, execution, state transitions — belongs to the Orchestrator and
 * is never duplicated here. See /docs/ARCHITECTURE.md layers 4/5.
 *
 * Every method takes the authenticated `actorId` and enforces access via
 * `assertProjectAccess`/`assertTaskAccess` before touching anything — see
 * /docs/AUTHENTICATION.md "Authorization model". Tasks have no owner field
 * of their own; access is entirely derived from the owning project.
 */
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly taskEvents: TaskEventRepository,
    private readonly agentRuns: AgentRunRepository,
    private readonly projects: ProjectRepository,
    private readonly orchestrator: Orchestrator,
  ) {}

  create(input: CreateTaskInput, actorId: string): Task {
    const project = assertProjectAccess(this.projects, input.projectId, actorId);
    return createTask(this.tasks, this.taskEvents, {
      tenantId: project.tenantId,
      projectId: project.id,
      title: input.title,
      goal: input.description,
      createdBy: actorId,
    });
  }

  get(taskId: string, actorId: string): Task {
    return assertTaskAccess(this.tasks, this.projects, taskId, actorId);
  }

  listForProject(projectId: string, actorId: string): Task[] {
    assertProjectAccess(this.projects, projectId, actorId);
    return this.tasks.listByProject(projectId);
  }

  listEvents(taskId: string, actorId: string): TaskEvent[] {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.taskEvents.listForTask(taskId);
  }

  getReport(taskId: string, actorId: string): TaskReport {
    const task = assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    const project = this.projects.findById(task.projectId); // already known-accessible via assertTaskAccess above
    const runs = this.agentRuns.listForTask(taskId);
    const events = this.taskEvents.listForTask(taskId);
    return buildTaskReport(task, runs, events, project?.defaultBranch ?? "main");
  }

  /**
   * Requests cancellation of a task. Delegates entirely to
   * Orchestrator.requestCancellation() — this is a domain command, not a
   * status write, and the state-machine legality rules (which states are
   * cancellable, idempotency) live exactly once, in the Orchestrator/state
   * machine, not duplicated here. See /docs/TASK_LIFECYCLE.md "Cancellation".
   */
  async cancelTask(taskId: string, actorId: string): Promise<Task> {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.orchestrator.requestCancellation(taskId, actorId);
  }
}
