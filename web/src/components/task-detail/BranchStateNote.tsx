import type { BranchStateDTO, TaskDTO } from "../../api/index.js";
import { ToneBadge } from "../common/ToneBadge.js";
import type { Tone } from "../../lib/tone.js";

/**
 * Reuses the exact same tone-badge visual language TaskStatus already uses
 * (see StatusBadge/statusMeta.ts/tone.ts) — no new visual language
 * introduced. Detection only (see /docs/TASK_LIFECYCLE.md "Stale/behind
 * detection" and "Merge/conflict state"): this never offers a rebase/merge
 * action, only informs.
 */
const MERGE_STATE_META: Record<BranchStateDTO["mergeState"], { label: string; tone: Tone } | null> = {
  READY: null, // nothing worth calling out — avoid noise for the common case
  BEHIND: null, // already surfaced via the more specific `behindLabel` below ("N commits behind…") — avoid a redundant second badge
  CONFLICT: { label: "Merge conflict", tone: "danger" },
  MERGED: null, // task status itself already communicates completion (DONE + "PR #N merged")
  CLOSED_NOT_MERGED: { label: "Closed without merging", tone: "neutral" },
  NOT_APPLICABLE: null, // local-git: no real PR/merge concept — nothing honest to show
  UNKNOWN: null, // no PR opened yet, or the provider read failed — nothing to warn about yet
};

export function BranchStateNote({ task, branchState }: { task: TaskDTO; branchState: BranchStateDTO | undefined }) {
  if (!branchState || !task.branchName) return null;

  const behindLabel =
    branchState.comparable && branchState.behindBy !== null && branchState.behindBy > 0
      ? `${branchState.behindBy} commit${branchState.behindBy === 1 ? "" : "s"} behind ${task.branchMode === "existing" ? "its base" : "base"} branch`
      : null;

  const mergeMeta = MERGE_STATE_META[branchState.mergeState];

  if (!behindLabel && !mergeMeta) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {behindLabel && <ToneBadge tone="attention">{behindLabel}</ToneBadge>}
      {mergeMeta && <ToneBadge tone={mergeMeta.tone}>{mergeMeta.label}</ToneBadge>}
    </div>
  );
}
