import { useSyncExternalStore } from 'react';
import { LOCALE_PREF_KEY } from '@/i18n/locale';

/**
 * Client preferences shared by the header settings popover and Settings →
 * Preferences (handoff 4: Simple vs Advanced is a setting, not a per-page
 * toggle). Stored in localStorage until `PATCH /api/me/prefs` lands; the
 * server copy wins once it exists.
 *
 * Writers dispatch `rolling:creation-mode` (or `rolling:prefs`) so readers in
 * this tab update at once; the `storage` event covers other tabs.
 */

export type CreationMode = 'simple' | 'advanced';

export const CREATION_MODE_KEY = 'rolling.creationMode';
/** The i18n provider resolves the UI locale from this key. */
export const LANGUAGE_KEY = LOCALE_PREF_KEY;
export const CREATION_MODE_EVENT = 'rolling:creation-mode';
export const PREFS_EVENT = 'rolling:prefs';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage unavailable; readers fall back to defaults. */
  }
}

export function getCreationMode(): CreationMode {
  return read(CREATION_MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
}

export function setCreationMode(mode: CreationMode) {
  write(CREATION_MODE_KEY, mode);
  window.dispatchEvent(new CustomEvent(CREATION_MODE_EVENT, { detail: mode }));
}

/** Saved language preference (a BCP 47 tag), or null to follow the browser. */
export function getLanguage(): string | null {
  return read(LANGUAGE_KEY);
}

export function setLanguage(tag: string) {
  write(LANGUAGE_KEY, tag);
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { language: tag } }));
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

export function useCreationMode(): CreationMode {
  return useSyncExternalStore(subscribe, getCreationMode, () => 'simple');
}

export function useLanguagePref(): string | null {
  return useSyncExternalStore(subscribe, getLanguage, () => null);
}
