import type { ThemePref } from './index';

/** The theme the page shows for a preference: System follows `prefers-color-scheme` (D-010). */
export function resolvedTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Applies the theme preference (D-010): `data-theme="light"|"dark"` on the
 * root element for a forced theme, removed for System so the tokens follow
 * `prefers-color-scheme`.
 */
export function applyTheme(pref: ThemePref) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  root.style.colorScheme = resolvedTheme(pref);
}
