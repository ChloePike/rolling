import { DEFAULT_CONFIRM_THRESHOLD_CREDITS } from '@rolling/core/pricing/config';
import { useSyncExternalStore } from 'react';
import { LOCALE_PREF_KEY } from '@/i18n/locale';

/**
 * Client preferences: one shared state for the header settings popover,
 * Settings → Preferences, the prompt boxes and the run flow (interaction pass:
 * every place that shows a preference reads and writes the same value).
 *
 * Signed in (real API), the server copy wins: `GET /api/me` and the
 * `prefs.changed` socket message (other tabs and devices) are applied with
 * `applyServerPrefs`, and every write goes to `PATCH /api/me/prefs` through the
 * remote writer `lib/session` registers (optimistic: the local value changes
 * at once and rolls back if the server refuses). localStorage stays as the
 * pre-paint cache (the theme script in index.html) and the only store for
 * signed-out visitors.
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
  /** Email when credits run low (server `notifications.low`). */
  notifyCreditsLow: boolean;
  /** Email before the plan renews (server `notifications.renewal`). */
  notifyPlanRenewal: boolean;
  /** Product updates (server `notifications.product`). */
  notifyProductUpdates: boolean;
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
  notifyCreditsLow: true,
  notifyPlanRenewal: true,
  notifyProductUpdates: false,
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
    notifyCreditsLow: typeof o.notifyCreditsLow === 'boolean' ? o.notifyCreditsLow : DEFAULT_PREFS.notifyCreditsLow,
    notifyPlanRenewal: typeof o.notifyPlanRenewal === 'boolean' ? o.notifyPlanRenewal : DEFAULT_PREFS.notifyPlanRenewal,
    notifyProductUpdates: typeof o.notifyProductUpdates === 'boolean' ? o.notifyProductUpdates : DEFAULT_PREFS.notifyProductUpdates,
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

/** Writes the local cache and notifies every reader in this tab (no server call). */
function writeLocal(patch: Partial<Prefs>) {
  const cur = getPrefs();
  const next = { ...cur, ...patch };
  if ('creationMode' in patch) write(CREATION_MODE_KEY, next.creationMode);
  if ('language' in patch) write(LANGUAGE_KEY, next.language);
  const { creationMode: _c, language: _l, ...rest } = next;
  write(PREFS_KEY, JSON.stringify(rest));
  if ('creationMode' in patch) window.dispatchEvent(new CustomEvent(CREATION_MODE_EVENT, { detail: next.creationMode }));
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: patch }));
}

/** Saves a patch on the server; resolves with what the server stored. Registered by lib/session while signed in. */
export type PrefsRemote = (patch: Partial<Prefs>) => Promise<Partial<Prefs> | void>;
let remote: PrefsRemote | null = null;

/** lib/session: route writes to `PATCH /api/me/prefs` (null when signed out or in mock mode). */
export function registerPrefsRemote(writer: PrefsRemote | null) {
  remote = writer;
}

/** Fired on `window` when a server save fails and the local value was rolled back. */
export const PREFS_ERROR_EVENT = 'rolling:prefs-error';
export interface PrefsErrorDetail {
  patch: Partial<Prefs>;
  error: unknown;
}

/**
 * Writes preferences: local at once, then the server when signed in. Rejects
 * (after rolling back the keys it changed, unless another write changed them
 * since) when the server refuses, e.g. `NO_PLAN` for mature content.
 */
const pending = new Map<keyof Prefs, number>();

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const before = getPrefs();
  const keys = Object.keys(patch) as (keyof Prefs)[];
  const prev: Partial<Prefs> = {};
  for (const k of Object.keys(patch) as (keyof Prefs)[]) (prev as Record<string, unknown>)[k] = before[k];
  writeLocal(patch);
  if (!remote) return;
  for (const k of keys) pending.set(k, (pending.get(k) ?? 0) + 1);
  try {
    const stored = await remote(patch);
    if (stored && Object.keys(stored).length) writeLocal(stored);
  } catch (error) {
    const now = getPrefs();
    const rollback: Partial<Prefs> = {};
    for (const k of Object.keys(patch) as (keyof Prefs)[]) {
      if (now[k] === patch[k]) (rollback as Record<string, unknown>)[k] = prev[k];
    }
    if (Object.keys(rollback).length) writeLocal(rollback);
    window.dispatchEvent(new CustomEvent<PrefsErrorDetail>(PREFS_ERROR_EVENT, { detail: { patch, error } }));
    throw error;
  } finally {
    for (const k of keys) {
      const n = (pending.get(k) ?? 1) - 1;
      if (n > 0) pending.set(k, n);
      else pending.delete(k);
    }
  }
}

/** Writes some preferences and notifies every reader; server errors surface as `PREFS_ERROR_EVENT`. */
export function setPrefs(patch: Partial<Prefs>) {
  savePrefs(patch).catch(() => {
    /* Rolled back; PREFS_ERROR_EVENT tells the UI. */
  });
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  setPrefs({ [key]: value } as Partial<Prefs>);
}

// Server shape (docs/api.md → Account) <-> client prefs.

export interface ServerPrefsShape {
  language: string;
  currency: string;
  creationMode: 'simple' | 'advanced';
  defaultRatio: string;
  defaultModel: string;
  confirmThreshold: number;
  notifications: { done: boolean; low: boolean; renewal: boolean; product: boolean };
  theme: ThemePref;
  matureContent: boolean;
}

export type ServerPrefsPatchShape = Partial<Omit<ServerPrefsShape, 'notifications'>> & { notifications?: Partial<ServerPrefsShape['notifications']> };

/** Supported server language for a client tag (null = follow the browser). */
export function serverLanguage(tag: string | null): string {
  const pick = tag ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
  return languageOption(pick)?.tag ?? 'en';
}

export function fromServerPrefs(p: ServerPrefsShape): Prefs {
  return {
    creationMode: p.creationMode === 'advanced' ? 'advanced' : 'simple',
    language: p.language || null,
    currency: oneOf(CURRENCY_OPTIONS, p.currency, DEFAULT_PREFS.currency),
    defaultAspectRatio: oneOf(ASPECT_RATIO_OPTIONS, p.defaultRatio, DEFAULT_PREFS.defaultAspectRatio),
    defaultModel: p.defaultModel || DEFAULT_PREFS.defaultModel,
    notifyWhenDone: p.notifications?.done ?? DEFAULT_PREFS.notifyWhenDone,
    notifyCreditsLow: p.notifications?.low ?? DEFAULT_PREFS.notifyCreditsLow,
    notifyPlanRenewal: p.notifications?.renewal ?? DEFAULT_PREFS.notifyPlanRenewal,
    notifyProductUpdates: p.notifications?.product ?? DEFAULT_PREFS.notifyProductUpdates,
    theme: oneOf(THEME_OPTIONS, p.theme, DEFAULT_PREFS.theme),
    confirmThreshold: typeof p.confirmThreshold === 'number' ? p.confirmThreshold : DEFAULT_PREFS.confirmThreshold,
    matureContent: p.matureContent === true,
  };
}

/** The `PATCH /api/me/prefs` body for a client patch (only the keys it changes). */
export function toServerPatch(patch: Partial<Prefs>): ServerPrefsPatchShape {
  const out: ServerPrefsPatchShape = {};
  const notifications: Partial<ServerPrefsShape['notifications']> = {};
  if (patch.creationMode !== undefined) out.creationMode = patch.creationMode;
  if ('language' in patch) out.language = serverLanguage(patch.language ?? null);
  if (patch.currency !== undefined) out.currency = patch.currency;
  if (patch.defaultAspectRatio !== undefined) out.defaultRatio = patch.defaultAspectRatio;
  if (patch.defaultModel !== undefined) out.defaultModel = patch.defaultModel;
  if (patch.confirmThreshold !== undefined) out.confirmThreshold = Math.max(0, Math.min(100_000, Math.round(patch.confirmThreshold)));
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.matureContent !== undefined) out.matureContent = patch.matureContent;
  if (patch.notifyWhenDone !== undefined) notifications.done = patch.notifyWhenDone;
  if (patch.notifyCreditsLow !== undefined) notifications.low = patch.notifyCreditsLow;
  if (patch.notifyPlanRenewal !== undefined) notifications.renewal = patch.notifyPlanRenewal;
  if (patch.notifyProductUpdates !== undefined) notifications.product = patch.notifyProductUpdates;
  if (Object.keys(notifications).length) out.notifications = notifications;
  return out;
}

/**
 * Applies the server's prefs (sign-in, `GET /api/me`, `prefs.changed`) to the
 * local cache, changing only what differs. Keys with a save in flight keep the
 * local (newer) value; the save's answer settles them.
 */
export function applyServerPrefs(p: ServerPrefsShape) {
  const next = fromServerPrefs(p);
  const cur = getPrefs();
  const diff: Partial<Prefs> = {};
  for (const k of Object.keys(next) as (keyof Prefs)[]) {
    if (pending.has(k)) continue;
    // "Follow the browser" stays when the server holds the language the browser resolves to.
    if (k === 'language' && cur.language === null && next.language === serverLanguage(null)) continue;
    if (next[k] !== cur[k]) (diff as Record<string, unknown>)[k] = next[k];
  }
  if (Object.keys(diff).length) writeLocal(diff);
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
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  apply(getPrefs().theme);
  window.addEventListener(PREFS_EVENT, () => apply(getPrefs().theme));
  window.addEventListener('storage', () => apply(getPrefs().theme));
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => apply(getPrefs().theme));
}
