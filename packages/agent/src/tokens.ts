/**
 * Cheap token estimator for context budgeting. Not exact: it only has to keep
 * a turn safely under the budget. Latin text averages ~4 characters per token;
 * CJK, Hangul and kana are close to one token per character; JSON punctuation
 * is denser than prose, so it counts a little extra.
 */
const WIDE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
const PUNCT = /[{}[\]":,]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const wide = text.match(WIDE)?.length ?? 0;
  const punct = text.match(PUNCT)?.length ?? 0;
  const rest = text.length - wide;
  return Math.ceil(wide + rest / 4 + punct * 0.25);
}

/** Tokens of a value as it is sent (JSON for objects). */
export function estimateValueTokens(value: unknown): number {
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value) ?? '');
}

/** Cuts `text` so it fits in about `maxTokens`, marking the cut. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens - 8) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)} …[truncated]`;
}
