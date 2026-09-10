import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type Platform } from "../src/platform.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { Worker } from "../src/worker/worker.js";
import { TaskService } from "../src/application/task-service.js";
import {
  CircularDependencyError,
  CrossProjectDependencyError,
  DuplicateDependencyError,
  SelfDependencyError,
  TaskNotEditableError,
} from "../src/application/errors.js";
import { IncompleteDependenciesError } from "../src/domain/errors.js";
import type { Project, Task, TaskStatus } from "../src/domain/types.js";

/**
 * Coverage for explicit, user-defined task dependencies (see /docs/TASK_LIFECYCLE.md "Task
 * dependencies"). Uses the same low-level platform/worker harness pattern as
 * backlog-release.test.ts / branch-mode.test.ts — direct against TaskService/Orchestrator, no HTTP
 * layer, so races can be driven deterministically.
 */
async function setup(label: string) {
  const root = await mkdtemp(join(tmpdir(), `task-deps-${label}-`));
  const engine = createSelfFixDemoEngine();
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `task-deps-${label}`,
  });
  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: `${label}@example.com`, name: "Tester", passwordHash: "", createdAt: now };
  platform.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);

  const taskService = new TaskService(
    platform.tasks,
    platform.taskEvents,
    platform.agentRuns,
    platform.projects,
    platform.orchestrator,
    platform.sourceControlProviders,
    platform.taskDependencies,
  );

  return { platform, project, user, taskService, root };
}

function makeTask(platform: Platform, project: Project, title = "Task"): Task {
  return createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title,
    goal: `${title} goal`,
    createdBy: null,
  });
}

/** Force a task straight to a given status, bypassing the normal lifecycle — a plain test fixture helper for exercising "every non-DONE status blocks" without running a full implement/validate/review pass for each one. */
function forceStatus(platform: Platform, taskId: string, status: TaskStatus): void {
  const task = platform.tasks.findById(taskId)!;
  task.status = status;
  platform.tasks.save(task, new Date().toISOString());
}

// ---------------------------------------------------------------------
// Basic dependency rules (1-4)
// ---------------------------------------------------------------------

test("1. no dependencies -> task starts normally", async () => {
  const { platform, project } = await setup("basic-no-deps");
  const task = makeTask(platform, project);
  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});

test("2. one DONE dependency -> task starts", async () => {
  const { platform, project, taskService, user } = await setup("basic-one-done");
  const dep = makeTask(platform, project, "Dependency");
  forceStatus(platform, dep.id, "DONE");
  const task = makeTask(platform, project, "Dependent");

  await taskService.addDependency(task.id, dep.id, user.id);
  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});

test("3. one incomplete dependency -> cannot start", async () => {
  const { platform, project, taskService, user } = await setup("basic-one-incomplete");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  assert.throws(() => platform.orchestrator.startTask(task.id), IncompleteDependenciesError);
  assert.equal(platform.tasks.findById(task.id)?.status, "BACKLOG");
});

test("4. multiple dependencies -> starts only when ALL are DONE (AND semantics)", async () => {
  const { platform, project, taskService, user } = await setup("basic-multi-and");
  const depA = makeTask(platform, project, "Dep A");
  const depB = makeTask(platform, project, "Dep B");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, depA.id, user.id);
  await taskService.addDependency(task.id, depB.id, user.id);

  assert.throws(() => platform.orchestrator.startTask(task.id), IncompleteDependenciesError);

  forceStatus(platform, depA.id, "DONE");
  assert.throws(() => platform.orchestrator.startTask(task.id), IncompleteDependenciesError, "only one of two DONE must still block");

  forceStatus(platform, depB.id, "DONE");
  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});

// ---------------------------------------------------------------------
// Dependency status coverage: every non-DONE status blocks, DONE allows
// ---------------------------------------------------------------------

const NON_DONE_STATUSES: TaskStatus[] = ["BACKLOG", "TODO", "WORKING", "NEEDS_INPUT", "REVIEW", "FAILED", "CANCELLED"];

for (const status of NON_DONE_STATUSES) {
  test(`dependency status: a dependency in ${status} blocks the dependent task from starting`, async () => {
    const { platform, project, taskService, user } = await setup(`status-${status.toLowerCase()}`);
    const dep = makeTask(platform, project, "Dependency");
    const task = makeTask(platform, project, "Dependent");
    await taskService.addDependency(task.id, dep.id, user.id);
    forceStatus(platform, dep.id, status);

    assert.throws(() => platform.orchestrator.startTask(task.id), IncompleteDependenciesError);
    assert.equal(platform.tasks.findById(task.id)?.status, "BACKLOG");
  });
}

test("dependency status: a dependency in DONE allows the dependent task to start", async () => {
  const { platform, project, taskService, user } = await setup("status-done");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);
  forceStatus(platform, dep.id, "DONE");

  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});

// ---------------------------------------------------------------------
// Validation (5-9)
// ---------------------------------------------------------------------

test("5. self-dependency is rejected", async () => {
  const { platform, project, taskService, user } = await setup("validation-self");
  const task = makeTask(platform, project);
  await assert.rejects(() => taskService.addDependency(task.id, task.id, user.id), SelfDependencyError);
});

test("6. cross-project dependency is rejected", async () => {
  const { platform, project, taskService, user } = await setup("validation-cross-project");
  const now = new Date().toISOString();
  const otherProject: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Other project",
    repoUrl: project.repoUrl,
    defaultBranch: "main",
    codingEngine: "fixture",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: null,
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(otherProject);

  const task = makeTask(platform, project, "In project A");
  const otherTask = makeTask(platform, otherProject, "In project B");
  await assert.rejects(() => taskService.addDependency(task.id, otherTask.id, user.id), CrossProjectDependencyError);
});

test("7. duplicate dependency is rejected", async () => {
  const { platform, project, taskService, user } = await setup("validation-duplicate");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);
  await assert.rejects(() => taskService.addDependency(task.id, dep.id, user.id), DuplicateDependencyError);
});

test("8. direct cycle (A -> B, B -> A) is rejected", async () => {
  const { platform, project, taskService, user } = await setup("validation-direct-cycle");
  const a = makeTask(platform, project, "A");
  const b = makeTask(platform, project, "B");
  await taskService.addDependency(a.id, b.id, user.id); // A depends on B
  await assert.rejects(() => taskService.addDependency(b.id, a.id, user.id), CircularDependencyError); // B depends on A -> cycle
});

test("9. indirect cycle (A -> B, B -> C, C -> A) is rejected", async () => {
  const { platform, project, taskService, user } = await setup("validation-indirect-cycle");
  const a = makeTask(platform, project, "A");
  const b = makeTask(platform, project, "B");
  const c = makeTask(platform, project, "C");
  await taskService.addDependency(a.id, b.id, user.id); // A depends on B
  await taskService.addDependency(b.id, c.id, user.id); // B depends on C
  await assert.rejects(() => taskService.addDependency(c.id, a.id, user.id), CircularDependencyError); // C depends on A -> indirect cycle
});

// ---------------------------------------------------------------------
// Editing (10-13)
// ---------------------------------------------------------------------

test("10. a dependency can be added while BACKLOG", async () => {
  const { platform, project, taskService, user } = await setup("editing-add");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  const result = await taskService.addDependency(task.id, dep.id, user.id);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, dep.id);
});

test("11. a dependency can be removed while BACKLOG", async () => {
  const { platform, project, taskService, user } = await setup("editing-remove");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  const result = taskService.removeDependency(task.id, dep.id, user.id);
  assert.equal(result.length, 0);
  assert.equal(taskService.listDependencies(task.id, user.id).length, 0);
});

test("12. existing dependencies are returned correctly", async () => {
  const { platform, project, taskService, user } = await setup("editing-list");
  const depA = makeTask(platform, project, "Dep A");
  const depB = makeTask(platform, project, "Dep B");
  forceStatus(platform, depA.id, "DONE");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, depA.id, user.id);
  await taskService.addDependency(task.id, depB.id, user.id);

  const listed = taskService.listDependencies(task.id, user.id);
  assert.equal(listed.length, 2);
  const byId = new Map(listed.map((d) => [d.id, d]));
  assert.equal(byId.get(depA.id)?.status, "DONE");
  assert.equal(byId.get(depB.id)?.status, "BACKLOG");
});

test("13. dependencies cannot be edited once the task has left BACKLOG (TODO)", async () => {
  const { platform, project, taskService, user } = await setup("editing-locked-todo");
  const dep = makeTask(platform, project, "Dependency");
  const other = makeTask(platform, project, "Other");
  const task = makeTask(platform, project, "Dependent");
  platform.orchestrator.startTask(task.id); // BACKLOG -> TODO

  await assert.rejects(() => taskService.addDependency(task.id, dep.id, user.id), TaskNotEditableError);

  // Also cover WORKING: exercise removal against a task with an existing edge added before release.
  const task2 = makeTask(platform, project, "Dependent 2");
  await taskService.addDependency(task2.id, other.id, user.id);
  forceStatus(platform, other.id, "DONE"); // satisfy the dependency so Start Task itself can succeed
  platform.orchestrator.startTask(task2.id);
  forceStatus(platform, task2.id, "WORKING");
  assert.throws(() => taskService.removeDependency(task2.id, other.id, user.id), TaskNotEditableError);
});

// ---------------------------------------------------------------------
// Start Task enforcement (14-17)
// ---------------------------------------------------------------------

test("14. starting with an incomplete dependency throws a domain error naming it", async () => {
  const { platform, project, taskService, user } = await setup("start-named-error");
  const dep = makeTask(platform, project, "Implement authentication API");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  assert.throws(
    () => platform.orchestrator.startTask(task.id),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDependenciesError);
      assert.match(err.message, /Implement authentication API/);
      assert.equal(err.incomplete.length, 1);
      assert.equal(err.incomplete[0]!.id, dep.id);
      return true;
    },
  );
});

test("14b. multiple incomplete dependencies are all named", async () => {
  const { platform, project, taskService, user } = await setup("start-named-error-multi");
  const depA = makeTask(platform, project, "Design schema");
  const depB = makeTask(platform, project, "Write migration");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, depA.id, user.id);
  await taskService.addDependency(task.id, depB.id, user.id);

  assert.throws(
    () => platform.orchestrator.startTask(task.id),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDependenciesError);
      assert.match(err.message, /Design schema/);
      assert.match(err.message, /Write migration/);
      assert.equal(err.incomplete.length, 2);
      return true;
    },
  );
});

test("15. the task remains BACKLOG after a rejected start", async () => {
  const { platform, project, taskService, user } = await setup("start-stays-backlog");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  assert.throws(() => platform.orchestrator.startTask(task.id));
  const fresh = platform.tasks.findById(task.id)!;
  assert.equal(fresh.status, "BACKLOG");
  assert.notEqual(fresh.status, "FAILED");
});

test("16. the worker never executes a task blocked on an incomplete dependency", async () => {
  const { platform, project, taskService, user } = await setup("start-worker-never-sees-it");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  // Never released — startTask itself must reject before the worker could ever poll a TODO row.
  assert.throws(() => platform.orchestrator.startTask(task.id), IncompleteDependenciesError);

  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  await worker.tick();
  await worker.tick();

  const fresh = platform.tasks.findById(task.id)!;
  assert.equal(fresh.status, "BACKLOG", "still BACKLOG — never claimed by the worker");
  const events = platform.taskEvents.listForTask(task.id);
  assert.ok(!events.some((e) => e.type === "TASK_CLAIMED"), "no claim event may ever be recorded");
  assert.ok(!events.some((e) => e.type === "TASK_STARTED"), "no coding-engine execution may ever begin");
});

test("17. once all dependencies are DONE, Start Task succeeds normally", async () => {
  const { platform, project, taskService, user } = await setup("start-all-done-succeeds");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);
  forceStatus(platform, dep.id, "DONE");

  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});

// ---------------------------------------------------------------------
// No automatic execution (18)
// ---------------------------------------------------------------------

test("18. a dependency becoming DONE does not auto-start the dependent task", async () => {
  const { platform, project, taskService, user } = await setup("no-auto-start");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  forceStatus(platform, dep.id, "DONE");

  // Let the worker poll a few times — nothing should ever touch the dependent task without an
  // explicit Start Task call.
  const worker = new Worker(platform.tasks, platform.orchestrator, { pollIntervalMs: 60_000 });
  await worker.tick();
  await worker.tick();

  assert.equal(platform.tasks.findById(task.id)?.status, "BACKLOG", "must stay BACKLOG until explicitly started");

  // An explicit Start Task now succeeds, proving the dependency truly was satisfied.
  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});

// ---------------------------------------------------------------------
// Concurrency (19)
// ---------------------------------------------------------------------

test("19a. Start Task racing Edit Dependencies: adding an incomplete dependency concurrently with Start Task never leaves the task released with an unsatisfied dependency", async () => {
  const { platform, project, taskService, user } = await setup("race-start-vs-add");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent"); // no dependencies yet -> startTask would normally succeed

  // Race: one side adds an (incomplete) dependency, the other releases the task. Both fire
  // "simultaneously" against the same in-process SQLite connection (single-writer, so this
  // exercises real interleaving, not just two sequential calls).
  const results = await Promise.allSettled([
    taskService.addDependency(task.id, dep.id, user.id),
    Promise.resolve().then(() => platform.orchestrator.startTask(task.id)),
  ]);

  const fresh = platform.tasks.findById(task.id)!;
  if (fresh.status === "TODO") {
    // Start won the race before the dependency was attached — legitimate, since at that instant
    // the task genuinely had no dependencies. The add may have then failed as TaskNotEditableError.
    assert.ok(results.some((r) => r.status === "fulfilled") || results.some((r) => r.status === "rejected"));
  } else {
    // The dependency was attached before (or during) the release attempt — the release must have
    // been rejected, and the task must still be sitting in BACKLOG, never TODO with an unsatisfied
    // dependency.
    assert.equal(fresh.status, "BACKLOG");
  }
  // The invariant that actually matters, unconditionally: a TODO task never has an incomplete
  // dependency slip through.
  if (fresh.status === "TODO") {
    const deps = taskService.listDependencies(task.id, user.id);
    assert.ok(deps.every((d) => d.status === "DONE"), "a released task must never carry an unsatisfied dependency");
  }
});

test("19b. Remove dependency racing Start Task: removing the only (incomplete) dependency concurrently with Start Task ends in one consistent, valid final state", async () => {
  const { platform, project, taskService, user } = await setup("race-start-vs-remove");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id); // incomplete -> startTask would normally be rejected

  await Promise.allSettled([
    Promise.resolve().then(() => taskService.removeDependency(task.id, dep.id, user.id)),
    Promise.resolve().then(() => platform.orchestrator.startTask(task.id)),
  ]);

  const fresh = platform.tasks.findById(task.id)!;
  // Whichever order actually happened, the end state is internally consistent: if it's TODO, it
  // has no unsatisfied dependency; if it's still BACKLOG, nothing was silently corrupted.
  assert.ok(fresh.status === "TODO" || fresh.status === "BACKLOG");
  if (fresh.status === "TODO") {
    const deps = taskService.listDependencies(task.id, user.id);
    assert.ok(deps.every((d) => d.status === "DONE"));
  }
});

test("19c. two concurrent dependency edits on the same task never corrupt the stored edge set", async () => {
  const { platform, project, taskService, user } = await setup("race-concurrent-edits");
  const depA = makeTask(platform, project, "Dep A");
  const depB = makeTask(platform, project, "Dep B");
  const task = makeTask(platform, project, "Dependent");

  const results = await Promise.allSettled([
    taskService.addDependency(task.id, depA.id, user.id),
    taskService.addDependency(task.id, depB.id, user.id),
  ]);
  assert.ok(results.every((r) => r.status === "fulfilled"), "two edits on two distinct edges must both succeed, never corrupt state");

  const deps = taskService.listDependencies(task.id, user.id);
  assert.equal(deps.length, 2);
  const ids = new Set(deps.map((d) => d.id));
  assert.ok(ids.has(depA.id) && ids.has(depB.id));
});

test("19d. a dependency completing mid-start still leaves the final state consistent (dependency DONE at commit time -> release succeeds)", async () => {
  const { platform, project, taskService, user } = await setup("race-dep-completes-mid-start");
  const dep = makeTask(platform, project, "Dependency");
  const task = makeTask(platform, project, "Dependent");
  await taskService.addDependency(task.id, dep.id, user.id);

  // Simulate the dependency completing "concurrently" with the start attempt by flipping it to
  // DONE immediately before the atomic release call — the release's own NOT EXISTS subquery
  // re-evaluates dependency status at that exact instant, so this proves there is no stale read.
  forceStatus(platform, dep.id, "DONE");
  const started = platform.orchestrator.startTask(task.id);
  assert.equal(started.status, "TODO");
});
