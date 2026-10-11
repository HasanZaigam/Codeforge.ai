import type { Task, TaskStatus } from "../domain/types.js";
import { ALL_TASK_STATUSES, type ContextLayerService, type TaskCounts, type TaskListItem } from "./context-layer.js";
import type { ActionLayerService, ActionResult } from "./action-layer.js";
import type { ChatPendingAction } from "../persistence/repositories/chat-repository.js";
import type { BacklogItem } from "../backlog/backlog-types.js";

// ---------------------------------------------------------------------------

export type ParsedIntent =
  | { type: "TASK_SUMMARY"; status?: TaskStatus; clause: string }
  | { type: "TASKS_BY_STATUS"; status: TaskStatus; clause: string }
  | { type: "TASKS_RECENT"; clause: string }
  | { type: "ATTENTION_SUMMARY"; clause: string }
  | { type: "OLDEST_TASK_BY_STATUS"; status: TaskStatus; includeBlocking: boolean; clause: string }
  | { type: "TASK_HANDOFF"; taskId: string; clause: string }
  | { type: "TASK_CHANGES"; taskId: string; clause: string }
  | { type: "TASK_VALIDATION"; taskId: string; clause: string }
  | { type: "TASK_MODEL_USAGE"; taskId: string; clause: string }
  | { type: "TASK_ORIGIN"; taskId: string; clause: string }
  | { type: "TASK_EXECUTION"; taskId: string; clause: string }
  | { type: "TASK_FAILURE_REASON"; taskId: string; clause: string }
  | { type: "TASK_RETRY_ELIGIBILITY"; taskId: string; clause: string }
  | { type: "UPLOAD_SUMMARY"; importId: string; clause: string }
  | { type: "UPLOAD_COUNT_ITEMS"; importId: string; statusFilter?: string[]; clause: string }
  | { type: "UPLOAD_LIST_ITEMS"; importId: string; statusFilter?: string[]; clause: string }
  // Phase 4D.5 — the GitHub Pull Request state, DELIBERATELY a separate intent/data source from
  // TaskStatus — see ContextLayerService.getTaskPullRequestStatus's own doc comment.
  | { type: "TASK_PR_STATUS"; taskId: string; clause: string }
  | { type: "WORKSPACE_CONTEXT"; clause: string }
  | { type: "ACTION_CREATE_TASK"; title: string; description: string; clause: string }
  | { type: "ACTION_EDIT_TITLE"; taskId: string; taskTitle: string; newTitle: string; clause: string }
  | { type: "ACTION_START_TASK"; taskId: string; taskTitle: string; clause: string }
  | { type: "ACTION_CANCEL_TASK"; taskId: string; taskTitle: string; clause: string }
  // Phase 4D.4 — `taskStatus` is the status observed at PARSE time (resolveActionTarget/the oldest-in-status
  // lookup already has it on hand). `executeAction` uses it ONLY to decide whether to propose a
  // confirmation (REVIEW) or go straight to the existing honest-decline path (everything else) — it is
  // NEVER itself trusted as the basis for a mutation; the real decision re-reads the task fresh at confirm
  // time (see ActionLayerService.completeTaskAsHuman).
  | { type: "ACTION_MARK_DONE"; taskId: string; taskTitle: string; taskStatus: TaskStatus; clause: string }
  | { type: "ACTION_RETRY_TASK"; taskId: string; taskTitle: string; clause: string }
  | { type: "ACTION_BULK_CANCEL"; status: TaskStatus; taskIds: string[]; titles: string[]; clause: string }
  | { type: "ACTION_BULK_START"; status: TaskStatus; taskIds: string[]; titles: string[]; clause: string }
  | { type: "ACTION_UPLOAD_CREATE_TASKS_PREVIEW"; importId: string; statusFilter?: string[]; clause: string }
  | { type: "UNSUPPORTED"; clause: string; reason: string; isActionFailure?: boolean };

type ActionIntent = Extract<ParsedIntent, { type: `ACTION_${string}` }>;
type ReadIntent = Exclude<ParsedIntent, ActionIntent>;

function isActionIntent(i: ParsedIntent): i is ActionIntent {
  return i.type.startsWith("ACTION_");
}

const TASK_SCOPED_PATTERNS: Array<{ type: Exclude<ParsedIntent["type"], "TASK_SUMMARY" | "TASKS_BY_STATUS" | "OLDEST_TASK_BY_STATUS" | "WORKSPACE_CONTEXT" | "UPLOAD_SUMMARY" | "UPLOAD_COUNT_ITEMS" | "UPLOAD_LIST_ITEMS" | "UNSUPPORTED">; pattern: RegExp }> = [
  { type: "TASK_HANDOFF", pattern: /\bhandoff\b|\bswitch(ed|ing)?\b.*\bmodel\b|\bcontinue\b.*\bmodel\b|\bminimum context\b/ },
  { type: "TASK_CHANGES", pattern: /changed files?|which files/ },
  { type: "TASK_VALIDATION", pattern: /\bvalidation\b/ },
  { type: "TASK_MODEL_USAGE", pattern: /\bmodel\b.*\bprovider\b|\bprovider\b.*\bmodel\b|which model|what model/ },
  { type: "TASK_ORIGIN", pattern: /\borigin\b|\bcame from\b|\bwhere did\b.*\bcome\b|\buploaded\b.*\bsheet\b/ },
  {
    type: "TASK_FAILURE_REASON",
    pattern:
      /\bwhat went wrong\b|\bwhy did it fail\b|\bwhy is it stuck\b|\bwhat happened during execution\b|\bwhat was the last failure\b|\bshow me the failure details\b|\bfailure details?\b|\breason for failure\b|\bfailure reason\b|\bwhy failed\b/,
  },
  {
    type: "TASK_RETRY_ELIGIBILITY",
    pattern:
      /\bcan it be retried\b|\bis it retryable\b|\bcan i retry\b|\bcan this be retried\b|\bcould it be retried\b|\bretry eligibility\b/,
  },
  // Phase 4D.5 — checked BEFORE TASK_EXECUTION below so "what's the merge status" is never swallowed by
  // the generic "status of"/"what's the status" pattern (Objective: TaskStatus and PRStatus stay separate
  // data sources, never conflated).
  {
    type: "TASK_PR_STATUS",
    pattern:
      /\bmerge status\b|\bpr status\b|\bpull request status\b|\bgithub pr status\b|\b(?:has|was)\b[\s\S]*?\b(?:pr|pull request)\b[\s\S]*?\bmerged\b|\bwas\b[\s\S]*?\bmerged\b|\bis\b[\s\S]*?\bpr\b[\s\S]*?\bopen\b|\bpr\b[\s\S]*?\bclosed\b/,
  },
  { type: "TASK_EXECUTION", pattern: /\blast thing\b|\bwhat happened\b|\bwhy is\b.*\bstill\b|\bstatus of\b|\bwhat.?s the status\b|\bwhat is happening\b|\bdid on\b/ },
];

const BULK_ACTION_CAP = 50;
const HEDGE_PATTERN = /\b(if|should|maybe|might|could|would|think|suppose|guess)\b/i;

function findStatuses(text: string): TaskStatus[] {
  const result: TaskStatus[] = [];
  if (/\bbacklog\b/i.test(text)) result.push("BACKLOG");
  if (/\bready to start\b|\bto\s*do\b|\btodo\b/i.test(text)) result.push("TODO");
  if (/\bcurrently running\b|\bworking\b|\bin\s*progress\b/i.test(text)) result.push("WORKING");
  if (/\bwaiting (?:for|on) (?:me|human)\b|\bneeds?\s*(?:[a-z]+\s*)?input\b|\bneeds_input\b/i.test(text)) result.push("NEEDS_INPUT");
  if (/\breview\b/i.test(text)) result.push("REVIEW");
  if (/\bdone\b|\bcompleted\b/i.test(text)) result.push("DONE");
  if (/\bfailed\b/i.test(text)) result.push("FAILED");
  if (/\bcancelled\b|\bcanceled\b/i.test(text)) result.push("CANCELLED");
  return result;
}

function formatCounts(counts: TaskCounts, includeZeros = false): string {
  if (includeZeros) {
    const statuses: TaskStatus[] = ["BACKLOG", "TODO", "WORKING", "NEEDS_INPUT", "REVIEW", "DONE", "FAILED"];
    return statuses.map((s) => `${statusLabel(s)} ${counts[s]}`).join(", ");
  }
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${statusLabel(s)}`);
  return parts.length ? parts.join(", ") : "0 tasks";
}

/** Small per-message memoization so "how many are Done" + "which are in Review" + "oldest Review" don't each re-query the same rows — shared across BOTH parsing (which may need to learn a concrete task id for a later pronoun) and execution. */
class QueryCache {
  private summary?: { total: number; counts: TaskCounts };
  private byStatus = new Map<TaskStatus, TaskListItem[]>();
  private allTasksById?: Map<string, TaskListItem>;
  private oldestInReview?: { task: TaskListItem; reviewEnteredAt: string | null } | null;

  constructor(
    private readonly ctx: ContextLayerService,
    private readonly projectId: string,
    private readonly actorId: string,
  ) {}

  getSummary() {
    if (!this.summary) this.summary = this.ctx.getTaskSummary(this.projectId, this.actorId);
    return this.summary;
  }

  /** All tasks in `status`, oldest first — reused by both TASKS_BY_STATUS and OLDEST_TASK_BY_STATUS for the same status. */
  getByStatusOldestFirst(status: TaskStatus): TaskListItem[] {
    let list = this.byStatus.get(status);
    if (!list) {
      list = this.ctx.getTasks(this.projectId, this.actorId, { status, sort: "oldest", limit: 20 });
      this.byStatus.set(status, list);
    }
    return list;
  }

  /** Phase 4D.5 — EVERY one of this project's tasks, unbounded, keyed by id. Used for conversational-reference resolution ("the second one", "that task") and review-age computation — never for display, so the 20-item display cap never applies here (same lesson as Phase 4D.3.2). */
  getAllTasksById(): Map<string, TaskListItem> {
    if (!this.allTasksById) {
      this.allTasksById = new Map(this.ctx.getAllTasksForResolution(this.projectId, this.actorId).map((t) => [t.id, t]));
    }
    return this.allTasksById;
  }

  /**
   * Phase 4D.5 — "oldest in Review" means longest-in-review, measured from the real `TASK_MOVED_TO_REVIEW`
   * event (see ContextLayerService.getReviewEnteredAt), NOT `createdAt` — a task can spend real time in
   * BACKLOG/TODO/WORKING first, or cycle back into REVIEW after `changes_requested`. Computed over the
   * FULL unbounded task set (the Phase 4D.3.2 lesson applies here too). Falls back to createdAt-sort only
   * when NO Review task has a recorded entry event (reports that honestly via `reviewEnteredAt: null`
   * rather than inventing precision).
   */
  getOldestInReview(): { task: TaskListItem; reviewEnteredAt: string | null } | null {
    if (this.oldestInReview !== undefined) return this.oldestInReview;
    const reviewTasks = [...this.getAllTasksById().values()].filter((t) => t.status === "REVIEW");
    if (reviewTasks.length === 0) {
      this.oldestInReview = null;
      return null;
    }
    const withEntry = reviewTasks.map((task) => ({ task, reviewEnteredAt: this.ctx.getReviewEnteredAt(this.projectId, task.id, this.actorId) }));
    const known = withEntry.filter((x): x is { task: TaskListItem; reviewEnteredAt: string } => x.reviewEnteredAt !== null);
    if (known.length === 0) {
      const byCreated = [...reviewTasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.oldestInReview = { task: byCreated[0]!, reviewEnteredAt: null };
      return this.oldestInReview;
    }
    known.sort((a, b) => a.reviewEnteredAt.localeCompare(b.reviewEnteredAt));
    this.oldestInReview = known[0]!;
    return this.oldestInReview;
  }

  private importedItemsByImportId = new Map<string, BacklogItem[]>();

  getImportedItems(importId: string): BacklogItem[] {
    let items = this.importedItemsByImportId.get(importId);
    if (!items) {
      items = this.ctx.getImportedItems(importId, this.actorId);
      this.importedItemsByImportId.set(importId, items);
    }
    return items;
  }

  /** The oldest task in `status` — review-age-aware for REVIEW specifically (see `getOldestInReview`), createdAt-sorted for every other status (unchanged, pre-4D.5 behavior). The single entry point both the read "oldest in status" query and the action "the oldest X task" resolver use, so they can never disagree. */
  getOldestTaskInStatus(status: TaskStatus): TaskListItem | undefined {
    if (status === "REVIEW") return this.getOldestInReview()?.task;
    return this.getByStatusOldestFirst(status)[0];
  }
}

export function normalizeStatus(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\u2010\u2013\u2014\u2015]/g, "-")
    .replace(/\s+/g, " ");
}

export function getImportedItemStatus(item: { metadata?: Record<string, string> | null; status: string }): string {
  const meta = item.metadata ?? {};
  if (meta.status) return meta.status;
  for (const [k, v] of Object.entries(meta)) {
    const norm = k.toLowerCase().replace(/[\s_-]+/g, "");
    if (norm === "devstatus" || norm === "developmentstatus" || norm === "status") {
      if (v) return v;
    }
  }
  return (
    meta["dev-status"] ??
    meta["dev_status"] ??
    meta["Dev Status"] ??
    meta["development_status"] ??
    meta["developmentStatus"] ??
    meta["devstatus"] ??
    meta.state ??
    meta.bugstatus ??
    item.status
  );
}

export function filterImportedItemsByStatus(items: BacklogItem[], statusFilter?: string[]): { matching: BacklogItem[]; label: string } {
  if (!statusFilter || statusFilter.length === 0) {
    return { matching: items, label: "all items" };
  }
  const normalizedFilters = statusFilter.map(normalizeStatus);
  const matching = items.filter((item) => {
    const rawStatus = getImportedItemStatus(item);
    const norm = normalizeStatus(rawStatus);
    return normalizedFilters.some((f) => norm.includes(f) || f.includes(norm));
  });
  return { matching, label: statusFilter.join(", ") };
}

export function extractStatusFiltersFromClause(clause: string, items: BacklogItem[]): string[] | undefined {
  if (items.length === 0) return undefined;
  const normClause = normalizeStatus(clause);
  const availableRawStatuses = Array.from(new Set(items.map((it) => getImportedItemStatus(it))));
  const matched: string[] = [];

  for (const raw of availableRawStatuses) {
    const normRaw = normalizeStatus(raw);
    if (normClause.includes(normRaw)) {
      matched.push(raw);
    }
  }

  // Common aliases/phrasings fallback if exact substring in clause didn't catch it
  if (matched.length === 0) {
    if (/\bopen\b/.test(normClause)) {
      const openMatches = availableRawStatuses.filter((s) => /open/i.test(s));
      if (openMatches.length > 0) matched.push(...openMatches);
    }
    if (/\badd-on\b|\bnot built\b/.test(normClause)) {
      const addonMatches = availableRawStatuses.filter((s) => /add-on|not built/i.test(s));
      if (addonMatches.length > 0) matched.push(...addonMatches);
    }
  }

  return matched.length > 0 ? Array.from(new Set(matched)) : undefined;
}

/**
 * Phase 4D.3 — bulk mutations ("cancel all failed tasks", "start all backlog tasks"). Checked BEFORE the
 * single-task ACTION_PATTERNS below (which would otherwise match the bare "cancel"/"start" verb and try,
 * and fail, to resolve "all failed tasks" as if it named one task). A bulk match only ever produces a
 * PROPOSAL (see `executeAction`'s BULK cases) — never an immediate mutation; only an explicit confirming
 * reply in a LATER message (handled in ChatService, outside this clause-by-clause parser) executes it.
 */
const BULK_ACTION_PATTERNS: Array<{ type: "ACTION_BULK_CANCEL" | "ACTION_BULK_START"; pattern: RegExp }> = [
  { type: "ACTION_BULK_CANCEL", pattern: /\bcancel\b[\s\S]*?\ball\b[\s\S]*?\btasks?\b/ },
  { type: "ACTION_BULK_START", pattern: /\bstart\b[\s\S]*?\ball\b[\s\S]*?\btasks?\b/ },
];

const ACTION_PATTERNS: Array<{ type: "ACTION_START_TASK" | "ACTION_CANCEL_TASK" | "ACTION_MARK_DONE" | "ACTION_RETRY_TASK"; pattern: RegExp }> = [
  { type: "ACTION_START_TASK", pattern: /\bstart\b/ },
  { type: "ACTION_CANCEL_TASK", pattern: /\bcancel\b/ },
  // Phase 4D.2.1 — broadened after a real incident: "make the review task add profile to done" used none
  // of the words the original narrow pattern ("mark ... done/complete/completed") covered, so the whole
  // message fell through to the general LLM path and it fabricated a false "I have updated..." claim. Now
  // covers the natural completion verbs a person actually uses (mark/make/set/move/close a task
  // done/complete/completed/finished, or "complete <task ref>", or "is resolved") — still ONLY a trigger
  // for classification; `ActionLayerService.markDone` decides support/decline exactly as before.
  // Phase 4D.4 — added "finish" (e.g. "Finish the Add Profile task.") alongside the existing verbs.
  { type: "ACTION_MARK_DONE", pattern: /\b(?:mark|make|set|move|close)\b[\s\S]*?\b(?:done|complete|completed|finished)\b|\bclose\b[\s\S]*?\btask\b|\bcomplete\b[\s\S]*?\btask\b|\bfinish\b[\s\S]*?\btask\b|\bis resolved\b/ },
  { type: "ACTION_RETRY_TASK", pattern: /\bretry\b|\bre-run\b|\brerun\b/ },
];

/**
 * Words stripped from an action clause before the fuzzy reverse-substring check below — action verbs,
 * target-state words, and generic task/status nouns a user's shorthand reference wouldn't itself be
 * quoting from the task's real title (e.g. "make the review task add profile to done" should search for
 * "add profile", not the whole sentence).
 */
const ACTION_FILLER_WORDS = new Set([
  "mark",
  "make",
  "set",
  "move",
  "close",
  "complete",
  "completed",
  "start",
  "cancel",
  "retry",
  "re-run",
  "rerun",
  "task",
  "tasks",
  "the",
  "this",
  "that",
  "to",
  "as",
  "is",
  "resolved",
  "done",
  "finished",
  "finish",
  "it",
  "please",
  "kindly",
  "now",
  "review",
  "backlog",
  "working",
  "todo",
  "failed",
  "cancelled",
  "needs",
  "input",
  "in",
  "progress",
  "oldest",
  "longest",
  "from",
  "into",
  "of",
  "for",
  "on",
  "by",
  "with",
  "about",
  "show",
  "tell",
  "me",
  "us",
  "give",
  "get",
]);

/**
 * Phase 4D.5 — generic pronoun words that refer to "the task(s) we were just discussing" without naming
 * one explicitly. Deliberately a fixed, bounded list (not "any noun phrase") — see Objective 6.
 */
const GENERIC_TASK_PRONOUN = /\b(?:that task|this task|the task|that one|this one|the previous task|it|those tasks|these tasks)\b/;

/** Maps an ordinal word to its 0-based index into the conversation's last-displayed task list. "last" is handled separately (negative/length-relative). */
const ORDINAL_INDEX: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4 };

/**
 * Phase 4D.5 — resolves a conversational reference ("that task", "the second one", "the oldest one",
 * "those tasks") against the structured referent state a conversation already carries: a same-message
 * mention takes priority over anything persisted from an earlier turn, and the ordered list of tasks the
 * conversation most recently DISPLAYED (`lastTaskIds`) takes priority over the single, coarser
 * `lastTaskId` — so a fresh multi-task query result is never shadowed by an older single-task mention
 * (Objective 5/9, "stale referents must never override fresh results"). Returns an explicit ambiguity
 * signal (a non-empty `ambiguousTitles`) when a bare pronoun is used but more than one candidate is in
 * play and nothing (an ordinal, an explicit id/title) narrows it down — the caller must ask, never guess.
 */
function resolveConversationalReference(
  lower: string,
  lastMentionedTaskId: string | null,
  lastTaskId: string | null,
  lastTaskIds: string[] | null,
  tasksById: Map<string, TaskListItem>,
  /**
   * READS fall back to the last-discussed task UNCONDITIONALLY, no pronoun required — this matches the
   * pre-4D.5 behavior of `ContextLayerService.resolveTaskReference`'s own built-in fallback ("which files
   * changed?" right after discussing one task still means that task). ACTIONS are more conservative: a
   * mutation should only silently target the last-discussed task when the user actually said "it"/"that
   * task"/an ordinal — a bare, referenceless command falling back to whatever was last discussed would be
   * too easy to trigger by accident. Ordinal references ("the second one") are NEVER gated by this flag —
   * they're explicit regardless of caller.
   */
  requireExplicitReferenceForFallback: boolean,
): { task: TaskListItem | null; ambiguousTitles: string[] } {
  // Priority 3 (same-message): a task already named/resolved earlier in THIS message always wins over
  // anything persisted from a previous turn.
  if (lastMentionedTaskId) {
    const t = tasksById.get(lastMentionedTaskId);
    if (t) return { task: t, ambiguousTitles: [] };
  }

  const hasGenericPronoun = GENERIC_TASK_PRONOUN.test(lower);

  // Priority 4/5: the ordered list the conversation most recently displayed.
  const list = (lastTaskIds ?? []).map((id) => tasksById.get(id)).filter((t): t is TaskListItem => !!t);
  if (list.length > 0) {
    if (/\boldest one\b/.test(lower)) return { task: [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!, ambiguousTitles: [] };
    if (/\bnewest one\b|\blatest one\b/.test(lower)) return { task: [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!, ambiguousTitles: [] };
    if (/\blast one\b/.test(lower)) return { task: list[list.length - 1]!, ambiguousTitles: [] };
    for (const [word, idx] of Object.entries(ORDINAL_INDEX)) {
      if (new RegExp(`\\b${word}\\b`).test(lower) && list[idx]) return { task: list[idx]!, ambiguousTitles: [] };
    }
    if (list.length === 1 && (!requireExplicitReferenceForFallback || hasGenericPronoun)) {
      return { task: list[0]!, ambiguousTitles: [] };
    }
    // Multiple displayed candidates: only treat this as a referential match (and only then ask to
    // disambiguate) if the clause actually uses a generic pronoun — a completely bare clause with no
    // reference at all falls through to the coarser `lastTaskId` below, exactly as it always has.
    if (hasGenericPronoun) {
      return { task: null, ambiguousTitles: list.map((t) => t.title) };
    }
  }

  // Priority 6 (final fallback): the single, coarser `lastTaskId`.
  if (lastTaskId && (!requireExplicitReferenceForFallback || hasGenericPronoun)) {
    const t = tasksById.get(lastTaskId);
    if (t) return { task: t, ambiguousTitles: [] };
  }
  return { task: null, ambiguousTitles: [] };
}

/** The remaining significant words of `clause` after stripping action verbs/fillers — a candidate substring to look for INSIDE a task's (possibly much longer) real title. Empty if nothing significant remains. */
function extractReferencePhrase(clause: string): string {
  return clause
    .toLowerCase()
    .replace(/["'.?!]/g, "")
    .split(/\s+/)
    .filter((w) => w && !ACTION_FILLER_WORDS.has(w))
    .join(" ")
    .trim();
}

/**
 * Resolves an ACTION clause's task target with EXPLICIT ambiguity detection (Objective 11: "if
 * resolution is ambiguous, do NOT act") — deliberately separate from the read-only
 * `ContextLayerService.resolveTaskReference`, which silently returns its first match and has no way to
 * report "I found two." An id match is always unambiguous (ids are unique); a title match is ambiguous
 * if more than one task's title appears in the clause.
 *
 * A real task title can be much longer than what a person actually types ("Add profile (+) option still
 * shown after reaching the maximum number of profiles..." vs. a user typing "add profile") — the exact
 * forward-substring check above never matches that. After it comes up empty, a REVERSE check tries the
 * opposite direction: does the task's title contain the clause's own significant words (with action
 * verbs/fillers/status-nouns stripped out first, via `extractReferencePhrase`)? Still exact substring
 * matching, still bounded to this project's own tasks, still ambiguity-checked the same way — just
 * matching in the direction a short nickname reference actually needs.
 *
 * Candidates come from `getAllTasksForResolution` — NOT the display-bounded `getTasks` (Phase 4D.3.2: a
 * real project with >20 tasks had a legitimate older task become permanently unreferenceable by title,
 * since the old 20-task cap silently excluded it from ever being searched at all). This is a pure
 * in-memory match, never a model prompt, so there is no reason to bound the SEARCH space — only the
 * ambiguity report (a small list of actual matches) is ever shown to anyone.
 */
function normalizeForMatching(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function resolveActionTarget(
  cache: QueryCache,
  clause: string,
  lastMentionedTaskId: string | null,
  lastTaskId: string | null,
  lastTaskIds: string[] | null,
): { task: TaskListItem | null; ambiguousTitles: string[] } {
  const tasksById = cache.getAllTasksById();
  const tasks = [...tasksById.values()];
  const lower = clause.toLowerCase();
  const normClause = normalizeForMatching(clause);

  const idMatch = tasks.find((t) => lower.includes(t.id.toLowerCase()) || lower.includes(t.id.slice(0, 8).toLowerCase()));
  if (idMatch) return { task: idMatch, ambiguousTitles: [] };

  const titleMatches = tasks.filter((t) => {
    if (!t.title.trim()) return false;
    const normTitle = normalizeForMatching(t.title);
    return lower.includes(t.title.toLowerCase()) || (normClause.length >= 5 && normClause.includes(normTitle));
  });
  if (titleMatches.length === 1) return { task: titleMatches[0]!, ambiguousTitles: [] };
  if (titleMatches.length > 1) return { task: null, ambiguousTitles: titleMatches.map((t) => t.title) };

  const refPhrase = extractReferencePhrase(clause);
  if (refPhrase.length >= 3) {
    const normRef = normalizeForMatching(refPhrase);
    const refWords = normRef.split(/\s+/).filter((w) => w.length >= 2);
    const fuzzyMatches = tasks.filter((t) => {
      if (!t.title.trim()) return false;
      const normTitle = normalizeForMatching(t.title);
      if (t.title.toLowerCase().includes(refPhrase) || normTitle.includes(normRef)) return true;
      if (refWords.length >= 2 && refWords.every((w) => normTitle.includes(w))) return true;
      return false;
    });
    if (fuzzyMatches.length === 1) return { task: fuzzyMatches[0]!, ambiguousTitles: [] };
    if (fuzzyMatches.length > 1) return { task: null, ambiguousTitles: fuzzyMatches.map((t) => t.title) };
  }

  // Phase 4D.5 — ordinal/pronoun conversational references ("Cancel the second one.", "Start that task.")
  // now resolve the SAME way reads do (see `resolveConversationalReference`'s own doc comment), instead of
  // the old narrow "it"/"that task"/"this task" + single lastTaskId fallback. `true` here preserves the
  // OLD, more conservative action behavior: an explicit pronoun/ordinal is still required before a
  // mutation silently targets the last-discussed task — a completely bare command never does.
  return resolveConversationalReference(lower, lastMentionedTaskId, lastTaskId, lastTaskIds, tasksById, true);
}

/**
 * Classifies every clause of `text`, resolving task references and status references that are implicit
 * ("which is oldest?" / "what did it do?") against whatever was named EARLIER in the SAME message —
 * never against unrelated prior messages unless the clause truly names nothing at all, in which case the
 * conversation's own `lastTaskId` is the final fallback (see ContextLayerService.resolveTaskReference).
 *
 * `cache` is shared with execution (see `answerDeterministically`) for two reasons: it avoids querying
 * the same rows twice, AND it lets an OLDEST_TASK_BY_STATUS clause learn the CONCRETE task id it refers
 * to right away (cheaply, via the cache) so a later pronoun clause in the SAME message ("...which files
 * changed? what validation passed?") can resolve against that real task — a task-scoped clause can't
 * otherwise know what "it" means until the oldest-task query has actually run once.
 */
export function parseIntents(
  ctx: ContextLayerService,
  projectId: string,
  actorId: string,
  text: string,
  lastTaskId: string | null,
  cache: QueryCache,
  lastTaskIds: string[] | null = null,
  activeImportId: string | null = null,
): ParsedIntent[] {
  const clauses = splitIntoClauses(text);
  const intents: ParsedIntent[] = [];
  let lastMentionedStatus: TaskStatus | null = null;
  let lastMentionedTaskId: string | null = null;
  let lastMentionedUploadFilter: string[] | undefined = undefined;

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!;
    const lower = clause.toLowerCase();
    const mentionsHowMany = /how many/.test(lower);
    const statuses = findStatuses(lower);
    // "first task in review" is the same request as "oldest task in review" — created-order, not a
    // literal "oldest"/"longest" synonym requirement.
    const oldestMatch = /\boldest\b|\blongest\b|\bfirst\b/.test(lower);
    const wantsFullSummary = /\b(summary|breakdown|overview)\b/.test(lower) || /\bcurrent\b[\s\S]{0,15}?\bstatus\b|\btask status\b|\boverall status\b/.test(lower) || new Set(statuses).size >= 3;
    const isHedged = HEDGE_PATTERN.test(lower);

    // Upload-aware intents (when an active import exists OR clause explicitly mentions upload/file/sheet/bugs/dev-status)
    if (activeImportId || /\b(upload|uploaded|sheet|file|dev-status|dev_status|add-on)\b/.test(lower)) {
      const targetImportId = activeImportId;
      if (targetImportId) {
        const importedItems = cache.getImportedItems(targetImportId);
        const extractedFilters = extractStatusFiltersFromClause(clause, importedItems);
        const effectiveFilters = extractedFilters ?? lastMentionedUploadFilter;
        if (extractedFilters) lastMentionedUploadFilter = extractedFilters;

        // 1) Action: Create Tasks preview
        if (!isHedged && /\b(create|add)\b.*\btasks?\b/i.test(clause)) {
          intents.push({
            type: "ACTION_UPLOAD_CREATE_TASKS_PREVIEW",
            importId: targetImportId,
            statusFilter: effectiveFilters,
            clause,
          });
          continue;
        }

        // 2) Count uploaded items
        if ((mentionsHowMany || /\bcount\b/i.test(clause)) && (/\b(bugs|items|uploaded|open|add-on|dev-status)\b/i.test(clause) || !statuses.length)) {
          intents.push({
            type: "UPLOAD_COUNT_ITEMS",
            importId: targetImportId,
            statusFilter: effectiveFilters,
            clause,
          });
          continue;
        }

        // 3) List uploaded items
        if (/\b(show|list|get|display|list them)\b/i.test(clause) && (/\b(bugs|items|uploaded|add-on|open)\b/i.test(clause) || effectiveFilters || /\blist them\b/i.test(clause))) {
          intents.push({
            type: "UPLOAD_LIST_ITEMS",
            importId: targetImportId,
            statusFilter: effectiveFilters,
            clause,
          });
          continue;
        }

        // 4) Upload summary
        if (/\b(analyze|summary|overview|breakdown)\b/i.test(clause) && /\b(upload|uploaded|sheet|file|bugs)\b/i.test(clause)) {
          intents.push({
            type: "UPLOAD_SUMMARY",
            importId: targetImportId,
            clause,
          });
          continue;
        }
      }
    }

    // 0) ACTIONS — checked first (imperative commands don't overlap the read-only keyword patterns
    // below), and skipped entirely for hedged/non-command language ("the task should probably be
    // cancelled" must never mutate anything — Objective 4/19) AND for a "how many" question (Phase
    // 4D.5 — found live: "How many tasks are ready to start?" was misclassified as ACTION_START_TASK
    // purely because it contains the bare word "start"; a question is never an imperative command,
    // regardless of which action verb its wording happens to share).
    if (!isHedged && !mentionsHowMany) {
      // 0a) CREATE — no existing task to resolve; extract a title/description from the clause itself.
      const createMatch = /\bcreate\b.*\btask\b.*?\b(?:for|called|titled|to)\b\s+(.+)/i.exec(clause) ?? /\badd\b.*\btask\b.*?\b(?:for|called|titled)\b\s+(.+)/i.exec(clause);
      if (createMatch) {
        const extracted = createMatch[1]!.trim().replace(/[.?!]+$/, "");
        if (extracted) {
          intents.push({ type: "ACTION_CREATE_TASK", title: extracted.slice(0, 200), description: extracted, clause });
          continue;
        }
      }

      // 0b) EDIT TITLE — "rename/change/edit/update <ref> title to <new title>".
      const editMatch = /\b(?:rename|change|edit|update)\b(.*)\btitle\b.*?\bto\b\s+(.+)/i.exec(clause);
      if (editMatch) {
        const newTitle = editMatch[2]!.trim().replace(/[.?!]+$/, "");
        const refText = editMatch[1]!.trim() || clause;
        if (newTitle) {
          const { task, ambiguousTitles } = resolveActionTarget(cache, refText, lastMentionedTaskId, lastTaskId, lastTaskIds);
          if (task) {
            lastMentionedTaskId = task.id;
            intents.push({ type: "ACTION_EDIT_TITLE", taskId: task.id, taskTitle: task.title, newTitle: newTitle.slice(0, 200), clause });
          } else if (ambiguousTitles.length > 1) {
            intents.push({ type: "UNSUPPORTED", clause, reason: `I found ${ambiguousTitles.length} tasks matching that — ${ambiguousTitles.map((t) => `"${t}"`).join(", ")}. Which one do you mean?`, isActionFailure: true });
          } else {
            intents.push({ type: "UNSUPPORTED", clause, reason: "I couldn't find which task to rename — name it by title or id", isActionFailure: true });
          }
          continue;
        }
      }

      // 0c-bulk) "cancel/start all <status> tasks" — resolve the EXACT target set now (a snapshot shown
      // to the user), but never execute here; see BULK_ACTION_PATTERNS's own doc comment.
      const bulkMatch = BULK_ACTION_PATTERNS.find((p) => p.pattern.test(lower));
      if (bulkMatch) {
        const distinctStatuses = new Set(statuses);
        if (distinctStatuses.size !== 1) {
          intents.push({
            clause,
            isActionFailure: true,
            reason:
              distinctStatuses.size === 0
                ? "which status should I target? (e.g. \"cancel all failed tasks\")"
                : `that names more than one status (${[...distinctStatuses].map((s) => statusLabel(s)).join(", ")}) — which one did you mean?`,
            type: "UNSUPPORTED",
          });
        } else {
          const status = statuses[0]!;
          const targets = ctx.getTasks(projectId, actorId, { status, sort: "oldest", limit: BULK_ACTION_CAP });
          if (targets.length === 0) {
            intents.push({ type: "UNSUPPORTED", clause, reason: `there are no tasks in ${statusLabel(status)} to act on`, isActionFailure: true });
          } else {
            intents.push({ type: bulkMatch.type, status, taskIds: targets.map((t) => t.id), titles: targets.map((t) => t.title), clause } as ParsedIntent);
          }
        }
        continue;
      }

      // 0c) START / CANCEL / MARK DONE / RETRY — resolve a task target, or explain ambiguity/not-found.
      const actionMatch = ACTION_PATTERNS.find((p) => p.pattern.test(lower));
      if (actionMatch) {
        // "make the OLDEST Review task done" names its target by status+ordering, not by a title fragment
        // — reuse the SAME oldest-in-status lookup (and cache) the read path already uses, rather than
        // asking resolveActionTarget's title-substring logic to somehow match "oldest".
        if (oldestMatch) {
          const status: TaskStatus | null = statuses[0] ?? lastMentionedStatus;
          if (status) {
            const oldest = cache.getOldestTaskInStatus(status);
            if (oldest) {
              lastMentionedTaskId = oldest.id;
              intents.push({ type: actionMatch.type, taskId: oldest.id, taskTitle: oldest.title, taskStatus: oldest.status, clause } as ParsedIntent);
            } else {
              intents.push({ type: "UNSUPPORTED", clause, reason: `there are no tasks in ${statusLabel(status)} to act on`, isActionFailure: true });
            }
            continue;
          }
        }
        const { task, ambiguousTitles } = resolveActionTarget(cache, clause, lastMentionedTaskId, lastTaskId, lastTaskIds);
        if (task) {
          lastMentionedTaskId = task.id;
          intents.push({ type: actionMatch.type, taskId: task.id, taskTitle: task.title, taskStatus: task.status, clause } as ParsedIntent);
        } else if (ambiguousTitles.length > 1) {
          intents.push({ type: "UNSUPPORTED", clause, reason: `I found ${ambiguousTitles.length} tasks matching that — ${ambiguousTitles.map((t) => `"${t}"`).join(", ")}. Which one do you mean?`, isActionFailure: true });
        } else {
          intents.push({ type: "UNSUPPORTED", clause, reason: "I couldn't find which task this refers to — name it by title or id", isActionFailure: true });
        }
        continue;
      }
    }

    // 0.5) "What needs my attention?" — a composite of the action-relevant statuses (Review/Needs
    // input/Failed), reusing the SAME cached summary every other count comes from. Checked before the
    // generic full-breakdown branch below since it doesn't mention "tasks" or any specific status word.
    if (/\bneeds? (?:my )?attention\b|\bwhat needs attention\b|\bwhat should i (?:look at|focus on)\b|\bwhat do you need from me\b/.test(lower)) {
      intents.push({ type: "ATTENTION_SUMMARY", clause });
      continue;
    }

    // A) Full status breakdown.
    if (/\btasks?\b/.test(lower) && wantsFullSummary) {
      intents.push({ type: "TASK_SUMMARY", clause });
      continue;
    }

    // B) "Which task(s) are in Review?" / "Show me all tasks currently in Review." / "Show my review
    // tasks." / "Can you give me the review task?" — a listing, distinct from a bare count. Broadened
    // past the original literal "which tasks" (Phase 4D.3, found live: "Show me all tasks currently in
    // Review." fell all the way through to the free-text LLM path since nothing else matched it either),
    // then again (Phase 4D.5, §29's own exact reproduction wording) to cover "give me"/"get me" phrasing
    // that names a status but neither "show"/"which"/"list".
    if (/\bwhich tasks?\b|\bshow\b[\s\S]*?\btasks?\b|\blist\b[\s\S]*?\btasks?\b|\b(?:give|get)\b[\s\S]*?\btasks?\b/.test(lower) && statuses.length === 1 && !oldestMatch) {
      lastMentionedStatus = statuses[0]!;
      intents.push({ type: "TASKS_BY_STATUS", status: statuses[0]!, clause });
      continue;
    }

    // B2) "Show me the latest/recent tasks" — a bounded listing across ALL statuses, newest first, for
    // when the user doesn't name a status at all (distinct from B, which requires one).
    if (/\b(?:latest|recent|newest)\b.*\btasks?\b|\bshow\b.*\btasks?\b$/.test(lower) && statuses.length === 0 && !oldestMatch && !mentionsHowMany) {
      intents.push({ type: "TASKS_RECENT", clause });
      continue;
    }

    // C) Oldest/longest-in-status, with an inherited status if the clause doesn't name one itself
    // ("which task is oldest?" right after "how many are in Review?").
    if (oldestMatch) {
      const status: TaskStatus | null = statuses[0] ?? lastMentionedStatus;
      if (status) {
        lastMentionedStatus = status;
        let includeBlocking = /\bblock|\bwhy\b|\bstuck\b/.test(lower);
        const next = clauses[i + 1];
        if (!includeBlocking && next && /\bblock|\bwhy\b|\bstuck\b/.test(next.toLowerCase()) && /\bit\b|\bthat task\b|\bthis task\b/.test(next.toLowerCase())) {
          includeBlocking = true;
          i++; // consume the trailing pronoun clause — it's part of this same question, not a separate one.
        }
        const oldestNow = cache.getOldestTaskInStatus(status);
        if (oldestNow) lastMentionedTaskId = oldestNow.id;
        intents.push({ type: "OLDEST_TASK_BY_STATUS", status, includeBlocking, clause });
        continue;
      } else if (lastTaskIds && lastTaskIds.length > 0) {
        // "Which one is the oldest?" right after a list query (e.g. "Show me all failed tasks.")
        const candidateTasks = lastTaskIds.map((id) => cache.getAllTasksById().get(id)).filter((t): t is TaskListItem => !!t);
        if (candidateTasks.length > 0) {
          const sorted = [...candidateTasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          const oldestInList = sorted[0]!;
          lastMentionedTaskId = oldestInList.id;
          intents.push({ type: "TASK_EXECUTION", taskId: oldestInList.id, clause });
          continue;
        }
      }
    }

    // D) A single-status count ("how many tasks are Done?", "how many are Failed?").
    if ((mentionsHowMany || /\bhas codeforge\b/.test(lower)) && statuses.length === 1) {
      lastMentionedStatus = statuses[0]!;
      intents.push({ type: "TASK_SUMMARY", status: statuses[0]!, clause });
      continue;
    }

    // Everything below is task-SCOPED — resolve a task reference: an explicit id/title in THIS clause
    // first, then (Phase 4D.5) a conversational reference ("that task", "the second one", "the oldest
    // one") against the conversation's structured referent state.
    const explicit: Task | null = ctx.resolveTaskReference(projectId, actorId, clause, null);
    let resolvedId: string | null = explicit?.id ?? null;
    let scopedAmbiguousTitles: string[] = [];
    if (!resolvedId) {
      const viaReferential = resolveConversationalReference(lower, lastMentionedTaskId, lastTaskId, lastTaskIds, cache.getAllTasksById(), false);
      if (viaReferential.task) resolvedId = viaReferential.task.id;
      else scopedAmbiguousTitles = viaReferential.ambiguousTitles;
    }

    const scoped = TASK_SCOPED_PATTERNS.find((p) => p.pattern.test(lower));
    if (scoped) {
      if (resolvedId) {
        lastMentionedTaskId = resolvedId;
        intents.push({ type: scoped.type, taskId: resolvedId, clause } as ParsedIntent);
      } else if (scopedAmbiguousTitles.length > 1) {
        intents.push({ type: "UNSUPPORTED", clause, reason: `I found ${scopedAmbiguousTitles.length} tasks matching that — ${scopedAmbiguousTitles.map((t) => `"${t}"`).join(", ")}. Which one do you mean?` });
      } else {
        intents.push({ type: "UNSUPPORTED", clause, reason: "I couldn't find which task this refers to — name it by title or id." });
      }
      continue;
    }

    // E) Workspace/project context — not task-scoped.
    if (/\barchitecture\b|\bproject context\b|\bworkspace context\b|\bcoding conventions\b|\bconstraints\b|\bdefinition of done\b/.test(lower)) {
      intents.push({ type: "WORKSPACE_CONTEXT", clause });
      continue;
    }

    // A pronoun/reference clause ("what did it do?", "give me details of that task", "tell me about the
    // second one") with a resolvable task but no more specific keyword match above still counts as
    // TASK_EXECUTION — the closest general "what's going on with this task" intent.
    if (resolvedId && (GENERIC_TASK_PRONOUN.test(lower) || /\bdetails?\b/.test(lower) || /\b(?:first|second|third|fourth|fifth|oldest|newest|latest|last)\b[\s\S]*?\bone\b/.test(lower))) {
      lastMentionedTaskId = resolvedId;
      intents.push({ type: "TASK_EXECUTION", taskId: resolvedId, clause });
      continue;
    }
    if (scopedAmbiguousTitles.length > 1 && (GENERIC_TASK_PRONOUN.test(lower) || /\b(?:first|second|third|fourth|fifth|oldest|newest|latest|last)\b[\s\S]*?\bone\b/.test(lower))) {
      intents.push({ type: "UNSUPPORTED", clause, reason: `I found ${scopedAmbiguousTitles.length} tasks matching that — ${scopedAmbiguousTitles.map((t) => `"${t}"`).join(", ")}. Which one do you mean?` });
      continue;
    }

    intents.push({ type: "UNSUPPORTED", clause, reason: "this isn't one of CodeForge's supported task/status/workspace questions" });
  }
  return intents;
}

// ---------------------------------------------------------------------------
// 3. Executing the parsed intents and composing ONE answer
// ---------------------------------------------------------------------------

export interface IntentResult {
  content: string;
  /** The task this turn was about, if any — persisted as the conversation's `lastTaskId` for a pronoun follow-up. */
  resolvedTaskId: string | null;
  /** A bulk mutation Chat just proposed and is now waiting on an explicit yes/no reply for — see ChatService. Absent/null when nothing is pending (the normal case). */
  pendingAction?: ChatPendingAction | null;
  /** Phase 4D.5 — the ordered list of tasks the LAST list-producing read in this message displayed, persisted as the conversation's `lastTaskIds` for a later ordinal/pronoun reference ("the second one"). Null when this turn didn't display a list. */
  lastTaskIds?: string[] | null;
}

interface FormatOneResult {
  text: string;
  resolvedTaskId: string | null;
  /** Phase 4D.5 — the ordered list of task ids this read just displayed, for a LATER ordinal/pronoun reference ("the second one") to resolve against. Absent for counts/summaries that don't name concrete tasks. */
  taskIds?: string[];
}

async function formatOne(
  ctx: ContextLayerService,
  projectId: string,
  actorId: string,
  cache: QueryCache,
  intent: ReadIntent,
  lastTaskIds?: string[] | null,
): Promise<FormatOneResult> {
  switch (intent.type) {
    case "TASK_SUMMARY": {
      const { total, counts } = cache.getSummary();
      if (intent.status) {
        const n = counts[intent.status];
        return { text: `${n} task${n === 1 ? " is" : "s are"} currently in ${statusLabel(intent.status)}.`, resolvedTaskId: null };
      }
      return { text: `This project has ${total} task${total === 1 ? "" : "s"}: ${formatCounts(counts, true)}.`, resolvedTaskId: null };
    }
    case "TASKS_BY_STATUS": {
      const rows = cache.getByStatusOldestFirst(intent.status);
      if (rows.length === 0) return { text: `No tasks are currently in ${statusLabel(intent.status)}.`, resolvedTaskId: null };
      // Phase 4D.5 — singular vs. plural phrasing (Part A, Objective 3), and critically: a singular
      // result now sets `resolvedTaskId` (it never did before), which is exactly what fixes "give me
      // details of THAT task" immediately after "show me the Review task" resolving to the right one.
      if (rows.length === 1) {
        const t = rows[0]!;
        return { text: `I found the ${statusLabel(intent.status)} task: "${t.title}" (updated ${t.updatedAt}).`, resolvedTaskId: t.id, taskIds: [t.id] };
      }
      return { text: `I found ${rows.length} tasks in ${statusLabel(intent.status)}: ${rows.map((t) => `"${t.title}"`).join(", ")}.`, resolvedTaskId: null, taskIds: rows.map((t) => t.id) };
    }
    case "TASKS_RECENT": {
      const rows = ctx.getTasks(projectId, actorId, { sort: "newest", limit: 10 });
      if (rows.length === 0) return { text: "This project has no tasks yet.", resolvedTaskId: null };
      return { text: `Latest tasks: ${rows.map((t) => `"${t.title}" (${statusLabel(t.status)})`).join(", ")}.`, resolvedTaskId: null, taskIds: rows.map((t) => t.id) };
    }
    case "ATTENTION_SUMMARY": {
      const { counts } = cache.getSummary();
      const relevant = (["REVIEW", "NEEDS_INPUT", "FAILED"] as TaskStatus[]).filter((s) => counts[s] > 0);
      if (relevant.length === 0) return { text: "Nothing needs your attention right now.", resolvedTaskId: null };
      const parts = relevant.map((s) => `${counts[s]} ${counts[s] === 1 ? "is" : "are"} in ${statusLabel(s)}`);
      const taskIds = relevant.flatMap((s) => cache.getByStatusOldestFirst(s).map((t) => t.id));
      return { text: `${parts.join(", ")}.`, resolvedTaskId: null, taskIds };
    }
    case "OLDEST_TASK_BY_STATUS": {
      const oldest = cache.getOldestTaskInStatus(intent.status);
      if (!oldest) return { text: `There are no tasks in ${statusLabel(intent.status)} right now.`, resolvedTaskId: null };
      const { counts } = cache.getSummary();
      let text = `The oldest task in ${statusLabel(intent.status)} is ${taskLine(oldest)}. There ${counts[intent.status] === 1 ? "is" : "are"} ${counts[intent.status]} task${counts[intent.status] === 1 ? "" : "s"} in ${statusLabel(intent.status)} total.`;
      if (intent.status === "REVIEW") {
        const reviewEnteredAt = cache.getOldestInReview()?.reviewEnteredAt ?? null;
        text += reviewEnteredAt ? ` It entered Review on ${reviewEnteredAt}.` : " (Review-age precision is unavailable for this task — no entry-into-Review event was recorded, so this is sorted by creation date instead.)";
      }
      if (intent.includeBlocking) {
        const validation = ctx.getTaskValidation(projectId, oldest.id, actorId);
        const exec = ctx.getLatestExecution(projectId, oldest.id, actorId);
        if (oldest.status === "REVIEW") text += ` It's waiting on human review${exec?.reviewSummary ? `: ${exec.reviewSummary}` : "."}`;
        else if (oldest.status === "FAILED") text += ` It failed: ${validation.failureReason ?? "no failure reason was recorded."}`;
        else if (oldest.status === "NEEDS_INPUT") text += ` It's waiting on a human answer before work can continue.`;
        if (validation.outcome) text += ` Validation: ${validation.outcome}.`;
      }
      return { text, resolvedTaskId: oldest.id, taskIds: [oldest.id] };
    }
    case "TASK_HANDOFF": {
      const h = ctx.getTaskHandoff(projectId, intent.taskId, actorId);
      const lines = [
        `Task: ${h.title}`,
        `Current state: ${statusLabel(h.currentState)}`,
        `Last model: ${h.lastModelId ?? "not recorded"}`,
        `Last provider: ${h.lastProviderId ?? "not recorded"}`,
        h.completedSummary ? `Last summary: ${h.completedSummary}` : null,
        `Changed files: ${h.changedFiles.length ? h.changedFiles.join(", ") : "none recorded"}`,
        `Revision: ${h.revision ?? "none recorded"}`,
        `Validation: ${h.validationOutcome ?? "not run yet"}`,
        h.openIssue ? `Open issue: ${h.openIssue}` : null,
        `Next action: ${h.nextAction}`,
      ].filter((l): l is string => l !== null);
      return { text: lines.join("\n"), resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "TASK_CHANGES": {
      const changes = ctx.getTaskChanges(projectId, intent.taskId, actorId);
      const title = ctx.getTaskDetail(projectId, intent.taskId, actorId).title;
      return {
        text:
          changes.files.length === 0
            ? `No changed files are recorded for "${title}" yet.`
            : `The last recorded execution of "${title}" changed ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}: ${changes.files.join(", ")}${changes.commitSha ? ` (revision ${changes.commitSha}).` : "."}`,
        resolvedTaskId: intent.taskId,
        taskIds: [intent.taskId],
      };
    }
    case "TASK_VALIDATION": {
      const v = ctx.getTaskValidation(projectId, intent.taskId, actorId);
      const title = ctx.getTaskDetail(projectId, intent.taskId, actorId).title;
      if (!v.outcome) return { text: `No validation has run yet for "${title}".`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      const checksLine = v.checks.length ? v.checks.map((c) => `${c.name}: ${c.passed ? "passed" : "failed"}`).join(", ") : "no checks were configured";
      return { text: `Validation for "${title}": ${v.outcome} (${checksLine}).${v.failureReason ? ` Failure reason: ${v.failureReason}.` : ""}`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "TASK_MODEL_USAGE": {
      const m = ctx.getTaskModelUsage(projectId, intent.taskId, actorId);
      const title = ctx.getTaskDetail(projectId, intent.taskId, actorId).title;
      return {
        text: m.latestModelId
          ? `"${title}" was last worked on by model ${m.latestModelId}${m.latestProviderId ? ` (provider: ${m.latestProviderId})` : ""}, across ${m.runCount} execution${m.runCount === 1 ? "" : "s"}.`
          : `No model/provider is recorded for "${title}" yet.`,
        resolvedTaskId: intent.taskId,
        taskIds: [intent.taskId],
      };
    }
    case "TASK_ORIGIN": {
      const o = ctx.getTaskOrigin(projectId, intent.taskId, actorId);
      const title = ctx.getTaskDetail(projectId, intent.taskId, actorId).title;
      const text =
        o.kind === "backlog_proposal"
          ? `"${title}" was created from an approved backlog proposal (backlog item ${o.backlogItemId}).`
          : o.kind === "manual"
            ? `"${title}" was created directly (manual entry) — not from a backlog proposal.`
            : `The origin of "${title}" isn't recorded.`;
      return { text, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "TASK_EXECUTION": {
      const detail = ctx.getTaskDetail(projectId, intent.taskId, actorId);
      const exec = ctx.getLatestExecution(projectId, intent.taskId, actorId);
      const parts = [`"${detail.title}" is currently ${statusLabel(detail.status)}.`];
      if (exec) {
        parts.push(`The last execution (${exec.role}, model ${exec.modelId ?? "unrecorded"}) ${exec.status === "completed" ? "completed" : exec.status}${exec.summary ? `: ${exec.summary}` : "."}`);
        if (exec.validationOutcome) parts.push(`Validation: ${exec.validationOutcome}.`);
      } else {
        parts.push("No execution has run for it yet.");
      }
      if (detail.status === "REVIEW") parts.push("It's waiting on human review.");
      else if (detail.status === "NEEDS_INPUT") parts.push("It's waiting on a human answer before work can continue.");
      else if (detail.status === "FAILED") {
        const validation = ctx.getTaskValidation(projectId, intent.taskId, actorId);
        parts.push(`It failed: ${validation.failureReason ?? "no failure reason was recorded."}`);
      }
      return { text: parts.join(" "), resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "TASK_FAILURE_REASON": {
      const detail = ctx.getTaskDetail(projectId, intent.taskId, actorId);
      const validation = ctx.getTaskValidation(projectId, intent.taskId, actorId);
      if (detail.status !== "FAILED") {
        return { text: `"${detail.title}" is currently ${statusLabel(detail.status)}. It has not failed.`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      }
      if (validation.failureReason) {
        return { text: `"${detail.title}" marked Failed. Failure reason: ${validation.failureReason}.`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      }
      return { text: `The task "${detail.title}" is marked Failed, but CodeForge does not have a recorded failure reason for that attempt.`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "TASK_RETRY_ELIGIBILITY": {
      const detail = ctx.getTaskDetail(projectId, intent.taskId, actorId);
      if (detail.status === "FAILED") {
        return { text: `"${detail.title}" is marked Failed. CodeForge does not currently support retrying FAILED tasks because FAILED is a terminal state in the task state machine. Create a new task to try again.`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      }
      if (detail.status === "DONE" || detail.status === "CANCELLED") {
        return { text: `"${detail.title}" is ${statusLabel(detail.status)} (terminal state) and cannot be retried.`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      }
      return { text: `"${detail.title}" is currently ${statusLabel(detail.status)}. It is not in a failed state.`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "UPLOAD_COUNT_ITEMS": {
      const items = cache.getImportedItems(intent.importId);
      const { matching, label } = filterImportedItemsByStatus(items, intent.statusFilter);
      return {
        text: `There ${matching.length === 1 ? "is" : "are"} ${matching.length} bug${matching.length === 1 ? "" : "s"} with dev-status ${label} in the uploaded sheet (out of ${items.length} total).`,
        resolvedTaskId: null,
        taskIds: matching.map((it) => it.id),
      };
    }
    case "UPLOAD_LIST_ITEMS": {
      const items = cache.getImportedItems(intent.importId);
      let targetItems = items;
      let label = "all items";
      if (intent.statusFilter && intent.statusFilter.length > 0) {
        const filtered = filterImportedItemsByStatus(items, intent.statusFilter);
        targetItems = filtered.matching;
        label = filtered.label;
      } else if (lastTaskIds && lastTaskIds.length > 0) {
        const matched = items.filter((it) => lastTaskIds.includes(it.id));
        if (matched.length > 0) {
          targetItems = matched;
          label = getImportedItemStatus(matched[0]!);
        }
      }
      if (targetItems.length === 0) {
        return { text: `No bugs in the uploaded sheet match dev-status ${label}.`, resolvedTaskId: null };
      }
      const listStr = targetItems.map((it) => `- "${it.title}" (dev-status: ${getImportedItemStatus(it)})`).join("\n");
      return {
        text: `I found ${targetItems.length} bug${targetItems.length === 1 ? "" : "s"} with dev-status ${label} in the uploaded sheet:\n${listStr}`,
        resolvedTaskId: null,
        taskIds: targetItems.map((it) => it.id),
      };
    }
    case "UPLOAD_SUMMARY": {
      const items = cache.getImportedItems(intent.importId);
      const countsByStatus = new Map<string, number>();
      for (const it of items) {
        const st = getImportedItemStatus(it);
        countsByStatus.set(st, (countsByStatus.get(st) ?? 0) + 1);
      }
      const summaryParts = Array.from(countsByStatus.entries()).map(([st, n]) => `"${st}": ${n}`);
      return { text: `The uploaded sheet has ${items.length} total items. Development status breakdown: ${summaryParts.join(", ")}.`, resolvedTaskId: null };
    }
    case "TASK_PR_STATUS": {
      // Phase 4D.5 — deliberately NEVER derived from TaskStatus: a real call to the Pull Request's own
      // provider (via ContextLayerService.getTaskPullRequestStatus -> TaskService.getPullRequestStatus),
      // the SAME source control integration the automatic PR-merge path already uses.
      const title = ctx.getTaskDetail(projectId, intent.taskId, actorId).title;
      const pr = await ctx.getTaskPullRequestStatus(projectId, intent.taskId, actorId);
      if (!pr.hasPullRequest) return { text: `No PR is associated with "${title}".`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      if (!pr.available) {
        return { text: `I couldn't check the PR status for "${title}" right now — GitHub is currently unavailable (${pr.error ?? "unknown error"}).`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
      }
      const stateLabel = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED_NOT_MERGED" ? "Closed (not merged)" : "Open";
      const prRef = pr.number ? `PR #${pr.number}` : "The PR";
      return { text: `${prRef} for "${title}" is ${stateLabel}.${pr.url ? ` ${pr.url}` : ""}`, resolvedTaskId: intent.taskId, taskIds: [intent.taskId] };
    }
    case "WORKSPACE_CONTEXT": {
      const wc = ctx.getWorkspaceContext(projectId, actorId);
      if (!wc) return { text: "No project context has been set up yet for this project's Workspace.", resolvedTaskId: null };
      const sections = [
        wc.purpose ? `Purpose: ${wc.purpose}` : null,
        wc.architecture.length ? `Architecture: ${wc.architecture.join("; ")}` : null,
        wc.conventions.length ? `Conventions: ${wc.conventions.join("; ")}` : null,
        wc.constraints.length ? `Constraints: ${wc.constraints.join("; ")}` : null,
        wc.validationGuidance.length ? `Validation guidance: ${wc.validationGuidance.join("; ")}` : null,
      ].filter((s): s is string => s !== null);
      return { text: sections.length ? sections.join("\n") : "This project's Workspace context is currently empty.", resolvedTaskId: null };
    }
    case "UNSUPPORTED":
      return { text: `I couldn't answer "${intent.clause}" — ${intent.reason}.`, resolvedTaskId: null };
  }
}

/**
 * Executes ONE action intent through `ActionLayerService` and formats a response STRICTLY from the
 * `ActionResult` it returns — never from the fact that the intent was merely recognized. This is the
 * single place a "✓"/"✕" success or failure sentence is ever produced, and it only ever reflects
 * `result.succeeded` (which the Action Layer itself only sets after its own read-back verification —
 * see action-layer.ts). No other code path in this file may claim a mutation happened.
 */
async function executeAction(
  actions: ActionLayerService,
  projectId: string,
  actorId: string,
  intent: ActionIntent,
  cache: QueryCache,
): Promise<{ text: string; resolvedTaskId: string | null; pendingAction?: ChatPendingAction | null }> {
  if (intent.type === "ACTION_UPLOAD_CREATE_TASKS_PREVIEW") {
    const items = cache.getImportedItems(intent.importId);
    const { matching, label } = filterImportedItemsByStatus(items, intent.statusFilter);
    if (matching.length === 0) {
      return { text: `Found 0 matching bugs with development status: ${label}. No tasks to create.`, resolvedTaskId: null };
    }
    const pendingAction: ChatPendingAction = {
      kind: "UPLOAD_TASK_CREATION",
      importId: intent.importId,
      itemIds: matching.map((it) => it.id),
      filterDescription: label,
      titles: matching.map((it) => it.title),
      createdAt: new Date().toISOString(),
    };
    return {
      text: `Found ${matching.length} matching bug${matching.length === 1 ? "" : "s"} with development status:\n${label}\n\nI can create ${matching.length} Task${matching.length === 1 ? "" : "s"} in BACKLOG. Nothing will be started automatically.\n\nReply "yes" to confirm, or "no" to leave them unchanged.`,
      resolvedTaskId: null,
      pendingAction,
    };
  }

  // BULK actions never mutate here — they only ever produce a PROPOSAL; the actual mutation happens in
  // ChatService, and only after an explicit confirming reply to THIS proposal (see migration 024's own
  // doc comment and ChatService.sendMessage's pending-action handling).
  if (intent.type === "ACTION_BULK_CANCEL" || intent.type === "ACTION_BULK_START") {
    const verb = intent.type === "ACTION_BULK_CANCEL" ? "Cancel" : "Start";
    const titleList = intent.titles.map((t) => `"${t}"`).join(", ");
    const pendingAction: ChatPendingAction = {
      kind: intent.type === "ACTION_BULK_CANCEL" ? "BULK_CANCEL" : "BULK_START",
      status: intent.status,
      taskIds: intent.taskIds,
      titles: intent.titles,
      createdAt: new Date().toISOString(),
    };
    return {
      text: `I found ${intent.taskIds.length} task${intent.taskIds.length === 1 ? "" : "s"} in ${statusLabel(intent.status)}: ${titleList}. ${verb} all of them? Reply "yes" to confirm, or "no" to leave them unchanged.`,
      resolvedTaskId: null,
      pendingAction,
    };
  }

  // Phase 4D.4 — a REVIEW task's completion request NEVER mutates on the first message, regardless of
  // how explicit the wording was ("mark it done now" still only proposes). Only produces a PROPOSAL
  // here; `ActionLayerService.completeTaskAsHuman` runs ONLY after an explicit confirming reply (see
  // ChatService.sendMessage's pending-action handling). Any OTHER status (including already-DONE) goes
  // straight to the existing `markDone` honest-decline/idempotent path below — nothing to confirm there.
  if (intent.type === "ACTION_MARK_DONE" && intent.taskStatus === "REVIEW") {
    const pendingAction: ChatPendingAction = {
      kind: "HUMAN_MARK_DONE",
      taskId: intent.taskId,
      taskTitle: intent.taskTitle,
      observedStatus: intent.taskStatus,
      createdAt: new Date().toISOString(),
    };
    return {
      text: `"${intent.taskTitle}" is currently in Review.\n\nDo you want me to mark it as Done? Reply "yes" to confirm, or "no" to leave it unchanged.`,
      resolvedTaskId: intent.taskId,
      pendingAction,
    };
  }

  let result: ActionResult;
  let createdTaskId: string | undefined;
  switch (intent.type) {
    case "ACTION_CREATE_TASK": {
      const r = await actions.createTask(projectId, actorId, { title: intent.title, description: intent.description });
      result = r;
      createdTaskId = r.taskId;
      break;
    }
    case "ACTION_EDIT_TITLE":
      result = await actions.editTaskTitle(projectId, actorId, intent.taskId, intent.newTitle);
      break;
    case "ACTION_START_TASK":
      result = await actions.startTask(projectId, actorId, intent.taskId);
      break;
    case "ACTION_CANCEL_TASK":
      result = await actions.cancelTask(projectId, actorId, intent.taskId);
      break;
    case "ACTION_MARK_DONE":
      result = await actions.markDone(projectId, actorId, intent.taskId);
      break;
    case "ACTION_RETRY_TASK":
      result = await actions.retryTask(projectId, actorId, intent.taskId);
      break;
  }

  const taskRef = intent.type === "ACTION_CREATE_TASK" ? intent.title : intent.taskTitle;
  if (!result.succeeded) {
    return { text: `✕ I couldn't ${actionVerb(intent.type)} "${taskRef}". ${result.error ?? "No change was made."}`, resolvedTaskId: result.targetTaskId };
  }
  switch (intent.type) {
    case "ACTION_CREATE_TASK":
      return { text: `✓ Created task "${intent.title}" (id ${createdTaskId}) — status Backlog. It has not been started.`, resolvedTaskId: createdTaskId ?? null };
    case "ACTION_EDIT_TITLE":
      return { text: `✓ Renamed to "${result.newState}".`, resolvedTaskId: result.targetTaskId };
    case "ACTION_START_TASK":
      return { text: `✓ "${taskRef}" is now ${statusLabel(result.newState as TaskStatus)}.`, resolvedTaskId: result.targetTaskId };
    case "ACTION_CANCEL_TASK": {
      // Idempotency (Phase 4D.3): an already-CANCELLED task's result still carries newState "CANCELLED"
      // but with an "already..." evidence string (see ActionLayerService.cancelTask) — phrase that as a
      // plain fact, not as if a fresh mutation just happened.
      const alreadyCancelled = result.newState === "CANCELLED" && /already/i.test(result.evidence ?? "");
      const text =
        result.newState === "CANCELLED"
          ? alreadyCancelled
            ? `"${taskRef}" is already Cancelled.`
            : `✓ "${taskRef}" is now Cancelled.`
          : `Cancellation requested for "${taskRef}" — it's still ${statusLabel(result.newState as TaskStatus)} and will finish cancelling shortly.`;
      return { text, resolvedTaskId: result.targetTaskId };
    }
    case "ACTION_MARK_DONE":
      return { text: `"${taskRef}" is already Done.`, resolvedTaskId: result.targetTaskId };
    case "ACTION_RETRY_TASK":
      return { text: `✕ ${result.error}`, resolvedTaskId: result.targetTaskId };
  }
}

function actionVerb(type: ActionIntent["type"]): string {
  switch (type) {
    case "ACTION_CREATE_TASK":
      return "create";
    case "ACTION_EDIT_TITLE":
      return "rename";
    case "ACTION_START_TASK":
      return "start";
    case "ACTION_CANCEL_TASK":
      return "cancel";
    case "ACTION_MARK_DONE":
      return "mark done";
    case "ACTION_RETRY_TASK":
      return "retry";
    case "ACTION_BULK_CANCEL":
      return "cancel";
    case "ACTION_BULK_START":
      return "start";
    case "ACTION_UPLOAD_CREATE_TASKS_PREVIEW":
      return "create tasks";
  }
}

/**
 * Top-level entry point — parses possibly-multiple intents (both reads AND actions), executes every
 * recognized one (never just the first), and composes ONE combined answer. Returns `null` only when
 * NOTHING in the message matched a supported intent at all, so an unrelated free-form question still
 * falls through to the existing LLM path unchanged. Async because an action mutation (and its read-back
 * verification) is asynchronous — reads remain synchronous underneath.
 */
export async function answerDeterministically(
  ctx: ContextLayerService,
  actions: ActionLayerService,
  projectId: string,
  actorId: string,
  text: string,
  lastTaskId: string | null,
  lastTaskIds: string[] | null = null,
  activeImportId: string | null = null,
): Promise<IntentResult | null> {
  const cache = new QueryCache(ctx, projectId, actorId);
  const intents = parseIntents(ctx, projectId, actorId, text, lastTaskId, cache, lastTaskIds, activeImportId);
  // An action clause whose task target failed to resolve still counts as "matched" — falling through to
  // the general LLM here would let the model improvise about a mutation it never performed (exactly the
  // false-action-claim failure mode this phase exists to prevent).
  const matched = intents.filter((i) => i.type !== "UNSUPPORTED" || i.isActionFailure);
  if (matched.length === 0) return null;

  const sections: string[] = [];
  const unanswered: string[] = [];
  let resolvedTaskId: string | null = null;
  // Phase 4D.5 — the ordered list of tasks the LAST list-producing read in this message displayed (a
  // later clause's list supersedes an earlier one's, same "last wins" rule `resolvedTaskId` already uses)
  // — persisted as the conversation's `lastTaskIds` so a LATER message's "the second one" resolves against
  // this, never a stale value from before.
  let lastDisplayedTaskIds: string[] | null = null;
  // At most one bulk proposal is tracked per message — a message proposing two different bulk mutations
  // at once is an edge case outside this phase's scope; the LAST one parsed wins, consistent with how
  // `resolvedTaskId` already takes the last resolved task rather than trying to track several.
  let pendingAction: ChatPendingAction | null = null;
  for (const intent of intents) {
    if (intent.type === "UNSUPPORTED") {
      unanswered.push(`"${intent.clause}" (${intent.reason})`);
      continue;
    }
    if (isActionIntent(intent)) {
      const { text: sectionText, resolvedTaskId: taskId, pendingAction: proposed } = await executeAction(actions, projectId, actorId, intent, cache);
      sections.push(sectionText);
      if (taskId) resolvedTaskId = taskId;
      if (proposed) pendingAction = proposed;
    } else {
      const { text: sectionText, resolvedTaskId: taskId, taskIds } = await formatOne(ctx, projectId, actorId, cache, intent, lastTaskIds);
      sections.push(sectionText);
      if (taskId) resolvedTaskId = taskId;
      if (taskIds && taskIds.length > 0) lastDisplayedTaskIds = taskIds;
    }
  }
  if (resolvedTaskId && (!lastDisplayedTaskIds || lastDisplayedTaskIds.length === 0)) {
    lastDisplayedTaskIds = [resolvedTaskId];
  }
  // Every UNSUPPORTED clause is grouped into one closing line — "Answer the supported parts, then clearly
  // state what couldn't be determined" (Objective: unknown/unsupported sub-question), never several
  // disconnected "I couldn't answer" paragraphs for one message.
  if (unanswered.length > 0) {
    sections.push(`I couldn't answer: ${unanswered.join("; ")}.`);
  }
  return { content: sections.join("\n\n"), resolvedTaskId, pendingAction, lastTaskIds: lastDisplayedTaskIds };
}

/**
 * Formats the result of an ALREADY-EXECUTED bulk mutation (confirmed by the user) — strictly from the
 * real `ActionResult[]` `ActionLayerService.bulkCancel`/`bulkStart` returned after its own per-task
 * read-back verification, exactly like `executeAction` does for a single task. A result is "changed" if
 * it succeeded and wasn't a no-op, "unchanged" if it succeeded but the task was already in the target
 * state (idempotent no-op), or "failed" otherwise — so a mixed outcome (e.g. a FAILED task in the target
 * set that can't legally be cancelled) is reported honestly per-task, never averaged away.
 */
export function formatBulkActionResult(kind: "BULK_CANCEL" | "BULK_START", titles: string[], results: ActionResult[]): string {
  const changed = results.filter((r) => r.succeeded && !/already/i.test(r.evidence ?? "")).length;
  const unchanged = results.filter((r) => r.succeeded && /already/i.test(r.evidence ?? "")).length;
  const failed = results.filter((r) => !r.succeeded).length;
  const verb = kind === "BULK_CANCEL" ? "Cancelled" : "Started";
  const lines = results.map((r, i) => {
    const title = titles[i] ?? "task";
    return r.succeeded ? `✓ "${title}" — ${r.evidence ?? `now ${r.newState}`}` : `✕ "${title}" — ${r.error ?? "no change made"}`;
  });
  const summary = `${verb} ${changed} of ${results.length} task${results.length === 1 ? "" : "s"}${unchanged > 0 ? ` (${unchanged} already in that state)` : ""}${failed > 0 ? ` (${failed} failed)` : ""}.`;
  return [summary, ...lines].join("\n");
}

/**
 * Formats the result of an ALREADY-EXECUTED human-confirmed completion (Phase 4D.4) — strictly from the
 * real `ActionResult` `ActionLayerService.completeTaskAsHuman` returned after its own read-back
 * verification, exactly like every other confirmed-mutation formatter here. Never composed from the fact
 * that a confirmation was merely received.
 */
export function formatHumanCompletionResult(title: string, result: ActionResult): string {
  if (!result.succeeded) {
    return `✕ I couldn't mark "${title}" as Done. ${result.error ?? "No change was made."}`;
  }
  if (/already/i.test(result.evidence ?? "")) {
    return `"${title}" is already Done. No additional change was made.`;
  }
  return `✓ "${title}" is now Done.`;
}

function statusLabel(s: TaskStatus | string): string {
  switch (s) {
    case "BACKLOG": return "Backlog";
    case "TODO": return "To do";
    case "WORKING": return "Working";
    case "NEEDS_INPUT": return "Needs input";
    case "REVIEW": return "Review";
    case "DONE": return "Done";
    case "FAILED": return "Failed";
    case "CANCELLED": return "Cancelled";
    default: return String(s);
  }
}

function taskLine(t: Task | { id: string; title: string; status: TaskStatus }): string {
  return `"${t.title}" (${statusLabel(t.status)})`;
}

export function splitIntoClauses(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let masked = trimmed;
  // Protect quotes
  masked = masked.replace(/"[^"]*"/g, (m) => "\u0000".repeat(m.length));
  // Protect parens and brackets
  masked = masked.replace(/\([^\)]*\)/g, (m) => "\u0000".repeat(m.length));
  masked = masked.replace(/\[[^\]]*\]/g, (m) => "\u0000".repeat(m.length));
  // Protect BUG-ID lists
  masked = masked.replace(/(?:BUG-\d+|TASK-\d+)(?:\s*,\s*(?:BUG-\d+|TASK-\d+))+/gi, (m) => "\u0000".repeat(m.length));
  // Protect status enumerations like "Backlog, To Do, Working, Needs Input, Review, Done and Failed" and upload dev-statuses ("open and Add-on – not built")
  masked = masked.replace(/(?:Backlog|To Do|Working|Needs Input|Review|Done|Failed|Cancelled|open|add-on|not built|Add-on\s*[\u2010\u2013\u2014\u2015-]\s*not built)(?:[\s,]+(?:and\s+)?(?:Backlog|To Do|Working|Needs Input|Review|Done|Failed|Cancelled|open|add-on|not built|Add-on\s*[\u2010\u2013\u2014\u2015-]\s*not built))+/gi, (m) => "\u0000".repeat(m.length));

  const rawSplits: string[] = [];
  let currentStart = 0;
  let match: RegExpExecArray | null;

  const regex = /(?:[\?!;]|\b(?:,\s*)?and\s+|,)/gi;
  while ((match = regex.exec(masked)) !== null) {
    const splitPos = match.index;
    const matchLen = match[0].length;
    const part = trimmed.slice(currentStart, splitPos).trim();
    if (part) {
      rawSplits.push(part);
    }
    currentStart = splitPos + matchLen;
  }
  const lastPart = trimmed.slice(currentStart).trim();
  if (lastPart) {
    rawSplits.push(lastPart);
  }

  const result = rawSplits.filter(Boolean);
  return result.length > 0 ? result : [trimmed];
}
