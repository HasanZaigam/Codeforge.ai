import type { TaskEvent } from "../../domain/types.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";

/** Small shared helper so list/detail task routes derive `currentActivity` the same way. */
export function latestEventFor(taskEvents: TaskEventRepository, taskId: string): TaskEvent | undefined {
  const events = taskEvents.listForTask(taskId);
  return events[events.length - 1];
}
