import type { Locale } from './locale';
import { mergeMessages, type Messages } from './merge';

export { mergeMessages, type Messages };

/**
 * Messages live in one folder per locale with one JSON file per feature
 * (`messages/<locale>/<feature>.json`), so features can be built in parallel
 * without editing a shared file. Keys must be globally unique; prefix them with
 * the feature name (`home.`, `canvas.`, ...). Files are merged per locale.
 *
 * English ships in the main bundle. Every other locale is one lazy chunk
 * (`./locales/<locale>.ts`), so adding a locale never grows the English bundle.
 * `email.json` holds the Worker's email templates and is not bundled here.
 */
const english = import.meta.glob<Messages>(['@messages/en/*.json', '!@messages/en/email.json'], { import: 'default', eager: true });

export const englishMessages: Messages = mergeMessages(english);

/** Lazy loaders, one chunk per translated locale. */
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Messages }>> = {
  'zh-CN': () => import('./locales/zh-CN'),
  'zh-TW': () => import('./locales/zh-TW'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
};

/** The locale's own messages, without the English fallback (for checks and tests). */
export async function loadLocaleMessages(locale: Locale | string): Promise<Messages> {
  if (locale === 'en') return englishMessages;
  const load = (LOADERS as Record<string, (() => Promise<{ default: Messages }>) | undefined>)[locale];
  if (!load) throw new Error(`No messages for locale "${locale}"`);
  return (await load()).default;
}

/** A locale's messages with English filling every key it has not translated yet (per key). */
const cache = new Map<string, Messages>();
export async function loadMessages(locale: Locale | string): Promise<Messages> {
  const hit = cache.get(locale);
  if (hit) return hit;
  const merged = { ...englishMessages, ...(await loadLocaleMessages(locale)) };
  cache.set(locale, merged);
  return merged;
}
