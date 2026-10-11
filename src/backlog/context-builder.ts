import type { Project } from "../domain/types.js";
import type { ProjectWorkspaceRepository } from "../persistence/repositories/project-workspace-repository.js";
import type { ProjectContextService } from "../project-workspace/project-context-service.js";
import { loadProjectContextSection } from "../orchestrator/project-context-loader.js";
import type { AnalysisContextSummary, BacklogItem, IndexSummary, SelectionSummary } from "./backlog-types.js";
import { DEFAULT_RANK_CONFIG, rankFiles, type RankConfig, type RankedFile } from "./index-selection.js";
import { countSymbols } from "./repository-index.js";
import type { IndexAccess } from "./repository-index-service.js";
import { buildAnalysisPrompt, PROMPT_LIMITS, type PromptExcerpt } from "./analysis-prompt.js";
import { excerptFor, normalizeRepoPath, type RepositoryInspector } from "./repository-inspector.js";
import { DEFAULT_STRUCTURE_LIMITS, isNoisePath, selectRelevantStructure, tokenize, type RepositorySession, type SelectedStructure } from "./repository-structure.js";

/**
 * Everything analysis knows about the repository for ONE attempt: the open session (listing + blob reads),
 * the inspector that enforces the read budget, and — when neither could be produced — why. Opened and
 * disposed by BacklogAnalysisExecutor; the builder only consumes it.
 */
export interface RepositoryAccess {
  session: RepositorySession | null;
  inspector: RepositoryInspector | null;
  /** Set only when the repository could not be opened — a short, non-secret description. */
  error: string | null;
  /** The revision-bound index for this session's exact revision, when one could be obtained. `null`/absent = select by file name only. */
  index?: IndexAccess | null;
}

export const NO_REPOSITORY_ACCESS: RepositoryAccess = { session: null, inspector: null, error: "no repository structure provider configured" };

export interface BuiltAnalysisContext {
  prompt: string;
  summary: AnalysisContextSummary;
  /** Every path in the (possibly capped) listing. `null` when no listing was available. */
  knownPaths: Set<string> | null;
  /** True when `knownPaths` is a capped prefix of the real listing (absence is then not proof). */
  knownPathsTruncated: boolean;
  /** Set only when the listing could not be produced — a short, non-secret description. */
  structureError: string | null;
  /**
   * The full ranked list of relevant paths that was put in the prompt, and the files whose content was excerpted
   * (Phase 4A.4). Not persisted — `summary.selection` keeps only the top of it. Exposed so retrieval quality can be
   * MEASURED (see src/benchmark/) from exactly what the model is shown.
   */
  selectedPaths: string[];
  excerptedPaths: string[];
}

/** How many files' content the platform pre-selects into the prompt, and how much of each. Small on purpose: excerpts orient the model, they are not the repository. */
export interface ExcerptLimits {
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
}
export const EXCERPT_LIMITS: ExcerptLimits = { maxFiles: 8, maxCharsPerFile: 2200, maxTotalChars: 16_000 };

/** Selection knobs — production passes none; the retrieval benchmark passes presets to MEASURE a change before it is adopted. */
export interface SelectionTuning {
  rank?: Partial<RankConfig>;
  excerpts?: Partial<ExcerptLimits>;
}

/**
 * The bounded context-building abstraction for backlog analysis (see /docs/BACKLOG_INTELLIGENCE.md
 * "Repository awareness" / "Evidence"). Assembles, deterministically and within fixed limits: the backlog
 * item, the project's own Project Context Manifest (the exact loader task execution uses), a selected
 * slice of the repository structure, EXCERPTS OF THE FEW MOST RELEVANT FILES (selected by the platform,
 * read through the RepositoryInspector's budget and secret rules — never chosen by the model), and a
 * bounded list of sibling items. It never sends more than the limits in PROMPT_LIMITS /
 * DEFAULT_STRUCTURE_LIMITS / EXCERPT_LIMITS. A repository failure degrades to "unavailable" — analysis
 * still runs, and says so.
 */
export class BacklogContextBuilder {
  constructor(
    private readonly projectWorkspaces: ProjectWorkspaceRepository,
    private readonly projectContext: ProjectContextService,
    private readonly tuning: SelectionTuning = {},
  ) {}

  async build(project: Project, item: BacklogItem, siblings: BacklogItem[], signal: AbortSignal, repo: RepositoryAccess = NO_REPOSITORY_ACCESS): Promise<BuiltAnalysisContext> {
    const projectContextSection = loadProjectContextSection(project.id, project.name, this.projectWorkspaces, this.projectContext);

    const listing = repo.session?.structure ?? null;
    const queryText = `${item.title}\n${item.description}`;
    let selected: SelectedStructure | null = listing ? selectRelevantStructure(listing, queryText, DEFAULT_STRUCTURE_LIMITS) : null;

    // Which files to show: the revision-bound index (names + declared symbols + routes + feature + imports)
    // when there is one for exactly this revision, else file names alone. Either way the platform decides.
    const usableIndex = repo.index?.state === "used" && repo.index.index && listing ? repo.index.index : null;
    let ranked: RankedFile[] = [];
    if (usableIndex && selected) {
      ranked = rankFiles(usableIndex, queryText, { maxResults: DEFAULT_STRUCTURE_LIMITS.maxRelevantPaths, contextText: projectContextSection, config: { ...DEFAULT_RANK_CONFIG, ...this.tuning.rank } });
      if (ranked.length > 0) selected = { ...selected, relevantPaths: ranked.map((r) => r.path) };
    }
    const method: SelectionSummary["method"] = ranked.length > 0 ? "index" : "name";

    // Excerpts: the platform picks the best-ranked readable files and reads them under the shared budget.
    const limits: ExcerptLimits = { ...EXCERPT_LIMITS, ...this.tuning.excerpts };
    let excerpts: PromptExcerpt[] = [];
    if (repo.session && repo.inspector && selected) {
      const tokens = tokenize(queryText);
      const candidates = selected.relevantPaths.filter((p) => normalizeRepoPath(p) === p && !isNoisePath(p) && repo.inspector!.isReadableCandidate(p));
      let used = 0;
      for (const path of candidates) {
        if (excerpts.length >= limits.maxFiles || used >= limits.maxTotalChars) break;
        const outcome = await repo.inspector.read(path, signal);
        if (!outcome.ok) continue;
        const ex = excerptFor(outcome.file.text, tokens, Math.min(limits.maxCharsPerFile, limits.maxTotalChars - used));
        if (ex.text.length === 0) continue;
        excerpts.push({ path, text: ex.text, truncated: ex.truncated });
        used += ex.text.length;
      }
    }

    // Deterministic order: most recently created siblings first, capped.
    const orderedSiblings = [...siblings].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
    let siblingsIncluded = orderedSiblings.slice(0, PROMPT_LIMITS.maxSiblings);
    let structureIncluded: SelectedStructure | null = selected;

    const render = () =>
      buildAnalysisPrompt({ projectName: project.name, item, siblings: siblingsIncluded, projectContextSection, structure: structureIncluded, excerpts, selectionMethod: method });
    let prompt = render();

    // Over budget: drop siblings from the tail first (least recent), then excerpts (last first), then the relevant-path list, then the outline.
    while (prompt.length > PROMPT_LIMITS.maxPromptChars && siblingsIncluded.length > 0) {
      siblingsIncluded = siblingsIncluded.slice(0, Math.max(0, siblingsIncluded.length - Math.max(1, Math.floor(siblingsIncluded.length / 4))));
      prompt = render();
    }
    while (prompt.length > PROMPT_LIMITS.maxPromptChars && excerpts.length > 0) {
      excerpts = excerpts.slice(0, -1);
      prompt = render();
    }
    if (prompt.length > PROMPT_LIMITS.maxPromptChars && structureIncluded && structureIncluded.relevantPaths.length > 0) {
      structureIncluded = { ...structureIncluded, relevantPaths: [] };
      prompt = render();
    }
    if (prompt.length > PROMPT_LIMITS.maxPromptChars && structureIncluded) {
      structureIncluded = { ...structureIncluded, outline: [] };
      prompt = render();
    }

    const inspection = repo.inspector?.summary(listing ? (listing.truncated ? "truncated" : "complete") : "unavailable");
    return {
      prompt,
      summary: {
        projectContextIncluded: projectContextSection !== null,
        repositoryStructure: listing === null ? "unavailable" : listing.truncated ? "truncated" : "included",
        repositoryFileCount: listing ? listing.totalFiles : null,
        repositoryPathsIncluded: structureIncluded ? structureIncluded.relevantPaths.length + structureIncluded.outline.length : 0,
        contentFilesIncluded: excerpts.length,
        contentBytesRead: inspection?.bytesRead ?? 0,
        index: indexSummary(repo),
        selection: {
          method,
          rankedFiles: structureIncluded?.relevantPaths.length ?? 0,
          top: (method === "index" ? ranked : (selected?.relevantPaths ?? []).map((path) => ({ path, score: 0, reasons: ["name"] }))).slice(0, 12).map((r) => ({ path: r.path, score: r.score, reasons: r.reasons.slice(0, 5) })),
          excerptPaths: excerpts.map((e) => e.path),
        },
        siblingItemsIncluded: siblingsIncluded.length,
        siblingItemsOmitted: siblings.length - siblingsIncluded.length,
        promptChars: prompt.length,
      },
      selectedPaths: structureIncluded?.relevantPaths ?? [],
      excerptedPaths: excerpts.map((e) => e.path),
      knownPaths: repo.session ? new Set(repo.session.structure.paths) : null,
      knownPathsTruncated: listing?.truncated ?? false,
      structureError: repo.error,
    };
  }
}

/** The index's contribution to one analysis, recorded on it — state and counts only. */
function indexSummary(repo: RepositoryAccess): IndexSummary {
  const access = repo.index;
  if (!access) return { state: "disabled", revision: repo.session?.revision ?? null, built: false, files: null, contentIndexedFiles: null, symbols: null, complete: null, reason: "no repository index configured" };
  const idx = access.index;
  return {
    state: access.state,
    revision: repo.session?.revision ?? null,
    built: access.built,
    files: idx ? idx.files.length : null,
    contentIndexedFiles: idx ? idx.coverage.contentIndexedFiles : null,
    symbols: idx ? countSymbols(idx) : null,
    complete: idx ? idx.coverage.complete : null,
    reason: access.reason,
  };
}
