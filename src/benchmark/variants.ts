import { BASELINE_RANK_CONFIG } from "../backlog/index-selection.js";
import type { SelectionTuning } from "../backlog/context-builder.js";

/**
 * Named selection configurations for the retrieval benchmark. Each is a hypothesis about ranking or excerpt choice,
 * MEASURED before it is adopted — `baseline` reproduces Phase 4A.3 exactly; `current` is what production runs.
 */
/** The Phase 4A.3 excerpt limits — used by `baseline` and `name-only` so they remain an exact "before" whatever the production defaults become. */
export const LEGACY_EXCERPTS = { maxFiles: 6, maxCharsPerFile: 3000, maxTotalChars: 16_000 } as const;

export const RETRIEVAL_VARIANTS: Record<string, SelectionTuning> = {
  baseline: { rank: { ...BASELINE_RANK_CONFIG }, excerpts: { ...LEGACY_EXCERPTS } },
  "exact-mentions": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12 } },
  saturation: { rank: { ...BASELINE_RANK_CONFIG, evidenceSaturation: 0.35 } },
  "exact+saturation": { rank: { ...BASELINE_RANK_CONFIG, evidenceSaturation: 0.35, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12 } },
  "exact+saturation+10excerpts": { rank: { ...BASELINE_RANK_CONFIG, evidenceSaturation: 0.35, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12 }, excerpts: { maxFiles: 10, maxCharsPerFile: 1800 } },
  "baseline+10excerpts": { rank: { ...BASELINE_RANK_CONFIG }, excerpts: { maxFiles: 10, maxCharsPerFile: 1800 } },
  "exact+word-symbols": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, symbolMatch: "word" } },
  "exact+query600": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, queryWordChars: 600 } },
  "exact+query300": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, queryWordChars: 300 } },
  "exact+10excerpts": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12 }, excerpts: { maxFiles: 10, maxCharsPerFile: 1800 } },
  "exact+8excerpts": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12 }, excerpts: { maxFiles: 8, maxCharsPerFile: 2200 } },
  "exact+q600+word": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, queryWordChars: 600, symbolMatch: "word" } },
  "exact+q600+word+8exc": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, queryWordChars: 600, symbolMatch: "word" }, excerpts: { maxFiles: 8, maxCharsPerFile: 2200 } },
  "exact+q600+8exc": { rank: { ...BASELINE_RANK_CONFIG, exactPathBonus: 40, exactFileBonus: 25, exactIdentifierBonus: 12, queryWordChars: 600 }, excerpts: { maxFiles: 8, maxCharsPerFile: 2200 } },
  /** Production default (DEFAULT_RANK_CONFIG + EXCERPT_LIMITS). */
  current: {},
};
