import type { HumanAnswer, HumanInputRequest, Task } from "../domain/types.js";
import type { HumanInputRepository } from "../persistence/repositories/human-input-repository.js";
import type { TaskRepository } from "../persistence/repositories/task-repository.js";
import type { ProjectRepository } from "../persistence/repositories/project-repository.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { assertTaskAccess } from "./authorization.js";
import { InvalidOperationError } from "./errors.js";

/**
 * Exposes the existing NEEDS_INPUT contract (HumanInputRequest, see
 * TASK_LIFECYCLE.md) to the API. Submitting an answer delegates the actual
 * state transition to Orchestrator.submitHumanAnswer — this service only
 * validates that answering is currently legal (an open request exists) so
 * the API returns a clean 409 instead of letting an invalid call reach the
 * state machine and throw there.
 *
 * Both methods enforce task access first — a user cannot see or answer
 * another user's NEEDS_INPUT question. See /docs/AUTHENTICATION.md.
 */
export class HumanInputService {
  constructor(
    private readonly humanInput: HumanInputRepository,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly orchestrator: Orchestrator,
  ) {}

  getOpenRequest(taskId: string, actorId: string): HumanInputRequest | null {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    return this.humanInput.findOpenForTask(taskId);
  }

  submitAnswer(taskId: string, answer: HumanAnswer, actorId: string): Task {
    assertTaskAccess(this.tasks, this.projects, taskId, actorId);
    const open = this.humanInput.findOpenForTask(taskId);
    if (!open) {
      throw new InvalidOperationError(`Task ${taskId} does not have an open input request to answer`);
    }
    return this.orchestrator.submitHumanAnswer(taskId, answer, actorId);
  }
}
