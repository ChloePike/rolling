export type Messages = Record<string, string>;

/**
 * Merges one locale's feature files (`messages/<locale>/<feature>.json`) into one map.
 * Keys are globally unique, prefixed with the feature name (`home.`, `canvas.`, ...).
 * Empty strings are dropped so the English text shows instead of a blank.
 */
export function mergeMessages(files: Record<string, Messages>): Messages {
  const merged: Messages = {};
  for (const [path, messages] of Object.entries(files)) {
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value !== 'string' || value === '') continue;
      if (key in merged && import.meta.env.DEV) console.warn(`Duplicate message key "${key}" in ${path}`);
      merged[key] = value;
    }
  }
  return merged;
}
