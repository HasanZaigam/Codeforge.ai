import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPlatform } from "../src/platform.js";
import { createReadyTask } from "./helpers/create-ready-task.js";
import { createSelfFixDemoEngine } from "../src/cli/fixture-engine-handlers.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { LocalGitWorkspaceProvider } from "../src/workspace/local-git-workspace-provider.js";
import { WorkspaceRepository } from "../src/persistence/repositories/workspace-repository.js";
import type { Project } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * Multi-user workspace isolation — part of the production-readiness/security
 * milestone's audit (see /docs/SECURITY_ARCHITECTURE.md "Multi-user
 * isolation audit"). The audit traced `LocalGitWorkspaceProvider.provision`
 * (src/workspace/local-git-workspace-provider.ts) and found workspace paths
 * are derived exclusively from `Task.id` (a `randomUUID()`, never from a
 * project name, `owner`/`repo`, or any other user-supplied string) — so two
 * users' tasks can never collide on a workspace directory, and a malicious
 * `owner`/`repo` value can never cause the workspace path itself to escape
 * `<WORKSPACES_ROOT>/<taskId>`. The test below runs both tasks to completion
 * SEQUENTIALLY (`await executeTask(A)` then `await executeTask(B)`) against
 * the same real provider/WORKSPACES_ROOT — it proves taskId-derived path
 * isolation (distinct, non-colliding, non-escaping paths; no cross-user
 * content), NOT concurrent provisioning safety; nothing here actually
 * overlaps in time. See the separate "concurrent fresh-workspace
 * provisioning" test further below for a genuine, real-overlap version of
 * that second claim, exercised directly against `LocalGitWorkspaceProvider`.
 */
test("two different users' tasks get distinct, taskId-derived workspace directories under the same WORKSPACES_ROOT — never a collision or cross-user path", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-isolation-"));
  const workspacesRoot = join(root, "workspaces");
  const engine = createSelfFixDemoEngine();

  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot,
    engine,
    ownerId: "test-worker",
  });

  const repoPathA = await createFixtureRepo(await mkdtemp(join(tmpdir(), "repo-a-")));
  // Deliberately adversarial-looking name/repo values — path traversal
  // segments and characters that would be dangerous if they ever flowed into
  // a filesystem path instead of only into git command arguments.
  const repoPathB = await createFixtureRepo(await mkdtemp(join(tmpdir(), "repo-b-")));

  const now = new Date().toISOString();

  const userA = { id: randomUUID(), tenantId: "default", email: "usera@example.com", name: "User A", passwordHash: "", createdAt: now };
  const userB = { id: randomUUID(), tenantId: "default", email: "userb@example.com", name: "User B", passwordHash: "", createdAt: now };
  platform.users.insert(userA);
  platform.users.insert(userB);

  function makeProject(ownerId: string, name: string, repoUrl: string): Project {
    return {
      id: randomUUID(),
      tenantId: "default",
      ownerId,
      name,
      repoUrl,
      defaultBranch: "main",
      codingEngine: engine.key,
      sourceControlProvider: "local-git",
      owner: "../../etc",
      repo: "passwd; rm -rf /",
      commands: { test: "node test.js" },
      createdAt: now,
      updatedAt: now,
    };
  }

  const projectA = makeProject(userA.id, "User A's project", repoPathA);
  const projectB = makeProject(userB.id, "User B's project", repoPathB);
  platform.projects.insert(projectA);
  platform.projects.insert(projectB);

  const taskA = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: projectA.id,
    title: "Task A",
    goal: "Fix add()",
    createdBy: userA.id,
  });
  const taskB = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: projectB.id,
    title: "Task B",
    goal: "Fix add()",
    createdBy: userB.id,
  });

  // Run both to completion — both use the same in-process fixture engine and
  // the same real LocalGitWorkspaceProvider/WORKSPACES_ROOT, exactly as two
  // concurrent worker-claimed tasks from two different users would.
  await platform.orchestrator.executeTask(taskA.id);
  await platform.orchestrator.executeTask(taskB.id);

  const workspaceA = platform.workspaces.findByTaskId(taskA.id);
  const workspaceB = platform.workspaces.findByTaskId(taskB.id);
  assert.ok(workspaceA, "expected task A to have a provisioned workspace");
  assert.ok(workspaceB, "expected task B to have a provisioned workspace");

  // Exact expected shape: <WORKSPACES_ROOT>/<taskId> — nothing derived from
  // project name, owner, or repo.
  assert.equal(workspaceA!.path, join(workspacesRoot, taskA.id));
  assert.equal(workspaceB!.path, join(workspacesRoot, taskB.id));

  // Never collide, never escape the intended root.
  assert.notEqual(workspaceA!.path, workspaceB!.path);
  assert.ok(workspaceA!.path.startsWith(workspacesRoot + "/"));
  assert.ok(workspaceB!.path.startsWith(workspacesRoot + "/"));
  assert.ok(existsSync(workspaceA!.path));
  assert.ok(existsSync(workspaceB!.path));

  // Task A's workspace never contains task B's clone (and vice versa) — each
  // is its own independent git checkout, not a shared/nested directory.
  assert.ok(!existsSync(join(workspaceA!.path, taskB.id)));
  assert.ok(!existsSync(join(workspaceB!.path, taskA.id)));
});

/**
 * Genuine concurrent fresh-workspace provisioning — two DIFFERENT taskIds (never-before-seen, so
 * both are the "fresh clone" path in `LocalGitWorkspaceProvider.provision`, not the
 * `idempotent-reuse-if-ready` early return that same-taskId re-provisioning takes; that reuse case
 * — a newer generation's claim racing an older one's provisioning attempt for the SAME task — is
 * already covered by tests/concurrency.test.ts test 18's `claimForGeneration` coverage, and is
 * explicitly out of scope here). Calls the real `LocalGitWorkspaceProvider` directly (not through
 * the full Orchestrator — provisioning itself, not task execution, is what's under test) with two
 * `provision()` calls launched together via `Promise.all`, so their `git clone`/`mkdir`/`rm`
 * child-process work (all real async I/O — see `execFileAsync` in the provider) genuinely
 * interleaves on Node's event loop, unlike the sequential test above. Proves: both provisions
 * succeed independently, land at distinct taskId-derived paths, each ends up with exactly its own
 * repo's content (never the other's, never a corrupted/partial mix), and neither's `rm`/`mkdir`
 * "clean slate" step (which targets only `<root>/<taskId>`) can ever touch the other's directory,
 * since the two paths never overlap.
 */
test("two different tasks' fresh workspaces, provisioned concurrently via Promise.all against the same real LocalGitWorkspaceProvider, never corrupt, share, or destroy each other's workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-concurrent-"));
  const workspacesRoot = join(root, "workspaces");
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot,
    engine: createSelfFixDemoEngine(),
    ownerId: "test-worker",
  });
  const workspaceRepo = new WorkspaceRepository(platform.db);
  const provider = new LocalGitWorkspaceProvider(workspacesRoot, workspaceRepo);

  // Two distinct fixture repos with distinguishable content, so cross-contamination (task A ending
  // up with task B's clone or vice versa) would be directly observable, not just "some repo or other."
  const repoDirA = await mkdtemp(join(tmpdir(), "concurrent-repo-a-"));
  const repoDirB = await mkdtemp(join(tmpdir(), "concurrent-repo-b-"));
  const repoPathA = await createFixtureRepo(repoDirA);
  const repoPathB = await createFixtureRepo(repoDirB);
  await writeFile(join(repoPathA, "MARKER.txt"), "repo-a\n");
  await execFileAsync("git", ["add", "MARKER.txt"], { cwd: repoPathA });
  await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "-m", "marker a"], { cwd: repoPathA });
  await writeFile(join(repoPathB, "MARKER.txt"), "repo-b\n");
  await execFileAsync("git", ["add", "MARKER.txt"], { cwd: repoPathB });
  await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "-m", "marker b"], { cwd: repoPathB });

  // Real Task rows are required (workspaces.task_id is a foreign key) — a project each, so the
  // two tasks are otherwise unrelated, exactly like two independent tasks a worker might dispatch
  // together. Only `provision()` itself (not full task execution) is under test here.
  const now = new Date().toISOString();
  const owner = { id: randomUUID(), tenantId: "default", email: "concurrent-owner@example.com", name: "Owner", passwordHash: "", createdAt: now };
  platform.users.insert(owner);
  const project = (repoUrl: string, name: string): Project => ({
    id: randomUUID(),
    tenantId: "default",
    ownerId: owner.id,
    name,
    repoUrl,
    defaultBranch: "main",
    codingEngine: "fixture",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  });
  const projectA = project(repoPathA, "Concurrent Project A");
  const projectB = project(repoPathB, "Concurrent Project B");
  platform.projects.insert(projectA);
  platform.projects.insert(projectB);
  const taskA = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: projectA.id,
    title: "Concurrent Task A",
    goal: "n/a — provisioning-only test",
    createdBy: null,
  });
  const taskB = createReadyTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: projectB.id,
    title: "Concurrent Task B",
    goal: "n/a — provisioning-only test",
    createdBy: null,
  });
  const taskIdA = taskA.id;
  const taskIdB = taskB.id;

  const [workspaceA, workspaceB] = await Promise.all([
    provider.provision({ taskId: taskIdA, repoUrl: repoPathA, baseBranch: "main", taskBranch: `task/${taskIdA}` }),
    provider.provision({ taskId: taskIdB, repoUrl: repoPathB, baseBranch: "main", taskBranch: `task/${taskIdB}` }),
  ]);

  assert.equal(workspaceA.status, "ready");
  assert.equal(workspaceB.status, "ready");
  assert.equal(workspaceA.path, join(workspacesRoot, taskIdA));
  assert.equal(workspaceB.path, join(workspacesRoot, taskIdB));
  assert.notEqual(workspaceA.path, workspaceB.path);

  const markerA = await readFile(join(workspaceA.path, "MARKER.txt"), "utf-8");
  const markerB = await readFile(join(workspaceB.path, "MARKER.txt"), "utf-8");
  assert.equal(markerA, "repo-a\n", "task A's workspace must contain exactly repo A's content, never repo B's");
  assert.equal(markerB, "repo-b\n", "task B's workspace must contain exactly repo B's content, never repo A's");

  // Each ended up on its own isolated task branch, created from its own clone — never
  // cross-wired to the other task's branch name or base commit.
  const branchA = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceA.path });
  const branchB = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceB.path });
  assert.equal(branchA.stdout.trim(), `task/${taskIdA}`);
  assert.equal(branchB.stdout.trim(), `task/${taskIdB}`);

  // Persisted rows agree with what's on disk, and each workspace directory contains only itself.
  assert.equal(workspaceRepo.findByTaskId(taskIdA)?.status, "ready");
  assert.equal(workspaceRepo.findByTaskId(taskIdB)?.status, "ready");
  assert.ok(!existsSync(join(workspaceA.path, taskIdB)));
  assert.ok(!existsSync(join(workspaceB.path, taskIdA)));
});
