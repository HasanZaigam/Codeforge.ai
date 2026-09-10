import { createTask, type CreateTaskInput } from "../../src/orchestrator/task-factory.js";
import type { TaskRepository } from "../../src/persistence/repositories/task-repository.js";
import type { TaskEventRepository } from "../../src/persistence/repositories/task-event-repository.js";
import type { Task } from "../../src/domain/types.js";

/**
 * Test-only convenience: creates a task exactly like `createTask` (the
 * production factory) always has, then immediately performs the new
 * BACKLOG -> TODO release step a human normally triggers via "Start Task"
 * (see /docs/TASK_LIFECYCLE.md "Task lifecycle") so it's picked up by the
 * worker/orchestrator exactly like every pre-existing test in this suite
 * already assumed. Tests that specifically want to exercise the BACKLOG gate
 * itself should call `createTask` directly instead — see
 * tests/task-repository.test.ts and tests/branch-mode.test.ts.
 */
export function createReadyTask(tasks: TaskRepository, events: TaskEventRepository, input: CreateTaskInput): Task {
  const task = createTask(tasks, events, input);
  const now = new Date().toISOString();
  const released = tasks.releaseFromBacklog(task.id, now);
  if (!released) {
    throw new Error(`createReadyTask: failed to release task ${task.id} from BACKLOG`);
  }
  return tasks.findById(task.id)!;
}
