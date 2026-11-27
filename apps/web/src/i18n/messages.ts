import type { Locale } from './locale';
import { mergeMessages, type Messages } from './merge';

export { mergeMessages, type Messages };

/**
 * Messages live in one folder per locale with one JSON file per feature
 * (`messages/<locale>/<feature>.json`), so features can be built in parallel
 * without editing a shared file. Keys must be globally unique; prefix them with
 * the feature name (`home.`, `canvas.`, ...). Files are merged per locale.
 *
 * English ships in the main bundle (first-paint features; see below). Every other locale is one lazy chunk
 * (`./locales/<locale>.ts`), so adding a locale never grows the English bundle.
 * `email.json` holds the Worker's email templates and is not bundled here.
 */
/**
 * English is split in two (bundle splitting, 2026-11-27). The features Home's first
 * paint needs (the list below: the shell, Home, the prompt box, overlays, picker,
 * templates, transfers, PWA, sign-in, agent, trial and trust banners) ship in the main
 * bundle. Every other feature file — and any new one by default — loads after the
 * first render with `loadEnglishRest()`, which fills `englishMessages` in place: the
 * root route's loader awaits it for any route but `/`, every on-demand layer
 * (`lib/lazy.tsx`) awaits it with its chunk, and `loadMessages` awaits it before
 * filling a translation's gaps. The rest is one chunk (`./englishRest.ts`); its list
 * mirrors the one below (`englishRest.test.ts` checks).
 */
const englishFirstPaint = import.meta.glob<Messages>('@messages/en/{shell,home,prompt,overlays,picker,templates,transfers,pwa,auth,agent,trial,trust}.json', {
  import: 'default',
  eager: true,
});

export const englishMessages: Messages = mergeMessages(englishFirstPaint);

let restReady: Promise<void> | null = null;
/** Loads the English feature files outside the first-paint list into `englishMessages` (once; retried after a failure). */
export function loadEnglishRest(): Promise<void> {
  restReady ??= import('./englishRest').then(
    (m) => void Object.assign(englishMessages, m.default),
    (e: unknown) => {
      restReady = null;
      throw e;
    },
  );
  return restReady;
}

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
  const [own] = await Promise.all([loadLocaleMessages(locale), loadEnglishRest()]);
  const merged = { ...englishMessages, ...own };
  cache.set(locale, merged);
  return merged;
}
