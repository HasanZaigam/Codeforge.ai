import type { Project, Task } from "../domain/types.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import { NotFoundError } from "./errors.js";

/**
 * The one place project/task access is checked — every application service
 * that touches a project or task goes through these instead of re-deriving
 * the rule. See /docs/AUTHENTICATION.md "Authorization model": MVP access
 * is User -> owns -> Project -> (all of that project's tasks).
 *
 * Deliberately returns 404 (via NotFoundError), not 403, for "exists but
 * not yours" — see /docs/API.md "Authorization semantics" for why: this API
 * never confirms that a resource exists to a caller who isn't allowed to
 * see it.
 */

export function assertProjectAccess(projects: ProjectRepository, projectId: string, actorId: string): Project {
  const project = projects.findById(projectId);
  if (!project || project.ownerId !== actorId) throw new NotFoundError("Project", projectId);
  return project;
}

export function assertTaskAccess(tasks: TaskRepository, projects: ProjectRepository, taskId: string, actorId: string): Task {
  const task = tasks.findById(taskId);
  if (!task) throw new NotFoundError("Task", taskId);
  const project = projects.findById(task.projectId);
  if (!project || project.ownerId !== actorId) throw new NotFoundError("Task", taskId);
  return task;
}
