import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryEntry, RepositorySession } from "../backlog/repository-structure.js";
import { BlobTooLargeError, parseLsTree } from "../backlog/repository-structure.js";

const run = promisify(execFile);

/**
 * A read-only `RepositorySession` over an EXISTING local git repository at an EXACT revision — used by the retrieval
 * benchmark to replay backlog items against the repository as it was when the item was raised (never the moved-on
 * HEAD, where the fix already exists). Same contract as the production session: contents are read from the object
 * store by exact listed path, so there is no checkout, no traversal and no symlink to follow; the RepositoryInspector
 * still enforces every safety limit on top. It never fetches, clones, writes or changes the repository.
 */
export async function openLocalGitSession(repoDir: string, revision: string): Promise<RepositorySession> {
  if (!/^[0-9a-f]{7,64}$/.test(revision)) throw new Error("revision must be a hex commit id");
  const { stdout: full } = await run("git", ["-C", repoDir, "rev-parse", "--verify", `${revision}^{commit}`]);
  const sha = full.trim();
  const { stdout } = await run("git", ["-C", repoDir, "ls-tree", "-r", "-z", sha], { maxBuffer: 256 * 1024 * 1024 });
  const all = parseLsTree(stdout).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = new Map<string, RepositoryEntry>(all.map((e) => [e.path, e]));
  return {
    revision: sha,
    structure: { paths: all.map((e) => e.path), totalFiles: all.length, truncated: false },
    entries,
    async readBlob(path, maxBytes) {
      if (!entries.has(path)) throw new Error("path is not in the repository listing");
      try {
        const { stdout: buf } = await run("git", ["-C", repoDir, "cat-file", "blob", `${sha}:${path}`], { encoding: "buffer", maxBuffer: maxBytes + 1024 });
        return buf as Buffer;
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new BlobTooLargeError();
        throw err;
      }
    },
    async dispose() {},
  };
}
