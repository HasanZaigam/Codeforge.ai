import type { CostMetadata } from "../domain/types.js";

/**
 * Token accounting shared by every place CodeForge shows "how many tokens did this use" (TD-63).
 *
 * A count is either REPORTED (the engine/provider said so) or ESTIMATED (~4 characters per token over
 * text the platform actually sent and received). The two are never blended silently: every count carries
 * `estimated`, and the UI labels estimates. Where neither is possible (an agent run that reported nothing
 * and whose prompt isn't stored) the count is null — never a made-up number.
 */
export interface TokenCount {
  tokens: number;
  estimated: boolean;
}

/** The rough English/code average used for estimates. Deliberately simple and documented, not tuned. */
export const CHARS_PER_TOKEN = 4;

/** Input + output + reasoning tokens the engine reported; null when it reported none of them. Cache reads/writes are part of input, not added again. */
export function reportedTokens(cost: CostMetadata | null | undefined): number | null {
  if (!cost) return null;
  const parts = [cost.inputTokens, cost.outputTokens, cost.reasoningTokens].filter((v): v is number => typeof v === "number");
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** Reported tokens when available, else an estimate from the characters actually exchanged, else null. */
export function tokenCountFor(cost: CostMetadata | null | undefined, exchangedChars?: number | null): TokenCount | null {
  const reported = reportedTokens(cost);
  if (reported !== null) return { tokens: reported, estimated: false };
  if (typeof exchangedChars === "number" && exchangedChars > 0) return { tokens: estimateTokensFromChars(exchangedChars), estimated: true };
  return null;
}

/** First instant of the calendar month (UTC) containing `now` — budgets are monthly. */
export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
