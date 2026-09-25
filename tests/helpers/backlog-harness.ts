import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform, type BuildPlatformOptions, type Platform } from "../../src/platform.js";
import { buildApplicationServices, type ApplicationServices } from "../../src/application/index.js";
import { createFixtureRepo } from "../../src/cli/fixture-repo.js";
import type { CodingEngine, EngineInvocationRequest, EngineInvocationResult } from "../../src/coding-engine/coding-engine.js";
import type { RepositoryEntry, RepositorySession, RepositoryStructureProvider } from "../../src/backlog/repository-structure.js";
import type { BacklogItem } from "../../src/backlog/backlog-types.js";
import type { CostMetadata, Project, User } from "../../src/domain/types.js";

/**
 * Test-only harness for the Phase 4A (Backlog Intelligence) suites. Not picked up by the
 * `tests/**\/*.test.ts` glob (no `.test.ts` suffix). Nothing here is a fake PROVIDER — the engine is a
 * scripted `CodingEngine` (the same interface the real adapters implement, exactly like the existing
 * FixtureCodingEngine), and the structure provider is a deterministic in-memory listing.
 */

/** A schema-valid analysis payload; override any field. */
export function validAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "OTP requests are not rate limited, so a number can be spammed with SMS.",
    issueType: "bug",
    affectedApplication: "backend-api",
    suspectedArea: "auth / OTP service",
    candidateFiles: [{ path: "src/auth/otp.js", reason: "sends and validates OTPs" }],
    duplicateCandidates: [],
    dependencyCandidates: [],
    missingInformation: [],
    suggestedAcceptanceCriteria: ["A single number can request at most 5 OTPs per hour"],
    suggestedValidation: ["Add a unit test covering the limiter"],
    confidence: { overall: "medium", uncertainties: ["Unclear whether the limit is per number or per IP"] },
    claims: [],
    ...overrides,
  };
}

export const json = (value: unknown): string => JSON.stringify(value);

export type Respond = (request: EngineInvocationRequest, callIndex: number) => Promise<string> | string;

/** Records every invocation and answers with whatever `respond` returns (or throws). */
export class ScriptedEngine implements CodingEngine {
  readonly calls: EngineInvocationRequest[] = [];
  /** The usage the scripted "provider" reports for each call. `null` = the engine reported no usage at all. */
  cost: CostMetadata | null = { inputTokens: 100, outputTokens: 200, costUsd: 0.001, durationMs: 5 };
  constructor(
    public respond: Respond,
    readonly key: string = "fixture",
  ) {}

  async run(request: EngineInvocationRequest): Promise<EngineInvocationResult> {
    const index = this.calls.length;
    this.calls.push(request);
    const summary = await this.respond(request, index);
    return {
      result: { status: "completed", summary, filesChanged: [], diffRef: null, confidence: null, findings: [], needsInput: null },
      cost: this.cost,
      logExcerpt: "",
    };
  }
}

export interface FakeRepositoryProvider extends RepositoryStructureProvider {
  /** How many sessions were opened. */
  calls: number;
  /** Every path `readBlob` was actually asked for (i.e. reached the "repository"), in order. */
  reads: string[];
  /** How many sessions were disposed. */
  disposed: number;
  /** The commit the NEXT opened session reports. Assign to simulate the repository moving to a new revision. */
  revision: string | null;
  /** Replaces one file's content (a new revision's content) — takes effect for sessions opened afterwards. */
  files: Record<string, string | Buffer>;
}

/**
 * A deterministic in-memory repository. `files` is a list of paths (each gets a tiny placeholder body) or a
 * `path -> content` map. `modes` overrides git file modes (e.g. `120000` symlink); `sizes` overrides the
 * size the listing reports (to test limits without huge bodies). Nothing here is a fake PROVIDER of AI —
 * it stands in for `git`, exactly as the real session reads blobs by exact listed path.
 */
export function fakeStructure(
  files: string[] | Record<string, string | Buffer>,
  opts: { truncated?: boolean; modes?: Record<string, string>; sizes?: Record<string, number>; failOpen?: boolean; revision?: string | null } = {},
): FakeRepositoryProvider {
  const map: Record<string, string | Buffer> = Array.isArray(files) ? Object.fromEntries(files.map((p) => [p, `// ${p}\n`])) : files;
  const provider: FakeRepositoryProvider = {
    calls: 0,
    reads: [],
    disposed: 0,
    revision: opts.revision === undefined ? "a".repeat(40) : opts.revision,
    files: map,
    async open(): Promise<RepositorySession> {
      provider.calls++;
      if (opts.failOpen) throw new Error("git clone failed: repository not found");
      const sessionPaths = Object.keys(map).sort();
      const entries = new Map<string, RepositoryEntry>(
        sessionPaths.map((path) => [path, { path, mode: opts.modes?.[path] ?? "100644", size: opts.sizes?.[path] ?? Buffer.byteLength(map[path]!) }]),
      );
      return {
        revision: provider.revision,
        structure: { paths: sessionPaths, totalFiles: sessionPaths.length, truncated: opts.truncated ?? false },
        entries,
        async readBlob(path: string): Promise<Buffer> {
          provider.reads.push(path);
          if (!entries.has(path)) throw new Error("path is not in the repository listing");
          const body = map[path]!;
          return Buffer.isBuffer(body) ? body : Buffer.from(body);
        },
        async dispose(): Promise<void> {
          provider.disposed++;
        },
      };
    },
  };
  return provider;
}

export const DEFAULT_PATHS = ["README.md", "package.json", "src/auth/otp.js", "src/auth/session.js", "src/profile/profile.js", "src/payments/payment.js", "test/otp.test.js"];

export interface BacklogHarness {
  root: string;
  dbPath: string;
  platform: Platform;
  services: ApplicationServices;
  engine: ScriptedEngine;
  owner: User;
  project: Project;
  /** Registers another user (with no access to `project`). */
  addUser(label: string): User;
  /** Creates a backlog item as `owner` (or `actor`). */
  item(title: string, ref?: string, description?: string, actor?: User): BacklogItem;
  /**
   * Enqueues an analysis as `owner`, then runs THIS platform's worker-side runner until nothing more is
   * runnable (a job scheduled for a later retry is not waited for). Returns the refreshed item. The
   * API-side call never runs a model — the drain is the "worker" step.
   */
  analyze(itemId: string, actor?: User): Promise<BacklogItem>;
  /** analyze -> generate proposal -> approve, returning the approved proposal id. */
  approvedProposal(itemId: string): Promise<string>;
  /** Builds a SECOND platform + services over the same database file (a second API/worker process), for multi-process concurrency tests. */
  secondProcess(engine?: ScriptedEngine): { platform: Platform; services: ApplicationServices };
  close(): void;
}

export interface BacklogHarnessOptions {
  respond?: Respond;
  structure?: RepositoryStructureProvider | null;
  platform?: Partial<BuildPlatformOptions>;
  /** Reuse an existing root/db (a second harness over the same data). */
  root?: string;
}

export async function setupBacklogHarness(label: string, options: BacklogHarnessOptions = {}): Promise<BacklogHarness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), `backlog-${label}-`)));
  const dbPath = join(root, "platform.sqlite");
  const engine = new ScriptedEngine(options.respond ?? (() => json(validAnalysis())));
  const structure = options.structure === undefined ? fakeStructure(DEFAULT_PATHS) : options.structure;

  const platform = buildPlatform({
    dbPath,
    workspacesRoot: join(root, "workspaces"),
    projectWorkspacesRoot: join(root, "project-workspaces"),
    engine,
    ownerId: `test-worker-${label}`,
    repositoryStructureProvider: structure,
    ...options.platform,
  });
  const services = buildApplicationServices(platform);
  const repoPath = await createFixtureRepo(root);

  const addUser = (name: string): User => {
    const user: User = { id: randomUUID(), tenantId: "default", email: `${name}-${randomUUID().slice(0, 6)}@example.com`, name, passwordHash: "", createdAt: new Date().toISOString() };
    platform.users.insert(user);
    return user;
  };
  const owner = addUser(`owner-${label}`);
  const project = await services.projects.create(
    { name: "Jinvani", sourceControlProvider: "local-git", repoUrl: repoPath, codingEngine: "fixture", commands: { test: "node test.js" } },
    owner.id,
  );

  const harness: BacklogHarness = {
    root,
    dbPath,
    platform,
    services,
    engine,
    owner,
    project,
    addUser,
    item: (title, ref, description, actor = owner) =>
      services.backlog.createItem(project.id, { title, description: description ?? `${title} — details`, externalRef: ref ?? null }, actor.id),
    analyze: async (itemId, actor = owner) => {
      services.backlog.requestAnalysis(itemId, actor.id);
      await platform.backlogRunner.drain();
      return platform.backlogItems.findById(itemId)!;
    },
    approvedProposal: async (itemId) => {
      await harness.analyze(itemId);
      const { proposal } = services.backlog.generateProposal(itemId, owner.id);
      services.backlog.approveProposal(proposal.id, owner.id);
      return proposal.id;
    },
    secondProcess: (eng = new ScriptedEngine(options.respond ?? (() => json(validAnalysis())))) => {
      const p2 = buildPlatform({
        dbPath,
        workspacesRoot: join(root, "workspaces-2"),
        projectWorkspacesRoot: join(root, "project-workspaces"),
        engine: eng,
        ownerId: `test-worker-${label}-2`,
        repositoryStructureProvider: structure,
        ...options.platform,
      });
      return { platform: p2, services: buildApplicationServices(p2) };
    },
    close: () => {
      try {
        platform.db.close();
      } catch {
        // already closed
      }
    },
  };
  return harness;
}
