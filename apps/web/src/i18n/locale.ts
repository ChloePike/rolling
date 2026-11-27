/**
 * Locales with translated messages (`messages/<locale>/<feature>.json`, D-023).
 * English is the source locale and ships in the main bundle; the others load lazily.
 */
export const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Local stand-in for the server-side `prefs.locale` until M1 wires prefs. */
export const LOCALE_PREF_KEY = 'rolling.locale';

function canonical(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

const TRADITIONAL_REGIONS = new Set(['TW', 'HK', 'MO']);

/**
 * Chinese by script, then region: Hant, TW, HK and MO read Traditional; Hans, CN, SG and a bare
 * `zh` read Simplified. Returns the first of `zh-TW` / `zh-CN` that `supported` lists, else null.
 */
function matchChinese(c: string, supported: readonly string[]): string | null {
  const parts = c.split('-').slice(1);
  const script = parts.find((p) => /^[A-Za-z]{4}$/.test(p))?.toLowerCase();
  const region = parts.find((p) => /^([A-Za-z]{2}|\d{3})$/.test(p))?.toUpperCase();
  const traditional = script ? script === 'hant' : region ? TRADITIONAL_REGIONS.has(region) : false;
  const want = traditional ? 'zh-tw' : 'zh-cn';
  return supported.find((s) => s.toLowerCase() === want) ?? null;
}

/** Finds the best supported match for one requested tag: exact, then Chinese by script, then by base language. */
export function matchLocale(tag: string, supported: readonly string[]): string | null {
  const c = canonical(tag);
  if (!c) return null;
  const exact = supported.find((s) => s.toLowerCase() === c.toLowerCase());
  if (exact) return exact;
  const base = c.split('-')[0]!.toLowerCase();
  if (base === 'zh') return matchChinese(c, supported);
  return supported.find((s) => s.toLowerCase() === base) ?? null;
}

/**
 * Resolution order: saved preference, then the browser languages in order,
 * then English.
 */
export function resolveLocale(
  preference: string | null | undefined,
  browserLocales: readonly string[],
  supported: readonly string[] = SUPPORTED_LOCALES,
): string {
  if (preference) {
    const m = matchLocale(preference, supported);
    if (m) return m;
  }
  for (const tag of browserLocales) {
    const m = matchLocale(tag, supported);
    if (m) return m;
  }
  return DEFAULT_LOCALE;
}

export function browserLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}
