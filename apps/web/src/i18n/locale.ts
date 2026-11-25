/** Locales with a messages/<locale>.json file. English is the source locale. */
export const SUPPORTED_LOCALES = ['en'] as const;
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

/** Finds the best supported match for one requested tag: exact, then by base language. */
export function matchLocale(tag: string, supported: readonly string[]): string | null {
  const c = canonical(tag);
  if (!c) return null;
  const exact = supported.find((s) => s.toLowerCase() === c.toLowerCase());
  if (exact) return exact;
  const base = c.split('-')[0]!.toLowerCase();
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

export function readLocalePreference(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_PREF_KEY);
  } catch {
    return null;
  }
}

export function browserLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}
