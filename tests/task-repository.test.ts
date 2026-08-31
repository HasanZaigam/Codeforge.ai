import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { TaskRepository } from "../src/persistence/repositories/task-repository.js";
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

test("insert + findById round-trips a task", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const found = tasks.findById(task.id);
  assert.ok(found);
  assert.equal(found?.status, "TODO");
  assert.equal(found?.goal, "G");
  assert.deepEqual(found?.taskRecord.decisions, []);
});

test("claimTodo is atomic: only one of two racing claims wins", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const now = new Date().toISOString();

  const claimA = tasks.claimTodo(task.id, "worker-a", 60_000, now);
  const claimB = tasks.claimTodo(task.id, "worker-b", 60_000, now);

  assert.equal(claimA, true);
  assert.equal(claimB, false, "second claim on an already-claimed task must fail");
  assert.equal(tasks.findById(task.id)?.status, "WORKING");
});

test("claimTodo fails once status has moved past TODO", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const now = new Date().toISOString();
  tasks.claimTodo(task.id, "worker-a", 60_000, now);

  assert.equal(tasks.claimTodo(task.id, "worker-c", 60_000, now), false);
});

test("claimWorking succeeds for the same owner (lease renewal) and for a new owner after expiry", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const t0 = new Date().toISOString();
  tasks.claimTodo(task.id, "worker-a", 1000, t0); // 1s lease

  assert.equal(tasks.claimWorking(task.id, "worker-a", 1000, t0), true, "same owner may renew");

  const other = tasks.claimWorking(task.id, "worker-b", 1000, t0);
  assert.equal(other, false, "different owner cannot claim while lease is live");

  const later = new Date(new Date(t0).getTime() + 5000).toISOString();
  assert.equal(tasks.claimWorking(task.id, "worker-b", 1000, later), true, "a different owner may claim once the lease expires");
});

test("findOrphanedWorking finds only tasks whose lease has expired", async () => {
  const { tasks, events, project } = await setup();
  const task = createTask(tasks, events, { tenantId: "default", projectId: project.id, title: "T", goal: "G", createdBy: null });
  const t0 = new Date().toISOString();
  tasks.claimTodo(task.id, "worker-a", 1000, t0);

  assert.equal(tasks.findOrphanedWorking(t0).length, 0);

  const later = new Date(new Date(t0).getTime() + 5000).toISOString();
  const orphaned = tasks.findOrphanedWorking(later);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0]?.id, task.id);
});
