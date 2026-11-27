import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * The nav shows icons only, with tooltips (handoff section 1 says below 1280px). Raised to 1360px: with labels
 * the header no longer fits one row at 1280 and wrapped (UX audit); keep in sync with Header.module.css.
 */
export const NARROW_NAV_QUERY = '(max-width: 1359.98px)';
