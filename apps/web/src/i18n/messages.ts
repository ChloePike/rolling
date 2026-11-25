import type { Locale } from './locale';

export type Messages = Record<string, string>;

// One JSON file per locale at the repo root; each non-default locale becomes its own chunk.
const loaders = import.meta.glob<Messages>('@messages/*.json', { import: 'default' });

export async function loadMessages(locale: Locale | string): Promise<Messages> {
  const entry = Object.entries(loaders).find(([path]) => path.endsWith(`/${locale}.json`));
  if (!entry) throw new Error(`No messages for locale "${locale}"`);
  return entry[1]();
}
