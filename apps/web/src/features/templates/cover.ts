import type { CSSProperties } from 'react';

/**
 * Background of a template cover: the template's preview picture when it has
 * one (built-ins, public media URL, D-008), over the tone the design shows
 * while it loads or when there is none.
 */
export function coverStyle(coverUrl: string | null | undefined, tone: string, extra: CSSProperties = {}): CSSProperties {
  return coverUrl
    ? { backgroundColor: tone, backgroundImage: `url("${coverUrl.replace(/"/g, '%22')}")`, backgroundSize: 'cover', backgroundPosition: 'center', ...extra }
    : { background: tone, ...extra };
}
