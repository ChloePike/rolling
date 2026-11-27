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
  const before = `${root.dataset.theme ?? ''}|${root.style.colorScheme}`;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  root.style.colorScheme = resolvedTheme(pref);
  if (root.style.colorScheme && before !== '|' && before !== `${root.dataset.theme ?? ''}|${root.style.colorScheme}`) holdTransitions();
  watchSystemScheme();
}

/**
 * A theme switch changes colors in one frame. Elements with a color transition
 * (hover states, nav items) would fade for 140ms while everything else snaps,
 * a visible flicker; `data-theme-switching` turns transitions off (base.css)
 * until the new colors are painted.
 */
function holdTransitions() {
  const root = document.documentElement;
  root.dataset.themeSwitching = '';
  const release = () => delete root.dataset.themeSwitching;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(release));
  else setTimeout(release, 32);
}

let watching = false;
/** System theme changes (the OS switching to light at sunrise) get the same treatment. */
function watchSystemScheme() {
  if (watching || typeof window === 'undefined' || !window.matchMedia) return;
  watching = true;
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (!document.documentElement.dataset.theme) holdTransitions();
  });
}
