import type { Project, Task } from "../domain/types.js";
import type { BacklogItem, TaskProposal } from "../backlog/backlog-types.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { BacklogItemRepository } from "../persistence/repositories/backlog-item-repository.js";
import type { TaskProposalRepository } from "../persistence/repositories/task-proposal-repository.js";
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

/**
 * Phase 4A — backlog items and task proposals have no owner of their own; like tasks, access is
 * entirely derived from the owning project. "Exists but not yours" is a 404, never a 403 (see this
 * file's own header).
 */
export function assertBacklogItemAccess(items: BacklogItemRepository, projects: ProjectRepository, itemId: string, actorId: string): BacklogItem {
  const item = items.findById(itemId);
  if (!item) throw new NotFoundError("BacklogItem", itemId);
  const project = projects.findById(item.projectId);
  if (!project || project.ownerId !== actorId) throw new NotFoundError("BacklogItem", itemId);
  return item;
}

export function assertTaskProposalAccess(proposals: TaskProposalRepository, projects: ProjectRepository, proposalId: string, actorId: string): TaskProposal {
  const proposal = proposals.findById(proposalId);
  if (!proposal) throw new NotFoundError("TaskProposal", proposalId);
  const project = projects.findById(proposal.projectId);
  if (!project || project.ownerId !== actorId) throw new NotFoundError("TaskProposal", proposalId);
  return proposal;
}

export function assertTaskAccess(tasks: TaskRepository, projects: ProjectRepository, taskId: string, actorId: string): Task {
  const task = tasks.findById(taskId);
  if (!task) throw new NotFoundError("Task", taskId);
  const project = projects.findById(task.projectId);
  if (!project || project.ownerId !== actorId) throw new NotFoundError("Task", taskId);
  return task;
}
