/** Compact token figure: 950, 12.3K, 4.56M. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

/** "2,847 tokens" when reported, "~3.2K tokens (est.)" when estimated — estimates are always labelled. */
export function tokenLabel(tokens: number, estimated: boolean): string {
  return estimated ? `~${formatTokens(tokens)} tokens (est.)` : `${formatTokens(tokens)} tokens`;
}
