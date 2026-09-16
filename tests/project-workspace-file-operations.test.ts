import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile as writeFileAsync, mkdir as mkdirAsync, symlink, readFile as readFileAsync } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectWorkspaceFsManager,
  ProjectWorkspacePathError,
  ProjectWorkspaceFileNotFoundError,
  ProjectWorkspaceFileTooLargeError,
  ProjectWorkspaceWriteTooLargeError,
  ProjectWorkspaceSymlinkEscapeError,
  MAX_PROJECT_WORKSPACE_READ_BYTES,
  MAX_PROJECT_WORKSPACE_WRITE_BYTES,
} from "../src/project-workspace/project-workspace-fs-manager.js";

/**
 * Coverage for Phase 3 — Project Workspace, Slice 4 (safe relative-path file operations layered on
 * top of ProjectWorkspaceFsManager — see that module's own doc comment). No HTTP endpoints exist
 * for this slice (see docs/API.md), so every test here exercises the manager directly.
 *
 * Every test uses its own mkdtemp root — no shared global filesystem state between tests.
 */

async function newManager(label: string): Promise<{ manager: ProjectWorkspaceFsManager; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `pw-fileops-${label}-`));
  const manager = new ProjectWorkspaceFsManager(root);
  return { manager, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ================================================================================================
// 1. Path resolution
// ================================================================================================

test("Slice 4: resolveFilePath accepts a valid root-relative file path", async () => {
  const { manager, cleanup } = await newManager("resolve-root");
  try {
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    assert.equal(manager.resolveFilePath(id, "README.md"), join(dir, "README.md"));
  } finally {
    await cleanup();
  }
});

test("Slice 4: resolveFilePath accepts a valid nested file path", async () => {
  const { manager, cleanup } = await newManager("resolve-nested");
  try {
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    assert.equal(manager.resolveFilePath(id, "src/index.ts"), join(dir, "src", "index.ts"));
    assert.equal(manager.resolveFilePath(id, "docs/architecture.md"), join(dir, "docs", "architecture.md"));
    assert.equal(manager.resolveFilePath(id, "config/settings.json"), join(dir, "config", "settings.json"));
  } finally {
    await cleanup();
  }
});

test("Slice 4: resolveFilePath rejects ../ and ../../ traversal", async () => {
  const { manager, cleanup } = await newManager("resolve-traversal");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    assert.throws(() => manager.resolveFilePath(id, "../secret.txt"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, "../../etc/passwd"), ProjectWorkspacePathError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: resolveFilePath rejects absolute Unix and Windows-style paths", async () => {
  const { manager, cleanup } = await newManager("resolve-absolute");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    assert.throws(() => manager.resolveFilePath(id, "/absolute/path.txt"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, "/tmp/file.txt"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, "C:\\Windows\\file.txt"), ProjectWorkspacePathError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: resolveFilePath rejects normalized traversal and bare '.'/'..'", async () => {
  const { manager, cleanup } = await newManager("resolve-normalized");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    assert.throws(() => manager.resolveFilePath(id, "a/../../etc"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, "src/../../../etc/passwd"), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, "."), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, ".."), ProjectWorkspacePathError);
    assert.throws(() => manager.resolveFilePath(id, "workspace-id/../../etc"), ProjectWorkspacePathError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: a percent-encoded traversal-like string is treated as a literal (safe) filename, never decoded into a traversal", async () => {
  const { manager, cleanup } = await newManager("resolve-encoded");
  try {
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    // No HTTP layer exists in this slice to URL-decode input before it reaches the manager (see
    // docs/API.md), so a string like "..%2f..%2fetc" is just an unusual — but perfectly safe —
    // literal path segment name here, not a traversal attempt. It must resolve INSIDE the
    // workspace, exactly like any other single segment.
    const resolved = manager.resolveFilePath(id, "..%2f..%2fetc");
    assert.equal(resolved, join(dir, "..%2f..%2fetc"));
  } finally {
    await cleanup();
  }
});

// ================================================================================================
// 2. Reading
// ================================================================================================

test("Slice 4: readFile reads an existing file's UTF-8 content", async () => {
  const { manager, cleanup } = await newManager("read-existing");
  try {
    const id = randomUUID();
    manager.writeFile(id, "README.md", "hello project workspace");
    assert.equal(manager.readFile(id, "README.md"), "hello project workspace");
  } finally {
    await cleanup();
  }
});

test("Slice 4: readFile on a missing file throws ProjectWorkspaceFileNotFoundError", async () => {
  const { manager, cleanup } = await newManager("read-missing");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    assert.throws(() => manager.readFile(id, "does-not-exist.txt"), ProjectWorkspaceFileNotFoundError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: readFile refuses to read a directory as a file", async () => {
  const { manager, cleanup } = await newManager("read-directory");
  try {
    const id = randomUUID();
    manager.writeFile(id, "src/index.ts", "content");
    assert.throws(() => manager.readFile(id, "src"), ProjectWorkspaceFileNotFoundError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: readFile rejects a file over MAX_PROJECT_WORKSPACE_READ_BYTES without loading it fully", async () => {
  const { manager, root, cleanup } = await newManager("read-oversized");
  try {
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    // Written directly via node:fs, bypassing writeFile's own size guard, to construct an
    // already-oversized file on disk (simulating one that predates this size limit).
    writeFileSync(join(dir, "huge.txt"), "x".repeat(MAX_PROJECT_WORKSPACE_READ_BYTES + 1));
    assert.throws(() => manager.readFile(id, "huge.txt"), ProjectWorkspaceFileTooLargeError);
    void root;
  } finally {
    await cleanup();
  }
});

// ================================================================================================
// 3. Writing
// ================================================================================================

test("Slice 4: writeFile creates a new file", async () => {
  const { manager, cleanup } = await newManager("write-create");
  try {
    const id = randomUUID();
    manager.writeFile(id, "notes.txt", "first draft");
    assert.equal(manager.readFile(id, "notes.txt"), "first draft");
  } finally {
    await cleanup();
  }
});

test("Slice 4: writeFile overwrites an existing file", async () => {
  const { manager, cleanup } = await newManager("write-overwrite");
  try {
    const id = randomUUID();
    manager.writeFile(id, "notes.txt", "first draft");
    manager.writeFile(id, "notes.txt", "second draft");
    assert.equal(manager.readFile(id, "notes.txt"), "second draft");
  } finally {
    await cleanup();
  }
});

test("Slice 4: writeFile creates missing nested parent directories", async () => {
  const { manager, cleanup } = await newManager("write-nested");
  try {
    const id = randomUUID();
    manager.writeFile(id, "src/a/b.txt", "nested content");
    assert.equal(manager.readFile(id, "src/a/b.txt"), "nested content");
    const listing = manager.listDirectory(id);
    assert.deepEqual(listing, [{ name: "src", type: "directory" }]);
  } finally {
    await cleanup();
  }
});

test("Slice 4: writeFile creating a nested file never affects unrelated existing files", async () => {
  const { manager, cleanup } = await newManager("write-isolated");
  try {
    const id = randomUUID();
    manager.writeFile(id, "README.md", "untouched");
    manager.writeFile(id, "config/settings.json", "{}");

    manager.writeFile(id, "src/a/b.txt", "new nested file");

    assert.equal(manager.readFile(id, "README.md"), "untouched", "unrelated root file must survive");
    assert.equal(manager.readFile(id, "config/settings.json"), "{}", "unrelated existing directory/file must survive");
    assert.equal(manager.readFile(id, "src/a/b.txt"), "new nested file");
  } finally {
    await cleanup();
  }
});

test("Slice 4: writeFile rejects oversized content before writing anything to disk", async () => {
  const { manager, cleanup } = await newManager("write-oversized");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    const oversized = "x".repeat(MAX_PROJECT_WORKSPACE_WRITE_BYTES + 1);
    assert.throws(() => manager.writeFile(id, "huge.txt", oversized), ProjectWorkspaceWriteTooLargeError);
    assert.throws(() => manager.readFile(id, "huge.txt"), ProjectWorkspaceFileNotFoundError, "the oversized write must never have happened");
  } finally {
    await cleanup();
  }
});

test("Slice 4: writeFile rejects a traversal path without writing anything", async () => {
  const { manager, root, cleanup } = await newManager("write-traversal");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    assert.throws(() => manager.writeFile(id, "../escape.txt", "malicious"), ProjectWorkspacePathError);
    const outside = join(root, "escape.txt");
    await assert.rejects(() => readFileAsync(outside, "utf-8"), /ENOENT/);
  } finally {
    await cleanup();
  }
});

// ================================================================================================
// 4. Listing
// ================================================================================================

test("Slice 4: listDirectory lists the ProjectWorkspace root when relativePath is omitted", async () => {
  const { manager, cleanup } = await newManager("list-root");
  try {
    const id = randomUUID();
    manager.writeFile(id, "README.md", "x");
    manager.writeFile(id, "src/index.ts", "x");
    assert.deepEqual(manager.listDirectory(id), [
      { name: "README.md", type: "file" },
      { name: "src", type: "directory" },
    ]);
  } finally {
    await cleanup();
  }
});

test("Slice 4: listDirectory lists a nested directory", async () => {
  const { manager, cleanup } = await newManager("list-nested");
  try {
    const id = randomUUID();
    manager.writeFile(id, "src/a.ts", "x");
    manager.writeFile(id, "src/b.ts", "x");
    manager.writeFile(id, "src/sub/c.ts", "x");
    assert.deepEqual(manager.listDirectory(id, "src"), [
      { name: "a.ts", type: "file" },
      { name: "b.ts", type: "file" },
      { name: "sub", type: "directory" },
    ]);
  } finally {
    await cleanup();
  }
});

test("Slice 4: listDirectory returns deterministic (name-sorted) ordering regardless of creation order", async () => {
  const { manager, cleanup } = await newManager("list-order");
  try {
    const id = randomUUID();
    manager.writeFile(id, "zeta.txt", "x");
    manager.writeFile(id, "alpha.txt", "x");
    manager.writeFile(id, "mid.txt", "x");
    const names = manager.listDirectory(id).map((e) => e.name);
    assert.deepEqual(names, ["alpha.txt", "mid.txt", "zeta.txt"]);
  } finally {
    await cleanup();
  }
});

test("Slice 4: listDirectory correctly distinguishes files from directories", async () => {
  const { manager, cleanup } = await newManager("list-types");
  try {
    const id = randomUUID();
    manager.writeFile(id, "a-file.txt", "x");
    manager.writeFile(id, "a-dir/inner.txt", "x");
    const entries = manager.listDirectory(id);
    assert.equal(entries.find((e) => e.name === "a-file.txt")?.type, "file");
    assert.equal(entries.find((e) => e.name === "a-dir")?.type, "directory");
  } finally {
    await cleanup();
  }
});

test("Slice 4: listDirectory never returns absolute filesystem paths", async () => {
  const { manager, root, cleanup } = await newManager("list-no-abs-paths");
  try {
    const id = randomUUID();
    manager.writeFile(id, "README.md", "x");
    const entries = manager.listDirectory(id);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ["name", "type"]);
      assert.ok(!entry.name.includes(root), "entry name must never embed the host filesystem root");
      assert.ok(!entry.name.startsWith("/"), "entry name must never be an absolute path");
    }
  } finally {
    await cleanup();
  }
});

// ================================================================================================
// 5. Isolation
// ================================================================================================

test("Slice 4: a sibling ProjectWorkspace cannot be accessed via traversal", async () => {
  const { manager, cleanup } = await newManager("isolation-sibling");
  try {
    const idA = randomUUID();
    const idB = randomUUID();
    manager.writeFile(idB, "secret.txt", "belongs to B only");
    assert.throws(() => manager.resolveFilePath(idA, `../${idB}/secret.txt`), ProjectWorkspacePathError);
    assert.throws(() => manager.readFile(idA, `../${idB}/secret.txt`), ProjectWorkspacePathError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: the task-execution WORKSPACES_ROOT cannot be reached from a ProjectWorkspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-fileops-isolation-workspaces-"));
  try {
    const projectWorkspacesRoot = join(root, "project-workspaces");
    const workspacesRoot = join(root, "workspaces"); // sibling dir, mirroring platform.ts's default layout
    await mkdirAsync(workspacesRoot, { recursive: true });
    await writeFileAsync(join(workspacesRoot, "task-secret.txt"), "task execution data");

    const manager = new ProjectWorkspaceFsManager(projectWorkspacesRoot);
    const id = randomUUID();
    manager.ensureWorkspace(id);

    assert.throws(() => manager.resolveFilePath(id, "../workspaces/task-secret.txt"), ProjectWorkspacePathError);
    assert.throws(() => manager.readFile(id, "../workspaces/task-secret.txt"), ProjectWorkspacePathError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Slice 4: an arbitrary filesystem location cannot be accessed", async () => {
  const { manager, cleanup } = await newManager("isolation-arbitrary");
  try {
    const id = randomUUID();
    manager.ensureWorkspace(id);
    assert.throws(() => manager.readFile(id, "/etc/passwd"), ProjectWorkspacePathError);
    assert.throws(() => manager.writeFile(id, "/etc/passwd", "x"), ProjectWorkspacePathError);
  } finally {
    await cleanup();
  }
});

test("Slice 4: workspace ids remain isolated from each other under the same manager", async () => {
  const { manager, cleanup } = await newManager("isolation-ids");
  try {
    const idA = randomUUID();
    const idB = randomUUID();
    manager.writeFile(idA, "file.txt", "A's content");
    manager.writeFile(idB, "file.txt", "B's content");
    assert.equal(manager.readFile(idA, "file.txt"), "A's content");
    assert.equal(manager.readFile(idB, "file.txt"), "B's content");
  } finally {
    await cleanup();
  }
});

// ================================================================================================
// 6. Symlink security
// ================================================================================================

test("Slice 4: a symlink inside a ProjectWorkspace pointing outside it cannot be read through", async () => {
  const { manager, cleanup } = await newManager("symlink-read");
  const external = await mkdtemp(join(tmpdir(), "pw-fileops-external-"));
  try {
    await writeFileAsync(join(external, "passwd"), "outside-secret-data");
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    await symlink(external, join(dir, "escape-link"));

    assert.throws(() => manager.readFile(id, "escape-link/passwd"), ProjectWorkspaceSymlinkEscapeError);
  } finally {
    await cleanup();
    await rm(external, { recursive: true, force: true });
  }
});

test("Slice 4: a symlink inside a ProjectWorkspace pointing outside it cannot be written through", async () => {
  const { manager, cleanup } = await newManager("symlink-write");
  const external = await mkdtemp(join(tmpdir(), "pw-fileops-external-write-"));
  try {
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    await symlink(external, join(dir, "escape-link"));

    assert.throws(() => manager.writeFile(id, "escape-link/injected.txt", "malicious"), ProjectWorkspaceSymlinkEscapeError);

    // Confirm nothing landed in the external directory the symlink pointed to.
    await assert.rejects(() => readFileAsync(join(external, "injected.txt"), "utf-8"), /ENOENT/);
  } finally {
    await cleanup();
    await rm(external, { recursive: true, force: true });
  }
});

test("Slice 4: chosen policy — even a symlink pointing to another file inside the SAME ProjectWorkspace is rejected, not silently followed", async () => {
  const { manager, cleanup } = await newManager("symlink-internal-policy");
  try {
    const id = randomUUID();
    const dir = manager.ensureWorkspace(id);
    manager.writeFile(id, "real.txt", "real content");
    await symlink(join(dir, "real.txt"), join(dir, "internal-link.txt"));

    // Deliberate, documented policy (see assertNoSymlinksInPath's doc comment): this manager
    // refuses ALL symlinks inside a ProjectWorkspace unconditionally, even ones that would resolve
    // to somewhere harmless inside the same workspace — simpler and strictly safer than trying to
    // classify "safe" vs "escaping" symlinks case by case.
    assert.throws(() => manager.readFile(id, "internal-link.txt"), ProjectWorkspaceSymlinkEscapeError);
  } finally {
    await cleanup();
  }
});

// ================================================================================================
// 7. Persistence / restart
// ================================================================================================

test("Slice 4: a file written by one manager instance is readable by a freshly-constructed manager pointed at the same root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-fileops-persist-"));
  try {
    const id = randomUUID();
    const managerBefore = new ProjectWorkspaceFsManager(root);
    managerBefore.writeFile(id, "notes/todo.md", "- [ ] ship Slice 4");

    // Simulates a process restart: brand-new manager instance, no shared in-memory state.
    const managerAfter = new ProjectWorkspaceFsManager(root);
    assert.equal(managerAfter.readFile(id, "notes/todo.md"), "- [ ] ship Slice 4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
