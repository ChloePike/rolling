import { DEFAULT_CONFIRM_THRESHOLD_CREDITS } from '@rolling/core/pricing/config';
import { useSyncExternalStore } from 'react';
import { LOCALE_PREF_KEY } from '@/i18n/locale';

/**
 * Client preferences: one shared state for the header settings popover,
 * Settings → Preferences, the prompt boxes and the run flow (interaction pass:
 * every place that shows a preference reads and writes the same value).
 * Stored in localStorage until `PATCH /api/me/prefs` lands; the server copy
 * wins once it exists.
 *
 * API:
 * - `usePrefs()` / `getPrefs()` read everything, `usePref(key)` one value;
 * - `setPref(key, value)` / `setPrefs(patch)` write and notify every reader;
 * - the older helpers (`useCreationMode`, `setLanguage`, ...) stay as thin wrappers.
 *
 * Writers dispatch `rolling:creation-mode` (creation mode, kept for existing
 * listeners) and `rolling:prefs` so readers in this tab update at once; the
 * `storage` event covers other tabs.
 */

export type CreationMode = 'simple' | 'advanced';
/** D-010: follow the system (default) or force a theme. */
export type ThemePref = 'system' | 'light' | 'dark';

/** A language the UI offers (handoff 6). `translated: false` falls back to English text with local formats. */
export interface LanguageOption {
  /** BCP 47 tag. */
  tag: string;
  /** Endonym shown in pickers (proper names, not UI copy). */
  name: string;
  wave: 'source' | 'first' | 'second';
  translated: boolean;
}

/** Handoff 6: English source; first wave ja, zh-TW, zh-HK, ko; second wave id, th, vi, es, pt-BR, de, fr. */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { tag: 'en', name: 'English', wave: 'source', translated: true },
  { tag: 'ja', name: '日本語', wave: 'first', translated: false },
  { tag: 'zh-TW', name: '繁體中文（台灣）', wave: 'first', translated: false },
  { tag: 'zh-HK', name: '繁體中文（香港）', wave: 'first', translated: false },
  { tag: 'ko', name: '한국어', wave: 'first', translated: false },
  { tag: 'id', name: 'Bahasa Indonesia', wave: 'second', translated: false },
  { tag: 'th', name: 'ไทย', wave: 'second', translated: false },
  { tag: 'vi', name: 'Tiếng Việt', wave: 'second', translated: false },
  { tag: 'es', name: 'Español', wave: 'second', translated: false },
  { tag: 'pt-BR', name: 'Português (Brasil)', wave: 'second', translated: false },
  { tag: 'de', name: 'Deutsch', wave: 'second', translated: false },
  { tag: 'fr', name: 'Français', wave: 'second', translated: false },
];

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'JPY', 'TWD', 'HKD', 'KRW', 'IDR', 'THB', 'VND', 'BRL'] as const;
export type CurrencyCode = (typeof CURRENCY_OPTIONS)[number];

export const ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:5', '21:9'] as const;
export type AspectRatioPref = (typeof ASPECT_RATIO_OPTIONS)[number];

export const THEME_OPTIONS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** "Confirm before running" choices in credits (0 = always confirm). D-006 default 300. */
export const CONFIRM_THRESHOLD_OPTIONS = [0, 100, DEFAULT_CONFIRM_THRESHOLD_CREDITS, 1000] as const;

export interface Prefs {
  creationMode: CreationMode;
  /** Saved language (BCP 47), or null to follow the browser. */
  language: string | null;
  currency: CurrencyCode;
  defaultAspectRatio: AspectRatioPref;
  /** Default video model id, or "auto". */
  defaultModel: string;
  notifyWhenDone: boolean;
  theme: ThemePref;
  /** Runs quoted below this many credits start without the run confirm (0 = always confirm). */
  confirmThreshold: number;
  /** D-005 visibility preference; only offered to members whose workspace allows it. */
  matureContent: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  creationMode: 'simple',
  language: null,
  currency: 'USD',
  defaultAspectRatio: '9:16',
  defaultModel: 'auto',
  notifyWhenDone: true,
  theme: 'system',
  confirmThreshold: DEFAULT_CONFIRM_THRESHOLD_CREDITS,
  matureContent: false,
};

export const CREATION_MODE_KEY = 'rolling.creationMode';
/** The i18n provider resolves the UI locale from this key. */
export const LANGUAGE_KEY = LOCALE_PREF_KEY;
/** Every other preference, as one JSON object. */
export const PREFS_KEY = 'rolling.prefs';
export const CREATION_MODE_EVENT = 'rolling:creation-mode';
export const PREFS_EVENT = 'rolling:prefs';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* Storage unavailable; readers fall back to defaults. */
  }
}

const oneOf = <T extends string | number>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

function parse(creationRaw: string | null, languageRaw: string | null, rest: string | null): Prefs {
  let o: Partial<Record<keyof Prefs, unknown>> = {};
  try {
    o = rest ? (JSON.parse(rest) as typeof o) : {};
  } catch {
    o = {};
  }
  const threshold = typeof o.confirmThreshold === 'number' && o.confirmThreshold >= 0 ? Math.round(o.confirmThreshold) : DEFAULT_PREFS.confirmThreshold;
  return {
    creationMode: creationRaw === 'advanced' ? 'advanced' : 'simple',
    language: languageRaw || null,
    currency: oneOf(CURRENCY_OPTIONS, o.currency, DEFAULT_PREFS.currency),
    defaultAspectRatio: oneOf(ASPECT_RATIO_OPTIONS, o.defaultAspectRatio, DEFAULT_PREFS.defaultAspectRatio),
    defaultModel: typeof o.defaultModel === 'string' && o.defaultModel ? o.defaultModel : DEFAULT_PREFS.defaultModel,
    notifyWhenDone: typeof o.notifyWhenDone === 'boolean' ? o.notifyWhenDone : DEFAULT_PREFS.notifyWhenDone,
    theme: oneOf(THEME_OPTIONS, o.theme, DEFAULT_PREFS.theme),
    confirmThreshold: threshold,
    matureContent: o.matureContent === true,
  };
}

// useSyncExternalStore needs a stable snapshot: re-parse only when the raw values change.
let cacheKey = '';
let cache: Prefs = DEFAULT_PREFS;

export function getPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  const c = read(CREATION_MODE_KEY);
  const l = read(LANGUAGE_KEY);
  const r = read(PREFS_KEY);
  const key = `${c}\u0000${l}\u0000${r}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cache = parse(c, l, r);
  }
  return cache;
}

/** Writes some preferences and notifies every reader in this tab. */
export function setPrefs(patch: Partial<Prefs>) {
  const cur = getPrefs();
  const next = { ...cur, ...patch };
  if ('creationMode' in patch) write(CREATION_MODE_KEY, next.creationMode);
  if ('language' in patch) write(LANGUAGE_KEY, next.language);
  const { creationMode: _c, language: _l, ...rest } = next;
  write(PREFS_KEY, JSON.stringify(rest));
  if ('creationMode' in patch) window.dispatchEvent(new CustomEvent(CREATION_MODE_EVENT, { detail: next.creationMode }));
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: patch }));
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  setPrefs({ [key]: value } as Partial<Prefs>);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CREATION_MODE_EVENT, onChange);
  window.addEventListener(PREFS_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CREATION_MODE_EVENT, onChange);
    window.removeEventListener(PREFS_EVENT, onChange);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS);
}

export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSyncExternalStore(
    subscribe,
    () => getPrefs()[key],
    () => DEFAULT_PREFS[key],
  );
}

// Older helpers, kept stable for existing callers.

export function getCreationMode(): CreationMode {
  return getPrefs().creationMode;
}

export function setCreationMode(mode: CreationMode) {
  setPrefs({ creationMode: mode });
}

/** Saved language preference (a BCP 47 tag), or null to follow the browser. */
export function getLanguage(): string | null {
  return getPrefs().language;
}

export function setLanguage(tag: string | null) {
  setPrefs({ language: tag });
}

export function useCreationMode(): CreationMode {
  return usePref('creationMode');
}

export function useLanguagePref(): string | null {
  return usePref('language');
}

/** The language option for a tag (exact, then base language). */
export function languageOption(tag: string | null | undefined): LanguageOption | undefined {
  if (!tag) return undefined;
  const lower = tag.toLowerCase();
  return LANGUAGE_OPTIONS.find((o) => o.tag.toLowerCase() === lower) ?? LANGUAGE_OPTIONS.find((o) => o.tag.toLowerCase() === lower.split('-')[0]);
}

export { applyTheme, resolvedTheme } from './theme';
export { convertUsd, formatPrice, useFormatPrice, MOCK_USD_RATES } from './currency';

// D-010: apply the theme preference as soon as prefs load, and keep it applied.
import { applyTheme as apply } from './theme';
if (typeof window !== 'undefined') {
  apply(getPrefs().theme);
  window.addEventListener(PREFS_EVENT, () => apply(getPrefs().theme));
  window.addEventListener('storage', () => apply(getPrefs().theme));
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => apply(getPrefs().theme));
}
