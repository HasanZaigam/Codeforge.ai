import type { TaskEvent } from "../../domain/types.js";
import type { TaskEventRepository } from "../../persistence/repositories/task-event-repository.js";
import type { DependencyStatus, TaskDependencyRepository } from "../../persistence/repositories/task-dependency-repository.js";

/** Small shared helper so list/detail task routes derive `currentActivity` the same way. */
export function latestEventFor(taskEvents: TaskEventRepository, taskId: string): TaskEvent | undefined {
  const events = taskEvents.listForTask(taskId);
  return events[events.length - 1];
}

/** Small shared helper so every route returning a TaskDTO embeds the same "Depends on: ..." data — see toTaskDTO's `dependencies` field. */
export function dependenciesFor(taskDependencies: TaskDependencyRepository, taskId: string): DependencyStatus[] {
  return taskDependencies.listDependencies(taskId);
}
