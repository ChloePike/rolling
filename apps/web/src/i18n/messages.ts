import type { Locale } from './locale';

export type Messages = Record<string, string>;

/**
 * Messages live in one folder per locale with one JSON file per feature
 * (`messages/<locale>/<feature>.json`), so features can be built in parallel
 * without editing a shared file. Keys must be globally unique; prefix them with
 * the feature name (`home.`, `canvas.`, ...). Files are merged per locale.
 */
const english = import.meta.glob<Messages>('@messages/en/*.json', { import: 'default', eager: true });
const others = import.meta.glob<Messages>(['@messages/*/*.json', '!@messages/en/*.json'], { import: 'default' });

export function mergeMessages(files: Record<string, Messages>): Messages {
  const merged: Messages = {};
  for (const [path, messages] of Object.entries(files)) {
    for (const [key, value] of Object.entries(messages)) {
      if (key in merged && import.meta.env.DEV) console.warn(`Duplicate message key "${key}" in ${path}`);
      merged[key] = value;
    }
  }
  return merged;
}

export const englishMessages: Messages = mergeMessages(english);

export async function loadMessages(locale: Locale | string): Promise<Messages> {
  const entries = Object.entries(others).filter(([path]) => path.includes(`/${locale}/`));
  if (!entries.length) throw new Error(`No messages for locale "${locale}"`);
  const loaded = await Promise.all(entries.map(async ([path, load]) => [path, await load()] as const));
  // Fall back to English for keys a locale has not translated yet.
  return { ...englishMessages, ...mergeMessages(Object.fromEntries(loaded)) };
}
