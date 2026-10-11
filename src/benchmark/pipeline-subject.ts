import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BacklogItem } from "../backlog/backlog-types.js";
import { BacklogContextBuilder, type RepositoryAccess, type SelectionTuning } from "../backlog/context-builder.js";
import { buildRepositoryIndex, sourceKeyOf, type RepositoryIndex } from "../backlog/repository-index.js";
import { RepositoryInspector } from "../backlog/repository-inspector.js";
import type { RepositorySession } from "../backlog/repository-structure.js";
import type { Project } from "../domain/types.js";
import { openLocalGitSession } from "./local-git-session.js";
import type { GroundTruthItem, SelectionOutput, SelectionSubject } from "./retrieval-benchmark.js";

/**
 * The PRODUCTION selection pipeline (`BacklogContextBuilder`: ranking + excerpt choice under the real limits) run
 * over a local repository at each item's revision — so the benchmark measures exactly what an analysis would show
 * the model, not a re-implementation. `useIndex: false` is the file-name-only baseline (no index supplied ⇒ the
 * builder falls back to name relevance), so the two subjects differ ONLY in the index.
 */
export function createPipelineSubject(repoDir: string, options: { useIndex: boolean; name?: string; tuning?: SelectionTuning; indexes?: Map<string, Promise<RepositoryIndex>>; cacheDir?: string }): SelectionSubject {
  const builder = new BacklogContextBuilder({ findByProjectId: () => null } as never, {} as never, options.tuning);
  // Indexes are shared between subjects (same revision ⇒ same index); optionally cached on disk, keyed by a hash of the
  // extractor's own source so an extraction change can never be served a stale index.
  const indexes = options.indexes ?? new Map<string, Promise<RepositoryIndex>>();
  const extractorHash = options.cacheDir ? createHash("sha256").update(readFileSync(new URL("../backlog/repository-index.ts", import.meta.url))).digest("hex").slice(0, 12) : "";
  const signal = new AbortController().signal;
  const project = { id: "benchmark", name: "benchmark", repoUrl: repoDir, defaultBranch: "main" } as Project;

  const indexFor = (session: RepositorySession): Promise<RepositoryIndex> => {
    const rev = session.revision!;
    if (!indexes.has(rev)) {
      const file = options.cacheDir ? join(options.cacheDir, `${rev}-${extractorHash}.json`) : null;
      indexes.set(
        rev,
        (async () => {
          if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as RepositoryIndex;
          const built = await buildRepositoryIndex(session, sourceKeyOf(project), signal);
          if (file) {
            mkdirSync(options.cacheDir!, { recursive: true });
            writeFileSync(file, JSON.stringify(built));
          }
          return built;
        })(),
      );
    }
    return indexes.get(rev)!;
  };

  return {
    name: options.name ?? (options.useIndex ? "index" : "name-only"),
    async select(item: GroundTruthItem): Promise<SelectionOutput> {
      const session = await openLocalGitSession(repoDir, item.revision);
      try {
        const access: RepositoryAccess = { session, inspector: new RepositoryInspector(session), error: null };
        if (options.useIndex) {
          const index = await indexFor(session);
          access.index = { state: "used", index, built: false, reason: null };
        }
        const backlogItem: BacklogItem = {
          id: item.id, projectId: project.id, externalRef: item.id, title: item.title, description: item.description,
          source: "manual", status: "NEW", createdBy: "benchmark", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z",
        };
        const ctx = await builder.build(project, backlogItem, [], signal, access);
        return { candidates: ctx.selectedPaths, excerpts: ctx.excerptedPaths, method: ctx.summary.selection?.method ?? "name" };
      } finally {
        await session.dispose();
      }
    },
  };
}
