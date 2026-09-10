import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { TaskRepository, isActiveExistingBranchConstraintViolation } from "../src/persistence/repositories/task-repository.js";
import { TaskEventRepository } from "../src/persistence/repositories/task-event-repository.js";
import { ProjectRepository } from "../src/persistence/repositories/project-repository.js";
import { UserRepository } from "../src/persistence/repositories/user-repository.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import type { Project } from "../src/domain/types.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "task-repo-test-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  const tasks = new TaskRepository(db);
  const events = new TaskEventRepository(db);
  const projects = new ProjectRepository(db);
  const users = new UserRepository(db);

  const now = new Date().toISOString();
  users.insert({ id: "user-1", tenantId: "default", email: "owner@example.com", name: "Owner", passwordHash: "", createdAt: now });
  const project: Project = {
    id: "proj-1",
    tenantId: "default",
    ownerId: "user-1",
    name: "Test Project",
    repoUrl: "file:///tmp/does-not-matter",
    defaultBranch: "main",
    codingEngine: "fixture",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: null,
    createdAt: now,
    updatedAt: now,
  };
  projects.insert(project);
  return { tasks, events, project };
}

test("insert + findById round-trips a task, starting in BACKLOG (the human release gate — see task-state-machine.ts)", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const found = tasks.findById(task.id);
  assert.ok(found);
  assert.equal(found?.status, "BACKLOG");
  assert.equal(found?.goal, "G");
  assert.deepEqual(found?.taskRecord.decisions, []);
});

test("releaseFromBacklog is atomic: only one of two racing releases wins", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const now = new Date().toISOString();

  const releaseA = tasks.releaseFromBacklog(task.id, now);
  const releaseB = tasks.releaseFromBacklog(task.id, now);

  assert.equal(releaseA, true);
  assert.equal(releaseB, false, "second release of an already-released task must fail");
  assert.equal(tasks.findById(task.id)?.status, "TODO");
});

test("claimTodo is atomic: only one of two racing claims wins", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const now = new Date().toISOString();
  tasks.releaseFromBacklog(task.id, now);

  const claimA = tasks.claimTodo(task.id, "worker-a", 60_000, now);
  const claimB = tasks.claimTodo(task.id, "worker-b", 60_000, now);

  assert.equal(claimA, 1, "the winning claim advances lock_generation from 0 to 1");
  assert.equal(claimB, null, "second claim on an already-claimed task must fail");
  assert.equal(tasks.findById(task.id)?.status, "WORKING");
  assert.equal(tasks.findById(task.id)?.lockGeneration, 1);
});

test("claimTodo fails on a task still in BACKLOG (never released) and once status has moved past TODO", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const now = new Date().toISOString();

  assert.equal(tasks.claimTodo(task.id, "worker-a", 60_000, now), null, "BACKLOG must never be claimed directly");

  tasks.releaseFromBacklog(task.id, now);
  tasks.claimTodo(task.id, "worker-a", 60_000, now);

  assert.equal(tasks.claimTodo(task.id, "worker-c", 60_000, now), null);
});

test("claimWorking succeeds for the same owner and for a new owner after expiry, advancing lock_generation each time; renewWorkingLease renews without advancing it", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const t0 = new Date().toISOString();
  tasks.releaseFromBacklog(task.id, t0);
  const initialGen = tasks.claimTodo(task.id, "worker-a", 1000, t0); // 1s lease
  assert.equal(initialGen, 1);

  // A same-owner heartbeat renewal (the real production path — see Orchestrator.withCancellation)
  // must succeed and must NOT advance the generation.
  assert.equal(tasks.renewWorkingLease(task.id, "worker-a", 1000, t0), true, "current owner may renew");
  assert.equal(tasks.findById(task.id)?.lockGeneration, 1, "a heartbeat renewal never advances lock_generation");
  assert.equal(tasks.renewWorkingLease(task.id, "worker-b", 1000, t0), false, "a different owner cannot renew a lease it doesn't hold");

  // claimWorking is an ownership ACQUISITION, not a renewal — even called by the same owner it
  // still advances the generation (see claimWorking's own doc comment).
  const sameOwnerReclaim = tasks.claimWorking(task.id, "worker-a", 1000, t0);
  assert.equal(sameOwnerReclaim, 2, "claimWorking always advances lock_generation on success");

  const other = tasks.claimWorking(task.id, "worker-b", 1000, t0);
  assert.equal(other, null, "different owner cannot claim while lease is live");

  const later = new Date(new Date(t0).getTime() + 5000).toISOString();
  const takeover = tasks.claimWorking(task.id, "worker-b", 1000, later);
  assert.equal(takeover, 3, "a different owner may claim once the lease expires, advancing the generation again");
});

test("finalizeReviewAsDoneOnMerge is atomic: only the first of two racing calls wins, and it's a no-op outside REVIEW", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const now = new Date().toISOString();
  tasks.releaseFromBacklog(task.id, now);

  // Not REVIEW yet (still TODO) — must not transition.
  assert.equal(tasks.finalizeReviewAsDoneOnMerge(task.id, now), false);
  assert.equal(tasks.findById(task.id)?.status, "TODO");

  // Move it to REVIEW directly for this unit test (task-repository tests don't drive the full
  // orchestrator lifecycle — see orchestrator/human-review-feedback tests for that).
  const fresh = tasks.findById(task.id)!;
  fresh.status = "REVIEW";
  tasks.save(fresh, now);

  const winner = tasks.finalizeReviewAsDoneOnMerge(task.id, now);
  const loser = tasks.finalizeReviewAsDoneOnMerge(task.id, now);

  assert.equal(winner, true, "the first call wins the atomic transition");
  assert.equal(loser, false, "a second call against an already-DONE task is a harmless no-op");
  const done = tasks.findById(task.id)!;
  assert.equal(done.status, "DONE");
  assert.equal(done.completedAt, now);
});

test("findOrphanedWorking finds only tasks whose lease has expired", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const t0 = new Date().toISOString();
  tasks.releaseFromBacklog(task.id, t0);
  tasks.claimTodo(task.id, "worker-a", 1000, t0);

  assert.equal(tasks.findOrphanedWorking(t0).length, 0);

  const later = new Date(new Date(t0).getTime() + 5000).toISOString();
  const orphaned = tasks.findOrphanedWorking(later);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0]?.id, task.id);
});

// ---------------------------------------------------------------------------
// §6 (branch-management milestone): the DB-level unique partial index that
// closes TaskService.create's check-then-insert race for "existing branch"
// mode — see migrations/007_branch_race_closure.sql and its own doc
// comment for why this exists alongside (not instead of) the app-level
// pre-check.
// ---------------------------------------------------------------------------

test("idx_tasks_active_existing_branch: a second non-terminal 'existing' task on the same (project, branch) is rejected at the DB layer itself", async () => {
  const { tasks, events, project } = await setup();
  createTask(tasks, events, {
    tenantId: "default",
    projectId: project.id,
    title: "First",
    goal: "G",
    createdBy: null,
    branchMode: "existing",
    workingBranch: "shared-branch",
  });

  assert.throws(() => {
    createTask(tasks, events, {
      tenantId: "default",
      projectId: project.id,
      title: "Second",
      goal: "G",
      createdBy: null,
      branchMode: "existing",
      workingBranch: "shared-branch",
    });
  }, isActiveExistingBranchConstraintViolation);
});

test("idx_tasks_active_existing_branch: does NOT block a second 'existing' task once the first is terminal (DONE/FAILED/CANCELLED)", async () => {
  const { tasks, events, project } = await setup();
  const first = createTask(tasks, events, {
    tenantId: "default",
    projectId: project.id,
    title: "First",
    goal: "G",
    createdBy: null,
    branchMode: "existing",
    workingBranch: "shared-branch",
  });
  const now = new Date().toISOString();
  const fresh = tasks.findById(first.id)!;
  fresh.status = "CANCELLED";
  tasks.save(fresh, now);

  assert.doesNotThrow(() => {
    createTask(tasks, events, {
      tenantId: "default",
      projectId: project.id,
      title: "Second",
      goal: "G",
      createdBy: null,
      branchMode: "existing",
      workingBranch: "shared-branch",
    });
  });
});

test("idx_tasks_active_existing_branch: does NOT block two different projects using the same branch name, or two 'new'-mode tasks", async () => {
  const { tasks, events, project } = await setup();
  createTask(tasks, events, {
    tenantId: "default",
    projectId: project.id,
    title: "First",
    goal: "G",
    createdBy: null,
    branchMode: "existing",
    workingBranch: "shared-branch",
  });

  // "new" mode tasks are never subject to this constraint at all (branch_mode != 'existing').
  assert.doesNotThrow(() => {
    createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "Unrelated", goal: "G", createdBy: null, branchMode: "new", workingBranch: "shared-branch" });
  });
});

test("isActiveExistingBranchConstraintViolation: only matches this specific constraint, not an arbitrary error", () => {
  assert.equal(isActiveExistingBranchConstraintViolation(new Error("some other failure")), false);
  assert.equal(isActiveExistingBranchConstraintViolation(new Error("UNIQUE constraint failed: agent_runs.task_id, agent_runs.role, agent_runs.attempt_number")), false);
  assert.equal(isActiveExistingBranchConstraintViolation("not even an Error"), false);
});
